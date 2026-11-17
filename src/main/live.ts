import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus } from 'node:os'
import type { LiveStatus, Segment, SpeakerId } from '@shared/types'
import { ChannelChunker, serverToWhisperJson, wavFile, type PcmChunk } from './chunker'
import { logLine } from './log'
import { parseWhisperSegments } from './transcript'
import { modelPath, resolveServerBinary } from './whisper'

export interface LiveOptions {
  model: string
  language: string
  threads: number
  /** Names and jargon, the same hints the final transcription gets. */
  prompt: string
  onSegments: (segments: Segment[]) => void
  onStatus: (status: LiveStatus) => void
}

/** How often the channels are checked for a piece ready to send. */
const TICK_MS = 1000
/** Pieces waiting beyond this mean the machine cannot keep up with the call. */
const LAG_QUEUE = 3
/** Below this peak a piece is silence, and whisper would only invent text. */
const SILENT_PEAK = 0.01
const BOOT_TIMEOUT_MS = 60_000

interface QueuedChunk extends PcmChunk {
  speaker: SpeakerId
}

/**
 * Transcribes a recording while it happens. One whisper-server keeps the model
 * loaded for the whole call; each channel is cut on pauses and the pieces are
 * sent one at a time, since the server handles a single request anyway.
 */
export class LiveTranscriber {
  private readonly chunkers = new Map<SpeakerId, ChannelChunker>()
  private readonly queue: QueuedChunk[] = []
  private readonly collected: Segment[] = []
  private server: ChildProcess | null = null
  private baseUrl = ''
  private ready = false
  private failed = false
  private closed = false
  private aborted = false
  private working = false
  private ticker: ReturnType<typeof setInterval> | null = null
  private idleWaiters: Array<() => void> = []
  private status: LiveStatus = { state: 'starting', message: 'Avvio della trascrizione in diretta…' }

  constructor(private readonly options: LiveOptions) {
    options.onStatus(this.status)
    void this.boot()
    this.ticker = setInterval(() => this.tick(false), TICK_MS)
  }

  /** True while the transcript can still be trusted to be complete. */
  get healthy(): boolean {
    return !this.failed
  }

  /** Called once per channel, with where its first sample sits on the timeline. */
  begin(speaker: SpeakerId, offsetMs: number): void {
    if (!this.chunkers.has(speaker)) this.chunkers.set(speaker, new ChannelChunker(offsetMs))
  }

  feed(speaker: SpeakerId, chunk: Buffer): void {
    if (this.closed || this.failed) return
    this.chunkers.get(speaker)?.push(chunk)
  }

  /**
   * Sends what is left, waits for the queue to drain and stops the server.
   * Resolves with the whole transcript, or null if it has gaps.
   */
  async finish(): Promise<Segment[] | null> {
    this.closed = true
    this.stopTicker()
    if (this.failed) {
      this.shutdown()
      return null
    }
    this.tick(true)
    await this.idle()
    this.shutdown()
    return this.failed ? null : [...this.collected].sort((a, b) => a.from - b.from)
  }

  abort(): void {
    this.aborted = true
    this.closed = true
    this.stopTicker()
    this.queue.length = 0
    this.shutdown()
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  private async boot(): Promise<void> {
    try {
      const binary = await resolveServerBinary()
      if (!binary) {
        throw new Error(
          'whisper-server non trovato: deve stare accanto a whisper-cli o nel PATH. La registrazione continua, la trascrizione avverrà a fine call.'
        )
      }
      const model = modelPath(this.options.model)
      if (!existsSync(model)) throw new Error(`Modello "${this.options.model}" non scaricato.`)

      const port = await freePort()
      this.baseUrl = `http://127.0.0.1:${port}`
      const args = [
        '-m', model,
        '-l', this.options.language,
        '-t', String(this.options.threads),
        '--host', '127.0.0.1',
        '--port', String(port)
      ]
      if (this.options.prompt) args.push('--prompt', this.options.prompt)

      // Cancelled while the binary was being looked up: never leave a server behind.
      if (this.aborted) return
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      this.server = child
      logLine('live', `whisper-server avviato (pid ${child.pid}) su ${this.baseUrl} con ${this.options.model}`)
      let stderrTail = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2000)
      })
      child.stdout?.resume()
      child.on('exit', (code) => {
        logLine('live', `whisper-server terminato con codice ${code ?? 'sconosciuto'}`)
        this.server = null
        if (!this.closed) {
          this.fail(`whisper-server si è interrotto (codice ${code ?? '?'}). ${lastLine(stderrTail)}`.trim())
        }
      })

      await this.waitUntilUp()
      if (this.closed && !this.queue.length && this.chunkersEmpty()) return
      this.ready = true
      this.setStatus({ state: 'ready', message: 'Trascrizione in diretta attiva.' })
      void this.drain()
    } catch (error) {
      this.fail((error as Error).message)
    }
  }

  private async waitUntilUp(): Promise<void> {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.failed || !this.server) throw new Error('whisper-server non si è avviato.')
      try {
        const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) return
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error('whisper-server non ha risposto entro un minuto.')
  }

  private tick(flush: boolean): void {
    if (this.failed) return
    for (const [speaker, chunker] of this.chunkers) {
      for (let piece = chunker.take(flush); piece; piece = chunker.take(flush)) {
        this.queue.push({ ...piece, speaker })
        if (!flush) break
      }
    }
    if (this.ready && !this.closed) {
      if (this.queue.length > LAG_QUEUE && this.status.state !== 'lagging') {
        this.setStatus({
          state: 'lagging',
          message: 'La trascrizione in diretta è in ritardo: il computer non sta al passo con la call.'
        })
      } else if (this.queue.length <= 1 && this.status.state === 'lagging') {
        this.setStatus({ state: 'ready', message: 'Trascrizione in diretta attiva.' })
      }
    }
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.working || !this.ready) return
    this.working = true
    try {
      while (this.queue.length > 0 && !this.failed) {
        const piece = this.queue.shift() as QueuedChunk
        if (piece.peak < SILENT_PEAK) continue
        const segments = await this.transcribe(piece)
        if (segments.length > 0) {
          this.collected.push(...segments)
          this.options.onSegments(segments)
        }
      }
    } catch (error) {
      this.fail(`Trascrizione in diretta interrotta: ${(error as Error).message}`)
    } finally {
      this.working = false
      if (this.queue.length === 0 || this.failed) {
        for (const resolve of this.idleWaiters.splice(0)) resolve()
      }
    }
  }

  private async transcribe(piece: QueuedChunk): Promise<Segment[]> {
    const form = new FormData()
    form.append('file', new Blob([wavFile(piece.pcm)], { type: 'audio/wav' }), 'chunk.wav')
    form.append('response_format', 'verbose_json')
    form.append('temperature', '0.0')
    const response = await fetch(`${this.baseUrl}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000)
    })
    if (!response.ok) throw new Error(`whisper-server ha risposto ${response.status}`)
    const durationMs = piece.pcm.length / 32
    const json = serverToWhisperJson(await response.json(), durationMs)
    return parseWhisperSegments(json, piece.speaker, piece.energyProfile, piece.peak).map(
      (segment) => ({
        ...segment,
        from: Math.round(segment.from + piece.startMs),
        to: Math.round(segment.to + piece.startMs)
      })
    )
  }

  private idle(): Promise<void> {
    if (this.failed || (!this.working && this.queue.length === 0)) return Promise.resolve()
    // Pieces queued before the server came up are sent as soon as it does.
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private fail(message: string): void {
    if (this.failed || this.aborted) return
    this.failed = true
    logLine('live', `errore: ${message}`)
    this.setStatus({ state: 'error', message })
    this.queue.length = 0
    this.stopTicker()
    this.shutdown()
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  private setStatus(status: LiveStatus): void {
    this.status = status
    this.options.onStatus(status)
  }

  private chunkersEmpty(): boolean {
    return [...this.chunkers.values()].every((chunker) => chunker.bufferedMs === 0)
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  private shutdown(): void {
    this.server?.kill('SIGTERM')
    this.server = null
  }
}

export function defaultThreads(configured: number): number {
  return configured > 0 ? configured : Math.max(2, Math.min(8, cpus().length - 1))
}

function lastLine(text: string): string {
  return text.trim().split('\n').pop() ?? ''
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('nessuna porta libera'))
      )
    })
  })
}
