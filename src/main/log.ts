import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { root } from './paths'

const MAX_BYTES = 512 * 1024

export function logPath(): string {
  const dir = join(root(), 'logs')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'notebro.log')
}

/**
 * Appends a diagnostic line to the app's log file.
 *
 * Audio capture fails for reasons that live outside the app — a missing macOS
 * permission, a whisper binary that moved — so the failing details have to
 * survive the session and be readable afterwards.
 */
export function logLine(scope: string, message: string): void {
  try {
    const path = logPath()
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`)
    } catch {
      // No log yet, or rotation failed; either way keep writing.
    }
    appendFileSync(path, `${new Date().toISOString()} [${scope}] ${message}\n`, 'utf8')
  } catch {
    // Logging must never break a recording.
  }
}
