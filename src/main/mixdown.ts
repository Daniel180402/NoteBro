import { open } from 'node:fs/promises'
import { SAMPLE_RATE } from '@shared/types'
import { WavWriter } from './wav'

const HEADER_BYTES = 44
/** Read in even-sized blocks so a sample is never split across reads. */
const BLOCK_BYTES = 64 * 1024

interface Source {
  handle: Awaited<ReturnType<typeof open>>
  dataBytes: number
}

async function openSource(path: string): Promise<Source | null> {
  try {
    const handle = await open(path, 'r')
    const header = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0)
    if (bytesRead < HEADER_BYTES || header.toString('ascii', 0, 4) !== 'RIFF') {
      await handle.close()
      return null
    }
    const dataBytes = header.readUInt32LE(40)
    if (dataBytes <= 0) {
      await handle.close()
      return null
    }
    return { handle, dataBytes }
  } catch {
    return null
  }
}

/**
 * Sums the per-speaker recordings into one file for playback.
 *
 * The channels are already aligned on a shared t = 0, so adding them restores
 * the conversation as it was heard. Samples are summed rather than averaged —
 * the speakers mostly take turns, so averaging would just halve the volume —
 * and clamped, which only bites where both talk at once.
 *
 * Returns false when there was nothing to mix.
 */
export async function mixToMono(paths: string[], destination: string): Promise<boolean> {
  const sources: Source[] = []
  for (const path of paths) {
    const source = await openSource(path)
    if (source) sources.push(source)
  }
  if (sources.length === 0) return false

  const total = Math.max(...sources.map((source) => source.dataBytes))
  const writer = new WavWriter(destination, SAMPLE_RATE)
  await writer.open()

  const mixed = Buffer.alloc(BLOCK_BYTES)
  const scratch = Buffer.alloc(BLOCK_BYTES)

  try {
    for (let offset = 0; offset < total; offset += BLOCK_BYTES) {
      const length = Math.min(BLOCK_BYTES, total - offset)
      mixed.fill(0, 0, length)

      for (const source of sources) {
        const available = Math.max(0, Math.min(length, source.dataBytes - offset))
        if (available === 0) continue
        const { bytesRead } = await source.handle.read(
          scratch,
          0,
          available,
          HEADER_BYTES + offset
        )
        for (let i = 0; i + 1 < bytesRead; i += 2) {
          const sum = mixed.readInt16LE(i) + scratch.readInt16LE(i)
          mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i)
        }
      }

      await writer.write(Buffer.from(mixed.subarray(0, length)))
    }
  } finally {
    for (const source of sources) await source.handle.close().catch(() => undefined)
  }

  await writer.close()
  return writer.bytes > 0
}
