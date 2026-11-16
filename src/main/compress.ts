import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { Encoder } from '@evan/opus'
import { ArrayBufferTarget, Muxer } from 'webm-muxer'
import { SAMPLE_RATE } from '@shared/types'

const WAV_HEADER_BYTES = 44
/** 20 ms frames, the usual trade-off between Opus overhead and latency. */
const FRAME_SAMPLES = SAMPLE_RATE / 50
/** Speech at 24 kbps mono is transparent enough to listen back to. */
const BITRATE = 24_000
/** Yield to the event loop every ~10 s of audio so the window stays alive. */
const FRAMES_PER_SLICE = 500

export interface CompressionResult {
  beforeBytes: number
  afterBytes: number
}

/**
 * Re-encodes a recording from WAV to Opus in a WebM container.
 *
 * The 16 kHz PCM that whisper needs costs about 1.8 MB per minute, which at a
 * couple of hours of calls a week runs to gigabytes a year. Opus holds the same
 * speech in roughly a ninth of the space, and Chromium plays WebM/Opus natively
 * so the player needs no change.
 */
export async function wavToWebm(wavPath: string, webmPath: string): Promise<CompressionResult> {
  const wav = await readFile(wavPath)
  const pcm = wav.subarray(WAV_HEADER_BYTES)
  const frames = Math.floor(pcm.length / 2 / FRAME_SAMPLES)
  if (frames === 0) throw new Error('Registrazione troppo breve per essere compressa.')

  const encoder = new Encoder({ channels: 1, sample_rate: SAMPLE_RATE, application: 'voip' })
  encoder.bitrate = BITRATE

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: { codec: 'A_OPUS', numberOfChannels: 1, sampleRate: SAMPLE_RATE }
  })

  for (let frame = 0; frame < frames; frame += 1) {
    const start = frame * FRAME_SAMPLES * 2
    const packet = encoder.encode(pcm.subarray(start, start + FRAME_SAMPLES * 2))
    muxer.addAudioChunkRaw(packet, 'key', Math.round((frame * FRAME_SAMPLES * 1e6) / SAMPLE_RATE))
    // Encoding is fast but not instant: a one-hour recording would otherwise
    // hold the main process for half a minute.
    if (frame % FRAMES_PER_SLICE === FRAMES_PER_SLICE - 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  muxer.finalize()
  const encoded = Buffer.from(muxer.target.buffer)

  // Write beside the original and swap, so a failure never leaves the note
  // without any audio at all.
  const temp = `${webmPath}.part`
  await writeFile(temp, encoded)
  await rename(temp, webmPath)
  const beforeBytes = (await stat(wavPath)).size
  await unlink(wavPath).catch(() => undefined)

  return { beforeBytes, afterBytes: encoded.length }
}
