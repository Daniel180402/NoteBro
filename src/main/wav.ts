import { open, type FileHandle } from 'node:fs/promises'
import { SAMPLE_RATE } from '@shared/types'

const HEADER_BYTES = 44
/** Energy is summarised in 100 ms buckets, which is enough for silence pruning. */
const RMS_WINDOW = SAMPLE_RATE / 10

function riffHeader(dataBytes: number, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16
  const blockAlign = (channels * bitsPerSample) / 8
  const header = Buffer.alloc(HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28) // byte rate
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

/**
 * Appends 16-bit mono PCM to a WAV file, patching the header on close.
 *
 * While writing it also keeps a coarse energy profile (one RMS value per
 * 100 ms) which later lets us drop whisper segments that sit in pure silence —
 * the usual source of hallucinated text on an idle channel.
 */
export class WavWriter {
  readonly path: string
  private handle: FileHandle | null = null
  private dataBytes = 0
  private peakValue = 0
  private readonly rms: number[] = []
  private windowSum = 0
  private windowCount = 0
  /** Serialises writes: each one needs the byte count left by the previous. */
  private tail: Promise<void> = Promise.resolve()
  /** A chunk can end mid-sample; the stray byte belongs to the next chunk. */
  private carry: Buffer | null = null

  constructor(path: string, private readonly sampleRate = SAMPLE_RATE) {
    this.path = path
  }

  async open(): Promise<void> {
    this.handle = await open(this.path, 'w')
    await this.handle.write(riffHeader(0, this.sampleRate, 1), 0, HEADER_BYTES, 0)
  }

  write(pcm: Buffer): Promise<void> {
    this.tail = this.tail.then(() => this.writeNow(pcm))
    return this.tail
  }

  private async writeNow(chunk: Buffer): Promise<void> {
    if (!this.handle) return
    let pcm = chunk
    if (this.carry) {
      pcm = Buffer.concat([this.carry, pcm])
      this.carry = null
    }
    const usable = pcm.length - (pcm.length % 2)
    if (usable < pcm.length) this.carry = Buffer.from(pcm.subarray(usable))
    if (usable === 0) return
    await this.handle.write(pcm, 0, usable, HEADER_BYTES + this.dataBytes)
    this.dataBytes += usable
    this.accumulate(pcm, usable)
  }

  private accumulate(pcm: Buffer, usable: number): void {
    for (let offset = 0; offset < usable; offset += 2) {
      const sample = pcm.readInt16LE(offset) / 32768
      const magnitude = Math.abs(sample)
      if (magnitude > this.peakValue) this.peakValue = magnitude
      this.windowSum += sample * sample
      this.windowCount += 1
      if (this.windowCount === RMS_WINDOW) {
        this.rms.push(Math.sqrt(this.windowSum / RMS_WINDOW))
        this.windowSum = 0
        this.windowCount = 0
      }
    }
  }

  /** Writes `ms` of silence, used to align channels that started late. */
  async writeSilence(ms: number): Promise<void> {
    if (ms <= 0) return
    const samples = Math.round((ms / 1000) * this.sampleRate)
    await this.write(Buffer.alloc(samples * 2))
  }

  async close(): Promise<void> {
    await this.tail
    if (!this.handle) return
    if (this.windowCount > 0) this.rms.push(Math.sqrt(this.windowSum / this.windowCount))
    const sizes = Buffer.alloc(4)
    sizes.writeUInt32LE(36 + this.dataBytes, 0)
    await this.handle.write(sizes, 0, 4, 4)
    sizes.writeUInt32LE(this.dataBytes, 0)
    await this.handle.write(sizes, 0, 4, 40)
    await this.handle.close()
    this.handle = null
  }

  get bytes(): number {
    return this.dataBytes
  }

  get durationMs(): number {
    return (this.dataBytes / 2 / this.sampleRate) * 1000
  }

  get peak(): number {
    return this.peakValue
  }

  /** One RMS value per 100 ms of audio. */
  get energyProfile(): number[] {
    return this.rms
  }
}

export interface VoicedWindow {
  /** Milliseconds of the first voiced bucket of the utterance. */
  from: number
  /** Milliseconds just past its last voiced bucket. */
  to: number
  /** How many 100 ms buckets it spans. */
  buckets: number
}

/**
 * Pauses shorter than this stay inside one utterance. Measured speech pauses
 * between sentences run 300-900 ms, while the gap left by the other person's
 * whole turn is several seconds, so 1.5 s separates the two with margin.
 */
const BRIDGE_BUCKETS = 15

/**
 * Finds the dominant stretch of speech inside [fromMs, toMs).
 *
 * whisper.cpp reports segment boundaries, not speech onsets: on a channel that
 * stayed quiet while the other person talked, a segment routinely starts where
 * the previous one ended rather than where the voice begins, and can also trail
 * the tail of the preceding utterance. Interleaving two channels on those raw
 * offsets puts the turns in the wrong order and lets neighbouring turns merge,
 * so we snap each segment onto the longest run of energy it contains — its
 * actual utterance — using the profile recorded alongside the audio.
 *
 * Returns null when nothing in the range rises above `threshold`.
 */
export function voicedWindow(
  profile: number[],
  fromMs: number,
  toMs: number,
  threshold: number
): VoicedWindow | null {
  const first = Math.max(0, Math.floor(fromMs / 100))
  const last = Math.min(profile.length, Math.ceil(toMs / 100))

  let best: { start: number; end: number } | null = null
  let runStart = -1
  let runEnd = -1

  const keepLongest = (): void => {
    if (runStart < 0) return
    if (!best || runEnd - runStart > best.end - best.start) {
      best = { start: runStart, end: runEnd }
    }
  }

  for (let i = first; i < last; i += 1) {
    if (profile[i] > threshold) {
      if (runStart < 0) runStart = i
      runEnd = i
    } else if (runStart >= 0 && i - runEnd > BRIDGE_BUCKETS) {
      keepLongest()
      runStart = -1
      runEnd = -1
    }
  }
  keepLongest()

  if (!best) return null
  const { start, end } = best as { start: number; end: number }
  return { from: start * 100, to: (end + 1) * 100, buckets: end - start + 1 }
}
