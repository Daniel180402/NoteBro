import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { app, desktopCapturer, shell, systemPreferences } from 'electron'
import type { MonitorSource, SystemAudioCapability } from '@shared/types'
import { logLine } from './log'
import { binDir } from './paths'
import {
  DEFAULT_MONITOR,
  parecArgs,
  parseMonitorsJson,
  parseMonitorsShort
} from './pulse'
import { getSettings } from './store'

const run = promisify(execFile)

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

  if (process.platform === 'linux') {
    const parec = findExecutable('parec')
    if (parec) {
      return {
        mode: 'linux-pulse-monitor',
        available: true,
        permission: 'not-required',
        detail:
          "Cattura diretta dell'audio di sistema dal monitor dell'uscita audio (PulseAudio/PipeWire)."
      }
    }
    return {
      mode: 'linux-pulse-monitor',
      available: false,
      permission: 'not-required',
      detail:
        'Manca "parec": installa il pacchetto libpulse (o pulseaudio-utils) per catturare l\'audio di sistema.'
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

  return startPcmProcess(helper, ['--exclude-bundle', ownBundleId], handlers, {
    // The helper announces itself with READY and reports failures as ERROR lines.
    readyOnFirstData: false,
    describeError: describeHelperError
  })
}

/**
 * Records the monitor of a PulseAudio/PipeWire sink with parec. Its stdout is
 * already the 16-bit mono 16 kHz PCM the recorder writes, so nothing is resampled.
 */
export function startLinuxSystemAudio(
  handlers: SystemAudioHandlers,
  device: string = DEFAULT_MONITOR
): SystemAudioStream {
  const parec = findExecutable('parec')
  if (!parec) {
    handlers.onError('"parec" non trovato: installa libpulse (o pulseaudio-utils).')
    return { stop: () => undefined }
  }
  return startPcmProcess(parec, parecArgs(device), handlers, {
    // parec prints nothing on success: the first samples are the only signal.
    readyOnFirstData: true,
    describeError: (message) =>
      /No such entity|non-existent|Stream error/i.test(message)
        ? `Sorgente audio "${device}" non trovata: sceglila di nuovo prima di registrare.`
        : message
  })
}

/** The system-audio capture this platform runs in the main process, if any. */
export function startSystemAudio(handlers: SystemAudioHandlers, device: string): SystemAudioStream {
  if (process.platform === 'darwin') return startMacSystemAudio(handlers)
  if (process.platform === 'linux') return startLinuxSystemAudio(handlers, device || DEFAULT_MONITOR)
  handlers.onError('Cattura nativa dell\'audio di sistema non disponibile su questa piattaforma.')
  return { stop: () => undefined }
}

/** True where system audio is captured in the main process rather than the renderer. */
export function capturesSystemAudioInMain(): boolean {
  if (process.platform === 'darwin') return true
  if (process.platform === 'linux') return findExecutable('parec') !== null
  return false
}

/** Monitor sources the user can pick; empty when pactl is missing or fails. */
export async function listMonitors(): Promise<MonitorSource[]> {
  if (process.platform !== 'linux') return []
  const pactl = findExecutable('pactl')
  if (!pactl) return []
  try {
    const { stdout } = await run(pactl, ['--format=json', 'list', 'sources'], { timeout: 3000 })
    const monitors = parseMonitorsJson(stdout)
    if (monitors.length > 0) return monitors
  } catch {
    // Older pactl has no JSON output; the short listing still has the names.
  }
  try {
    const { stdout } = await run(pactl, ['list', 'short', 'sources'], { timeout: 3000 })
    return parseMonitorsShort(stdout)
  } catch (error) {
    logLine('sysaudio', `pactl non risponde: ${(error as Error).message}`)
    return []
  }
}

export function findExecutable(name: string): string | null {
  const extra = ['/usr/bin', '/usr/local/bin', '/bin']
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...extra].filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

interface PcmProcessOptions {
  readyOnFirstData: boolean
  describeError: (message: string) => string
}

/** Runs a process that streams raw PCM on stdout and diagnostics on stderr. */
function startPcmProcess(
  command: string,
  args: string[],
  handlers: SystemAudioHandlers,
  options: PcmProcessOptions
): SystemAudioStream {
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    logLine('sysaudio', `cattura avviata (pid ${child.pid}): ${command} ${args.join(' ')}`)
  } catch (error) {
    const message = `Avvio cattura fallito: ${(error as Error).message}`
    logLine('sysaudio', message)
    handlers.onError(message)
    return { stop: () => undefined }
  }

  let stopped = false
  let ready = false
  let stderrTail = ''

  child.stdout.on('data', (chunk: Buffer) => {
    if (!ready && options.readyOnFirstData) {
      ready = true
      handlers.onReady()
    }
    handlers.onData(chunk)
  })

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2000)
    for (const line of chunk.toString('utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      logLine('sysaudio', `cattura: ${trimmed}`)
      if (options.readyOnFirstData) continue
      if (trimmed.startsWith('READY')) {
        ready = true
        handlers.onReady()
      } else if (trimmed.startsWith('ERROR')) {
        handlers.onError(options.describeError(trimmed.slice(5).trim()))
      }
    }
  })

  child.on('error', (error) => handlers.onError(`Cattura audio: ${error.message}`))

  child.on('exit', (code) => {
    logLine('sysaudio', `cattura terminata con codice ${code ?? 'sconosciuto'}`)
    if (stopped) return
    if (ready && !options.readyOnFirstData) return
    const detail = options.describeError(stderrTail.trim())
    handlers.onError(
      ready
        ? `La cattura dell'audio di sistema si è interrotta (codice ${code ?? 'sconosciuto'}). ${detail}`.trim()
        : `Cattura audio terminata (codice ${code ?? 'sconosciuto'}). ${detail}`.trim()
    )
  })

  return {
    stop: () => {
      stopped = true
      // Closing stdin is the macOS helper's documented shutdown signal.
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
  const { systemInputDeviceId } = await getSettings()

  return new Promise((resolve) => {
    let bytes = 0
    let peak = 0
    let error: string | undefined
    let settled = false
    // The capture can fail synchronously, before either of these exists.
    let stream: SystemAudioStream | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream?.stop()
      logLine('sysaudio', `prova: ${bytes} byte, picco ${peak.toFixed(4)}${error ? `, errore: ${error}` : ''}`)
      resolve({ ok: !error && bytes > 0, peak, bytes, error })
    }

    stream = startSystemAudio({
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
    }, systemInputDeviceId)

    // An immediate failure has already settled, with no stream yet to stop.
    if (settled) stream.stop()
    else timer = setTimeout(finish, durationMs)
  })
}
