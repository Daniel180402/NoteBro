import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, desktopCapturer, shell, systemPreferences } from 'electron'
import type { SystemAudioCapability } from '@shared/types'
import { logLine } from './log'
import { binDir } from './paths'

const HELPER_NAME = 'notebro-sysaudio'

export function helperPath(): string | null {
  const candidate = join(binDir(), HELPER_NAME)
  return existsSync(candidate) ? candidate : null
}

/**
 * macOS screen-capture permission, as far as it can be known.
 *
 * Electron maps this service onto CGPreflightScreenCaptureAccess, which is a
 * plain yes/no: it reports "denied" both for a real refusal and for a
 * permission that has simply never been requested. Anything other than
 * "granted" is therefore reported as unknown — treating it as a refusal would
 * stop us from ever running the helper, and the helper's own ScreenCaptureKit
 * call is what makes macOS show the prompt in the first place.
 */
function screenPermission(): SystemAudioCapability['permission'] {
  if (process.platform !== 'darwin') return 'not-required'
  return systemPreferences.getMediaAccessStatus('screen') === 'granted' ? 'granted' : 'unknown'
}

export function capability(): SystemAudioCapability {
  if (process.platform === 'darwin') {
    const helper = helperPath()
    if (!helper) {
      return {
        mode: 'input-device',
        available: false,
        permission: 'not-required',
        detail:
          'Helper nativo non compilato. Esegui "npm run native:mac", oppure usa un dispositivo di ingresso virtuale come BlackHole.'
      }
    }
    const permission = screenPermission()
    return {
      mode: 'macos-screencapturekit',
      available: permission !== 'denied',
      permission,
      detail:
        permission === 'granted'
          ? "Cattura diretta dell'audio di sistema, nessun driver aggiuntivo."
          : 'Serve il permesso "Registrazione schermo e audio di sistema" per sentire il tuo interlocutore.'
    }
  }

  if (process.platform === 'win32') {
    return {
      mode: 'windows-loopback',
      available: true,
      permission: 'not-required',
      detail: "Cattura diretta dell'audio di sistema tramite loopback di Windows."
    }
  }

  return {
    mode: 'input-device',
    available: true,
    permission: 'not-required',
    detail:
      'Su questa piattaforma seleziona un dispositivo di ingresso che rispecchi l\'uscita audio (es. un monitor PulseAudio).'
  }
}

export function openScreenRecordingSettings(): void {
  if (process.platform === 'darwin') {
    void shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    )
  }
}

export function openMicrophoneSettings(): void {
  if (process.platform === 'darwin') {
    void shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    )
  }
}

/**
 * Provokes the screen-recording permission from the app's own process.
 *
 * The capture itself runs in a helper executable, and a bare helper has its own
 * code identity with no bundle id — nothing macOS can show in a prompt or that
 * the user could toggle in System Settings. Touching a screen-capture API from
 * the app first makes macOS raise the request against `it.beatdata.notebro`,
 * which is the entry the user actually sees, and the helper then inherits that
 * decision as a child process.
 */
export async function ensureScreenPermission(): Promise<SystemAudioCapability['permission']> {
  if (process.platform !== 'darwin') return 'not-required'
  const before = screenPermission()
  if (before === 'granted') {
    logLine('sysaudio', 'permesso schermo: già concesso')
    return before
  }
  try {
    await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false
    })
  } catch (error) {
    // Expected while the permission is missing; the helper reports the truth.
    logLine('sysaudio', `sollecito permesso schermo: ${(error as Error).message || 'rifiutato'}`)
  }
  const after = screenPermission()
  logLine('sysaudio', `permesso schermo: ${before} -> ${after} (grezzo: ${systemPreferences.getMediaAccessStatus('screen')})`)
  return after
}

export interface SystemAudioStream {
  stop(): void
}

interface SystemAudioHandlers {
  onData: (chunk: Buffer) => void
  onReady: () => void
  onError: (message: string) => void
}

/**
 * Spawns the ScreenCaptureKit helper. It emits raw 16-bit mono PCM at 16 kHz on
 * stdout and status lines on stderr, and exits by itself when stdin closes.
 */
export function startMacSystemAudio(handlers: SystemAudioHandlers): SystemAudioStream {
  const helper = helperPath()
  if (!helper) {
    handlers.onError('Helper audio di sistema non trovato.')
    return { stop: () => undefined }
  }

  // Keep our own playback out of the capture, so nothing can feed back.
  const ownBundleId = app.isPackaged ? 'it.beatdata.notebro' : 'com.github.Electron'

  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(helper, ['--exclude-bundle', ownBundleId], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    logLine('sysaudio', `helper avviato (pid ${child.pid}) da ${helper}`)
  } catch (error) {
    const message = `Avvio helper fallito: ${(error as Error).message}`
    logLine('sysaudio', message)
    handlers.onError(message)
    return { stop: () => undefined }
  }

  let stopped = false
  let ready = false
  let stderrTail = ''

  child.stdout.on('data', (chunk: Buffer) => handlers.onData(chunk))

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2000)
    for (const line of chunk.toString('utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      logLine('sysaudio', `helper: ${trimmed}`)
      if (trimmed.startsWith('READY')) {
        ready = true
        handlers.onReady()
      } else if (trimmed.startsWith('ERROR')) {
        handlers.onError(describeHelperError(trimmed.slice(5).trim()))
      }
    }
  })

  child.on('error', (error) => handlers.onError(`Helper audio: ${error.message}`))

  child.on('exit', (code) => {
    logLine('sysaudio', `helper terminato con codice ${code ?? 'sconosciuto'}`)
    if (stopped || ready) return
    handlers.onError(
      `Helper audio terminato (codice ${code ?? 'sconosciuto'}). ${stderrTail.trim()}`.trim()
    )
  })

  return {
    stop: () => {
      stopped = true
      // Closing stdin is the helper's documented shutdown signal.
      child.stdin.end()
      child.kill('SIGTERM')
    }
  }
}

/** Turns the raw TCC failure into something a user can act on. */
function describeHelperError(message: string): string {
  if (/TCC|permiss|rifiutat|declined/i.test(message)) {
    return 'Permesso negato: attiva NoteBro in Impostazioni di Sistema → Privacy e sicurezza → Registrazione schermo e audio di sistema, poi riavvia l\'app.'
  }
  return message
}

export interface SystemAudioTest {
  ok: boolean
  peak: number
  bytes: number
  error?: string
}

/** One second of audio is plenty to prove the stream is live. */
const PROBE_ENOUGH_BYTES = 32_000

/**
 * Records a short burst to prove the system-audio path really delivers samples.
 *
 * ScreenCaptureKit streams buffers continuously once started, even over
 * silence, so "received any bytes at all" is a reliable liveness test that does
 * not depend on something playing at that moment.
 */
export async function testSystemAudio(durationMs = 3000): Promise<SystemAudioTest> {
  // Nudge the permission as the app, then always let the helper try: its
  // ScreenCaptureKit call is what raises the prompt, and its stderr is the only
  // trustworthy account of what macOS decided.
  await ensureScreenPermission()

  return new Promise((resolve) => {
    let bytes = 0
    let peak = 0
    let error: string | undefined
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.stop()
      logLine('sysaudio', `prova: ${bytes} byte, picco ${peak.toFixed(4)}${error ? `, errore: ${error}` : ''}`)
      resolve({ ok: !error && bytes > 0, peak, bytes, error })
    }

    const stream = startMacSystemAudio({
      onReady: () => undefined,
      onError: (message) => {
        error = message
        finish()
      },
      onData: (chunk) => {
        bytes += chunk.length
        const usable = chunk.length - (chunk.length % 2)
        for (let offset = 0; offset < usable; offset += 2) {
          const magnitude = Math.abs(chunk.readInt16LE(offset)) / 32768
          if (magnitude > peak) peak = magnitude
        }
        if (bytes >= PROBE_ENOUGH_BYTES) finish()
      }
    })

    const timer = setTimeout(finish, durationMs)
  })
}
