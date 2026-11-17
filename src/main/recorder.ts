import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordingResult, SpeakerId, StartRecordingOptions } from '@shared/types'
import { logLine } from './log'
import { sessionDir } from './paths'
import { getSettings } from './store'
import {
  capturesSystemAudioInMain,
  ensureScreenPermission,
  startSystemAudio,
  type SystemAudioStream
} from './sysaudio'
import { WavWriter } from './wav'

export interface CompletedChannel {
  speaker: SpeakerId
  path: string
  peak: number
  durationMs: number
  /** One RMS value per 100 ms, used to prune hallucinated silence. */
  energyProfile: number[]
}

export interface CompletedSession {
  id: string
  language: string
  durationMs: number
  channels: CompletedChannel[]
}

interface ActiveSession {
  id: string
  language: string
  startedAt: number
  pausedTotal: number
  pausedAt: number | null
  writers: Map<SpeakerId, WavWriter>
  /** Streams whose leading silence offset has already been written. */
  aligned: Set<SpeakerId>
  systemStream: SystemAudioStream | null
  warnings: string[]
}

export interface RecorderHooks {
  onLevel: (speaker: SpeakerId, level: number) => void
  onWarning: (message: string) => void
}

const completedSessions = new Map<string, CompletedSession>()
let active: ActiveSession | null = null
const lastLevelSent = new Map<SpeakerId, number>()

function wavPath(sessionId: string, speaker: SpeakerId): string {
  return join(sessionDir(sessionId), `${speaker}.wav`)
}

function peakOf(chunk: Buffer): number {
  const usable = chunk.length - (chunk.length % 2)
  let peak = 0
  for (let offset = 0; offset < usable; offset += 2) {
    const magnitude = Math.abs(chunk.readInt16LE(offset)) / 32768
    if (magnitude > peak) peak = magnitude
  }
  return peak
}

export interface StartOutcome {
  sessionId: string
  /** True when the OS gives us system audio without the renderer's help. */
  systemAudioHandledInMain: boolean
}

export async function start(
  options: StartRecordingOptions,
  hooks: RecorderHooks
): Promise<StartOutcome> {
  if (active) throw new Error('Una registrazione è già in corso.')

  const id = randomUUID()
  const session: ActiveSession = {
    id,
    language: options.language,
    startedAt: Date.now(),
    pausedTotal: 0,
    pausedAt: null,
    writers: new Map(),
    aligned: new Set(),
    systemStream: null,
    warnings: []
  }

  if (options.captureMic) {
    const writer = new WavWriter(wavPath(id, 'me'))
    await writer.open()
    session.writers.set('me', writer)
  }

  const nativeSystemAudio = options.captureSystem && capturesSystemAudioInMain()

  if (options.captureSystem) {
    const writer = new WavWriter(wavPath(id, 'them'))
    await writer.open()
    session.writers.set('them', writer)
  }

  active = session
  logLine(
    'recorder',
    `sessione ${id} avviata: microfono=${options.captureMic} audioSistema=${options.captureSystem} nativo=${nativeSystemAudio} lingua=${options.language}`
  )

  if (nativeSystemAudio) {
    await ensureScreenPermission()
    const { systemInputDeviceId } = await getSettings()
    session.systemStream = startSystemAudio({
      onReady: () => undefined,
      onError: (message) => {
        session.warnings.push(message)
        hooks.onWarning(message)
      },
      onData: (chunk) => {
        void writePcm('them', chunk)
        const level = peakOf(chunk)
        throttleLevel('them', level, hooks)
      }
    }, systemInputDeviceId)
  }

  return { sessionId: id, systemAudioHandledInMain: nativeSystemAudio }
}

function throttleLevel(speaker: SpeakerId, level: number, hooks: RecorderHooks): void {
  const now = Date.now()
  const previous = lastLevelSent.get(speaker) ?? 0
  if (now - previous < 60) return
  lastLevelSent.set(speaker, now)
  hooks.onLevel(speaker, level)
}

/** Accepts PCM from either the renderer (microphone, Windows loopback) or the helper. */
export async function writePcm(speaker: SpeakerId, chunk: Buffer): Promise<void> {
  const session = active
  if (!session || session.pausedAt !== null) return
  const writer = session.writers.get(speaker)
  if (!writer) return

  if (!session.aligned.has(speaker)) {
    session.aligned.add(speaker)
    // Pad the head so every channel shares the same t = 0.
    const offset = Date.now() - session.startedAt - session.pausedTotal
    await writer.writeSilence(Math.max(0, offset))
  }

  await writer.write(chunk)
}

export function pause(): void {
  if (!active || active.pausedAt !== null) return
  active.pausedAt = Date.now()
}

export function resume(): void {
  if (!active || active.pausedAt === null) return
  active.pausedTotal += Date.now() - active.pausedAt
  active.pausedAt = null
}

export function isRecording(): boolean {
  return active !== null
}

export function elapsedMs(): number {
  if (!active) return 0
  const pausedNow = active.pausedAt !== null ? Date.now() - active.pausedAt : 0
  return Date.now() - active.startedAt - active.pausedTotal - pausedNow
}

export async function stop(): Promise<RecordingResult> {
  const session = active
  if (!session) throw new Error('Nessuna registrazione in corso.')
  active = null
  lastLevelSent.clear()

  session.systemStream?.stop()
  // Let the last helper chunks land before we seal the files.
  await new Promise((resolve) => setTimeout(resolve, 250))

  const channels: CompletedChannel[] = []
  const streams: RecordingResult['streams'] = []

  for (const [speaker, writer] of session.writers) {
    await writer.close()
    channels.push({
      speaker,
      path: writer.path,
      peak: writer.peak,
      durationMs: writer.durationMs,
      energyProfile: writer.energyProfile
    })
    streams.push({ stream: speaker, path: writer.path, bytes: writer.bytes, peak: writer.peak })
  }

  const durationMs = Math.max(
    0,
    Date.now() - session.startedAt - session.pausedTotal,
    ...channels.map((channel) => channel.durationMs)
  )

  completedSessions.set(session.id, {
    id: session.id,
    language: session.language,
    durationMs,
    channels
  })

  for (const stream of streams) {
    logLine(
      'recorder',
      `canale ${stream.stream}: ${stream.bytes} byte, picco ${stream.peak.toFixed(4)}` +
        (stream.bytes === 0 ? ' — NESSUN DATO RICEVUTO' : '')
    )
  }
  for (const warning of session.warnings) logLine('recorder', `avviso: ${warning}`)

  return { sessionId: session.id, durationMs, streams }
}

/** Abandons an in-flight recording without producing a result. */
export async function cancel(): Promise<void> {
  const session = active
  if (!session) return
  active = null
  session.systemStream?.stop()
  for (const writer of session.writers.values()) await writer.close().catch(() => undefined)
  discard(session.id)
}

export function getCompleted(sessionId: string): CompletedSession | undefined {
  return completedSessions.get(sessionId)
}

/** Removes the temporary audio of a session the user did not keep. */
export function discard(sessionId: string): void {
  completedSessions.delete(sessionId)
  try {
    rmSync(sessionDir(sessionId), { recursive: true, force: true })
  } catch {
    // Nothing to clean up.
  }
}
