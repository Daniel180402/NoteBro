/**
 * Splits a growing PCM channel into pieces for live transcription. Cuts land
 * in a pause whenever there is one, so whisper never gets half a word; a long
 * monologue is still cut at a hard limit so the text keeps flowing.
 * Dependency-free so the test runner can bundle it.
 */
import { SAMPLE_RATE } from '@shared/types'

const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000
/** Same 100 ms buckets as the WAV writer's energy profile. */
const BUCKET_SAMPLES = SAMPLE_RATE / 10

export interface ChunkerOptions {
  /** Never send less than this, except when flushing at the end. */
  minMs: number
  /** Cut here even without a pause. */
  maxMs: number
  /** A pause must last this long to be a cut point. */
  pauseMs: number
  /** RMS below which a bucket counts as silence. */
  silenceRms: number
}

export const DEFAULT_CHUNKER: ChunkerOptions = {
  minMs: 4000,
  maxMs: 10000,
  pauseMs: 300,
  silenceRms: 0.01
}

export interface PcmChunk {
  pcm: Buffer
  /** Position of the first sample on the channel timeline, in ms. */
  startMs: number
  /** One RMS value per 100 ms, as WavWriter computes it. */
  energyProfile: number[]
  peak: number
}

export class ChannelChunker {
  private parts: Buffer[] = []
  private bytes = 0
  private startMs: number

  constructor(
    startMs: number,
    private readonly options: ChunkerOptions = DEFAULT_CHUNKER
  ) {
    this.startMs = startMs
  }

  get bufferedMs(): number {
    return this.bytes / BYTES_PER_MS
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.parts.push(chunk)
    this.bytes += chunk.length
  }

  /**
   * The next piece ready for transcription, or null when it is better to wait.
   * `flush` hands over everything left, for the end of the recording.
   */
  take(flush = false): PcmChunk | null {
    const buffered = this.bufferedMs
    if (flush) {
      return buffered >= 500 ? this.cut(this.bytes - (this.bytes % 2)) : this.drop()
    }
    if (buffered < this.options.minMs) return null

    const all = this.joined()
    const pause = this.lastPause(all)
    if (pause !== null) return this.cut(pause)
    if (buffered >= this.options.maxMs) return this.cut(Math.round(this.options.maxMs * BYTES_PER_MS))
    return null
  }

  private joined(): Buffer {
    if (this.parts.length !== 1) this.parts = [Buffer.concat(this.parts)]
    return this.parts[0]
  }

  /** Byte offset in the middle of the latest long-enough pause after minMs. */
  private lastPause(all: Buffer): number | null {
    const samples = Math.floor(all.length / 2)
    const buckets = Math.floor(samples / BUCKET_SAMPLES)
    const minBucket = Math.ceil(this.options.minMs / 100)
    const needed = Math.max(1, Math.round(this.options.pauseMs / 100))

    let run = 0
    let best: number | null = null
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      if (rms(all, bucket * BUCKET_SAMPLES, BUCKET_SAMPLES) < this.options.silenceRms) {
        run += 1
        const middle = bucket - Math.floor(run / 2)
        if (run >= needed && middle >= minBucket) best = middle
      } else {
        run = 0
      }
    }
    return best === null ? null : best * BUCKET_SAMPLES * 2
  }

  private cut(byteOffset: number): PcmChunk {
    const all = this.joined()
    const even = byteOffset - (byteOffset % 2)
    const pcm = Buffer.from(all.subarray(0, even))
    const rest = all.subarray(even)
    this.parts = rest.length > 0 ? [Buffer.from(rest)] : []
    this.bytes = rest.length

    const chunk: PcmChunk = {
      pcm,
      startMs: this.startMs,
      energyProfile: energyProfile(pcm),
      peak: peakOf(pcm)
    }
    this.startMs += even / BYTES_PER_MS
    return chunk
  }

  private drop(): null {
    this.startMs += this.bufferedMs
    this.parts = []
    this.bytes = 0
    return null
  }
}

function rms(pcm: Buffer, fromSample: number, count: number): number {
  let sum = 0
  for (let i = 0; i < count; i += 1) {
    const sample = pcm.readInt16LE((fromSample + i) * 2) / 32768
    sum += sample * sample
  }
  return Math.sqrt(sum / count)
}

export function energyProfile(pcm: Buffer): number[] {
  const samples = Math.floor(pcm.length / 2)
  const profile: number[] = []
  for (let from = 0; from < samples; from += BUCKET_SAMPLES) {
    profile.push(rms(pcm, from, Math.min(BUCKET_SAMPLES, samples - from)))
  }
  return profile
}

export function peakOf(pcm: Buffer): number {
  let peak = 0
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const magnitude = Math.abs(pcm.readInt16LE(offset)) / 32768
    if (magnitude > peak) peak = magnitude
  }
  return peak
}

/** A 16 kHz mono 16-bit WAV file around raw PCM, as whisper-server expects. */
export function wavFile(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

interface VerboseSegment {
  start?: unknown
  end?: unknown
  text?: unknown
  no_speech_prob?: unknown
}

/**
 * Converts whisper-server's verbose_json (seconds) into the whisper-cli JSON
 * shape (milliseconds), so the same energy-based cleanup applies to both.
 */
export function serverToWhisperJson(
  raw: unknown,
  durationMs: number
): {
  transcription: Array<{ offsets: { from: number; to: number }; text: string }>
} {
  const segments = (raw as { segments?: unknown })?.segments
  if (!Array.isArray(segments)) {
    const text = (raw as { text?: unknown })?.text
    return {
      transcription:
        typeof text === 'string' && text.trim()
          ? [{ offsets: { from: 0, to: Math.round(durationMs) }, text }]
          : []
    }
  }
  return {
    transcription: (segments as VerboseSegment[])
      // Whisper's own verdict that the piece is not speech: the usual source of
      // "Grazie per la visione." over a silent channel.
      .filter((segment) => !(typeof segment.no_speech_prob === 'number' && segment.no_speech_prob > 0.6))
      .map((segment) => ({
        offsets: {
          from: Math.round(Number(segment.start ?? 0) * 1000),
          to: Math.round(Number(segment.end ?? 0) * 1000)
        },
        text: typeof segment.text === 'string' ? segment.text : ''
      }))
  }
}
