import { spawn } from 'node:child_process'
import { cpus } from 'node:os'
import { createWriteStream, existsSync } from 'node:fs'
import { readFile, rename, stat, unlink } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DownloadProgress, Segment, SpeakerId, WhisperStatus } from '@shared/types'
import { binDir, modelsDir, sessionDir } from './paths'
import { getSettings } from './store'
import { parseWhisperSegments, type WhisperJson } from './transcript'

interface ModelDefinition {
  name: string
  label: string
  sizeBytes: number
  note: string
}

/** Sizes are the real content-length of the GGML files on Hugging Face. */
const MODELS: ModelDefinition[] = [
  { name: 'tiny', label: 'Tiny', sizeBytes: 77_691_713, note: 'Il più rapido, qualità bassa.' },
  { name: 'base', label: 'Base', sizeBytes: 147_951_465, note: 'Veloce, per appunti informali.' },
  {
    name: 'small',
    label: 'Small',
    sizeBytes: 487_601_967,
    note: 'Buon compromesso, consigliato per italiano.'
  },
  {
    name: 'medium',
    label: 'Medium',
    sizeBytes: 1_533_763_059,
    note: 'Più accurato, circa 2× più lento.'
  },
  {
    name: 'large-v3-turbo',
    label: 'Large v3 Turbo',
    sizeBytes: 1_624_555_275,
    note: 'Qualità massima, veloce su Apple Silicon.'
  }
]

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export function modelPath(name: string): string {
  return join(modelsDir(), `ggml-${name}.bin`)
}

/** Executable names whisper.cpp has shipped under, newest first. */
const BINARY_NAMES =
  process.platform === 'win32'
    ? ['whisper-cli.exe', 'whisper-cpp.exe', 'main.exe']
    : ['whisper-cli', 'whisper-cpp', 'main']

function searchPathFor(names: string[]): string | null {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...extra].filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

export async function resolveBinary(): Promise<{
  path: string | null
  source: WhisperStatus['source']
}> {
  const settings = await getSettings()
  if (settings.whisperBinaryPath && existsSync(settings.whisperBinaryPath)) {
    return { path: settings.whisperBinaryPath, source: 'settings' }
  }
  for (const name of BINARY_NAMES) {
    const bundled = join(binDir(), name)
    if (existsSync(bundled)) return { path: bundled, source: 'bundled' }
  }
  const onPath = searchPathFor(BINARY_NAMES)
  if (onPath) return { path: onPath, source: 'path' }
  return { path: null, source: 'none' }
}

/** Names whisper.cpp's HTTP server has shipped under, newest first. */
const SERVER_NAMES =
  process.platform === 'win32'
    ? ['whisper-server.exe', 'server.exe']
    : ['whisper-server', 'whisper-cpp-server']

/**
 * The server binary for live transcription. It ships in the same build as
 * whisper-cli, so the folder of the resolved CLI is the first place to look.
 */
export async function resolveServerBinary(): Promise<string | null> {
  const { path } = await resolveBinary()
  if (path) {
    for (const name of SERVER_NAMES) {
      const sibling = join(dirname(path), name)
      if (existsSync(sibling)) return sibling
    }
  }
  return searchPathFor(SERVER_NAMES)
}

export async function status(): Promise<WhisperStatus> {
  const { path, source } = await resolveBinary()
  return {
    available: path !== null,
    binaryPath: path,
    serverBinaryPath: await resolveServerBinary(),
    source,
    models: MODELS.map((model) => ({
      name: model.name,
      label: model.label,
      sizeBytes: model.sizeBytes,
      note: model.note,
      installed: existsSync(modelPath(model.name))
    }))
  }
}

const activeDownloads = new Map<string, AbortController>()

export async function downloadModel(
  name: string,
  onProgress: (progress: DownloadProgress) => void
): Promise<void> {
  if (!MODELS.some((model) => model.name === name)) throw new Error(`Modello sconosciuto: ${name}`)
  if (activeDownloads.has(name)) throw new Error('Download già in corso.')

  const target = modelPath(name)
  const partial = `${target}.part`
  const controller = new AbortController()
  activeDownloads.set(name, controller)

  try {
    const response = await fetch(`${MODEL_BASE_URL}/ggml-${name}.bin`, {
      signal: controller.signal
    })
    if (!response.ok || !response.body) {
      throw new Error(`Download fallito (HTTP ${response.status}).`)
    }

    const totalBytes = Number(response.headers.get('content-length') ?? 0)
    let receivedBytes = 0
    let lastReport = 0

    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length
      const now = Date.now()
      if (now - lastReport > 200) {
        lastReport = now
        onProgress({ name, receivedBytes, totalBytes, done: false })
      }
    })

    await pipeline(source, createWriteStream(partial))
    await rename(partial, target)
    onProgress({ name, receivedBytes, totalBytes, done: true })
  } catch (error) {
    await unlink(partial).catch(() => undefined)
    const message = controller.signal.aborted
      ? 'Download annullato.'
      : (error as Error).message
    onProgress({ name, receivedBytes: 0, totalBytes: 0, done: true, error: message })
    throw new Error(message)
  } finally {
    activeDownloads.delete(name)
  }
}

export function cancelDownload(name: string): void {
  activeDownloads.get(name)?.abort()
}

export async function deleteModel(name: string): Promise<void> {
  await unlink(modelPath(name)).catch(() => undefined)
}

export interface TranscribeOptions {
  sessionId: string
  speaker: SpeakerId
  wavPath: string
  language: string
  model: string
  /** Peak amplitude of the channel; a flat channel is skipped entirely. */
  peak: number
  energyProfile: number[]
  onProgress: (fraction: number) => void
  signal?: AbortSignal
}

export async function transcribe(options: TranscribeOptions): Promise<Segment[]> {
  const { path: binary } = await resolveBinary()
  if (!binary) throw new Error('Eseguibile whisper.cpp non trovato.')

  const model = modelPath(options.model)
  if (!existsSync(model)) throw new Error(`Modello "${options.model}" non scaricato.`)

  const info = await stat(options.wavPath).catch(() => null)
  // Under ~0.5 s of audio, or a channel that never rose above the noise floor,
  // whisper produces nothing but invented filler.
  if (!info || info.size < 16_000 || options.peak < 0.01) {
    options.onProgress(1)
    return []
  }

  const settings = await getSettings()
  const threads = settings.whisperThreads > 0
    ? settings.whisperThreads
    : Math.max(2, Math.min(8, cpus().length - 1))

  const outputBase = join(sessionDir(options.sessionId), `${options.speaker}-transcript`)

  const args = [
    '-m', model,
    '-f', options.wavPath,
    '-l', options.language,
    '-t', String(threads),
    '-oj',
    '-of', outputBase,
    '-np',
    '-pp',
    '-sns'
  ]

  // An initial prompt biases decoding, so proper names and jargon come out
  // spelled right instead of as the nearest common word.
  const hints = [settings.userName, settings.vocabulary]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(', ')
    .slice(0, 400)
  if (hints) args.push('--prompt', hints)

  await runWhisper(binary, args, options.onProgress, options.signal)

  const raw = await readFile(`${outputBase}.json`, 'utf8').catch(() => null)
  if (!raw) throw new Error('whisper.cpp non ha prodotto una trascrizione.')

  return parseWhisperSegments(
    JSON.parse(raw) as WhisperJson,
    options.speaker,
    options.energyProfile,
    options.peak
  )
}

function runWhisper(
  binary: string,
  args: string[],
  onProgress: (fraction: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderrTail = ''

    const onAbort = (): void => {
      child.kill('SIGTERM')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const scan = (text: string): void => {
      const matches = text.matchAll(/progress\s*=\s*(\d+)\s*%/g)
      for (const match of matches) onProgress(Math.min(1, Number(match[1]) / 100))
    }

    child.stdout.on('data', (chunk: Buffer) => scan(chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderrTail = `${stderrTail}${text}`.slice(-4000)
      scan(text)
    })

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(new Error(`Avvio di whisper.cpp fallito: ${error.message}`))
    })

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) {
        reject(new Error('Trascrizione annullata.'))
      } else if (code === 0) {
        onProgress(1)
        resolve()
      } else {
        reject(new Error(`whisper.cpp è terminato con codice ${code}. ${stderrTail.trim().slice(-500)}`))
      }
    })
  })
}

export { MODELS }
