import type { SpeakerId } from '@shared/types'
import { SAMPLE_RATE } from '@shared/types'

/**
 * Runs inside the audio rendering thread. It downmixes to mono, converts to
 * 16-bit PCM and posts fixed-size chunks, so the main thread only sees ~8 posts
 * per second instead of one per 128-sample render quantum.
 */
const WORKLET_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.size = (options.processorOptions && options.processorOptions.chunkSamples) || 2048
    this.buffer = new Int16Array(this.size)
    this.filled = 0
    this.peak = 0
    this.port.onmessage = (event) => {
      if (event.data === 'flush') this.flush()
    }
  }

  flush() {
    if (this.filled === 0) return
    const chunk = this.buffer.slice(0, this.filled)
    this.port.postMessage({ pcm: chunk.buffer, peak: this.peak }, [chunk.buffer])
    this.filled = 0
    this.peak = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0 || !input[0]) return true
    const frames = input[0].length
    const channels = input.length
    for (let i = 0; i < frames; i += 1) {
      let sample = 0
      for (let c = 0; c < channels; c += 1) sample += input[c][i]
      sample /= channels
      if (sample > 1) sample = 1
      else if (sample < -1) sample = -1
      const magnitude = sample < 0 ? -sample : sample
      if (magnitude > this.peak) this.peak = magnitude
      this.buffer[this.filled] = sample * 32767
      this.filled += 1
      if (this.filled === this.size) this.flush()
    }
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)
`

export interface CaptureOptions {
  captureMic: boolean
  /** True on Windows, where system audio arrives through getDisplayMedia. */
  captureSystemInRenderer: boolean
  micDeviceId: string
  echoCancellation: boolean
  noiseSuppression: boolean
  onLevel: (speaker: SpeakerId, level: number) => void
  onWarning: (message: string) => void
}

export interface CaptureHandle {
  stop: () => Promise<void>
  /** Channels the renderer actually managed to open. */
  active: SpeakerId[]
}

function workletUrl(): string {
  // A blob keeps the worklet independent of how the bundler emits assets.
  return URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
}

export async function startCapture(options: CaptureOptions): Promise<CaptureHandle> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
  const url = workletUrl()
  try {
    await context.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }

  // Keeps the graph pulling without ever reaching the speakers.
  const mute = context.createGain()
  mute.gain.value = 0
  mute.connect(context.destination)

  const streams: MediaStream[] = []
  const nodes: AudioWorkletNode[] = []
  const active: SpeakerId[] = []

  const attach = (stream: MediaStream, speaker: SpeakerId): void => {
    const source = context.createMediaStreamSource(stream)
    const tap = new AudioWorkletNode(context, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { chunkSamples: 2048 }
    })
    tap.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; peak: number }>) => {
      const { pcm, peak } = event.data
      window.notebro.recorder.pcm(speaker, new Uint8Array(pcm))
      options.onLevel(speaker, peak)
    }
    source.connect(tap)
    tap.connect(mute)
    streams.push(stream)
    nodes.push(tap)
    active.push(speaker)
  }

  if (options.captureMic) {
    try {
      const constraints: MediaTrackConstraints = {
        echoCancellation: options.echoCancellation,
        noiseSuppression: options.noiseSuppression,
        autoGainControl: true,
        channelCount: 1
      }
      if (options.micDeviceId && options.micDeviceId !== 'default') {
        constraints.deviceId = { exact: options.micDeviceId }
      }
      attach(await navigator.mediaDevices.getUserMedia({ audio: constraints }), 'me')
    } catch (error) {
      options.onWarning(`Microfono non disponibile: ${describe(error)}`)
    }
  }

  if (options.captureSystemInRenderer) {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      // Only the loopback audio is wanted; the screen frames are dropped at once.
      for (const track of display.getVideoTracks()) track.stop()
      if (display.getAudioTracks().length === 0) {
        throw new Error('la sorgente selezionata non fornisce audio di sistema')
      }
      attach(new MediaStream(display.getAudioTracks()), 'them')
    } catch (error) {
      options.onWarning(`Audio di sistema non disponibile: ${describe(error)}`)
    }
  }

  const stop = async (): Promise<void> => {
    for (const node of nodes) {
      node.port.postMessage('flush')
    }
    // Give the flushed chunks a moment to cross into the main process.
    await new Promise((resolve) => setTimeout(resolve, 150))
    for (const node of nodes) {
      node.port.onmessage = null
      node.disconnect()
    }
    for (const stream of streams) for (const track of stream.getTracks()) track.stop()
    await context.close().catch(() => undefined)
  }

  return { stop, active }
}

function describe(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'permesso negato'
    if (error.name === 'NotFoundError') return 'nessun dispositivo trovato'
    return error.message || error.name
  }
  return error instanceof Error ? error.message : String(error)
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((device) => device.kind === 'audioinput')
}
