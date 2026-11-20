import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { modelsDir, root } from './paths'

export interface StorageReport {
  /** Bytes held by saved recordings. */
  audioBytes: number
  /** Bytes held by downloaded models. */
  modelBytes: number
  /** Bytes held by recordings of sessions that were never filed. */
  sessionBytes: number
  /** Notes whose recording is still uncompressed. */
  pendingCompression: number
  /** Bytes those notes would give back, estimated at the measured ratio. */
  reclaimableBytes: number
}

/** Opus at 24 kbps measured about a ninth of the 16 kHz PCM it replaces. */
const COMPRESSION_RATIO = 9

function directorySize(path: string): number {
  if (!existsSync(path)) return 0
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += directorySize(child)
    else if (entry.isFile()) {
      try {
        total += statSync(child).size
      } catch {
        // Vanished between listing and measuring.
      }
    }
  }
  return total
}

export function report(noteDirs: string[]): StorageReport {
  let audioBytes = 0
  let pendingCompression = 0
  let reclaimableBytes = 0

  for (const dir of noteDirs) {
    for (const [name, compressed] of [
      ['audio.webm', true],
      ['audio.wav', false]
    ] as const) {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      const size = statSync(path).size
      audioBytes += size
      if (!compressed) {
        pendingCompression += 1
        reclaimableBytes += size - Math.round(size / COMPRESSION_RATIO)
      }
    }
  }

  return {
    audioBytes,
    modelBytes: directorySize(modelsDir()),
    sessionBytes: directorySize(join(root(), 'sessions')),
    pendingCompression,
    reclaimableBytes
  }
}

/** Deletes leftover recordings of sessions that were never filed. */
export function cleanSessions(keep: Iterable<string> = []): number {
  const kept = new Set(keep)
  const sessions = join(root(), 'sessions')
  if (!existsSync(sessions)) return 0
  let freed = 0
  for (const entry of readdirSync(sessions, { withFileTypes: true })) {
    if (!entry.isDirectory() || kept.has(entry.name)) continue
    const path = join(sessions, entry.name)
    freed += directorySize(path)
    rmSync(path, { recursive: true, force: true })
  }
  return freed
}
