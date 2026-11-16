import { existsSync, mkdirSync, statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { utilityProcess } from 'electron'
import { downloadFile } from './download'
import { logLine } from './log'
import { modelsDir } from './paths'
import type { DiarizeRequest, DiarizeResponse } from './workers/diarize'

interface ModelSpec {
  file: string
  url: string
  sizeBytes: number
}

/** Segmentation finds the turns; the embedding model tells the voices apart. */
const MODELS: Record<'segmentation' | 'embedding', ModelSpec> = {
  segmentation: {
    file: 'segmentation.onnx',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx',
    sizeBytes: 5_984_988
  },
  embedding: {
    file: 'embedding.onnx',
    // The larger ERes2NetV2: the lighter CAM++ merged voices of the same
    // register in testing, and this one kept them apart.
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx',
    sizeBytes: 71_425_536
  }
}

function directory(): string {
  const dir = join(modelsDir(), 'diarization')
  mkdirSync(dir, { recursive: true })
  return dir
}

function modelPath(kind: keyof typeof MODELS): string {
  return join(directory(), MODELS[kind].file)
}

export interface DiarizationStatus {
  /** The native library loaded on this platform. */
  supported: boolean
  modelsInstalled: boolean
  totalBytes: number
  installedBytes: number
}

let supportedCache: boolean | null = null

/** The native addon ships per platform; a missing build must not break the app. */
function isSupported(): boolean {
  if (supportedCache !== null) return supportedCache
  try {
    require.resolve('sherpa-onnx-node')
    supportedCache = true
  } catch {
    supportedCache = false
  }
  return supportedCache
}

export function status(): DiarizationStatus {
  const installed = (Object.keys(MODELS) as Array<keyof typeof MODELS>).filter((kind) =>
    existsSync(modelPath(kind))
  )
  return {
    supported: isSupported(),
    modelsInstalled: installed.length === Object.keys(MODELS).length,
    totalBytes: Object.values(MODELS).reduce((sum, model) => sum + model.sizeBytes, 0),
    installedBytes: installed.reduce((sum, kind) => {
      try {
        return sum + statSync(modelPath(kind)).size
      } catch {
        return sum
      }
    }, 0)
  }
}

export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number
  done: boolean
  error?: string
}

export async function downloadModels(
  onProgress: (progress: DownloadProgress) => void
): Promise<DiarizationStatus> {
  const entries = Object.entries(MODELS) as Array<[keyof typeof MODELS, ModelSpec]>
  const totalBytes = entries.reduce((sum, [, model]) => sum + model.sizeBytes, 0)
  let completedBytes = 0

  try {
    for (const [kind, model] of entries) {
      if (existsSync(modelPath(kind))) {
        completedBytes += model.sizeBytes
        continue
      }
      await downloadFile(model.url, modelPath(kind), (report) => {
        onProgress({
          receivedBytes: completedBytes + report.receivedBytes,
          totalBytes,
          done: false
        })
      })
      completedBytes += model.sizeBytes
    }
    onProgress({ receivedBytes: totalBytes, totalBytes, done: true })
  } catch (error) {
    const message = (error as Error).message
    logLine('diarization', `download modelli fallito: ${message}`)
    onProgress({ receivedBytes: 0, totalBytes, done: true, error: message })
    throw new Error(message)
  }

  return status()
}

export async function deleteModels(): Promise<DiarizationStatus> {
  for (const kind of Object.keys(MODELS) as Array<keyof typeof MODELS>) {
    await unlink(modelPath(kind)).catch(() => undefined)
  }
  return status()
}

export interface DiarizedSpan {
  start: number
  end: number
  voice: number
}

export interface DiarizeOptions {
  wavPath: string
  /**
   * Declared number of remote participants. Always pass the real figure:
   * letting the clustering decide produced 38 speakers on a one-to-one call.
   */
  numSpeakers: number
  signal?: AbortSignal
}

/**
 * Splits a recording by voice. Returns an empty list when diarization is not
 * possible, so callers can simply fall back to a single unnamed speaker.
 */
export async function diarize(options: DiarizeOptions): Promise<DiarizedSpan[]> {
  const state = status()
  if (!state.supported || !state.modelsInstalled) return []
  if (!existsSync(options.wavPath)) return []

  const request: DiarizeRequest = {
    wavPath: options.wavPath,
    segmentationModel: modelPath('segmentation'),
    embeddingModel: modelPath('embedding'),
    numSpeakers: options.numSpeakers > 0 ? options.numSpeakers : -1,
    threshold: 0.5,
    threads: Math.max(2, Math.min(8, cpus().length - 1))
  }

  const started = Date.now()
  const response = await runWorker(request, options.signal)
  if (!response.ok) {
    logLine('diarization', `fallita: ${response.error ?? 'errore sconosciuto'}`)
    return []
  }

  const spans = (response.segments ?? []).map((segment) => ({
    start: segment.start,
    end: segment.end,
    voice: segment.speaker
  }))
  const voices = new Set(spans.map((span) => span.voice)).size
  logLine(
    'diarization',
    `${spans.length} intervalli, ${voices} voci, in ${((Date.now() - started) / 1000).toFixed(1)}s`
  )
  return spans
}

/** Runs the blocking inference in a utilityProcess so the window stays alive. */
function runWorker(request: DiarizeRequest, signal?: AbortSignal): Promise<DiarizeResponse> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (response: DiarizeResponse): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      resolve(response)
    }

    const child = utilityProcess.fork(join(__dirname, 'diarize.js'), [], {
      serviceName: 'notebro-diarization'
    })

    function onAbort(): void {
      finish({ ok: false, error: 'Diarizzazione annullata.' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('message', (message: DiarizeResponse) => finish(message))
    child.on('exit', (code) => finish({ ok: false, error: `Processo terminato (${code}).` }))
    child.postMessage(request)
  })
}
