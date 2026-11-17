import { join } from 'node:path'
import type { ProcessProgress, ProcessResult, Segment, SpeakerId } from '@shared/types'
import { diarize } from './diarization'
import { logLine } from './log'
import { mixToMono } from './mixdown'
import { sessionDir } from './paths'
import { getCompleted } from './recorder'
import * as ollama from './ollama'
import { getSettings } from './store'
import { voicesIn } from '@shared/speakers'
import { assignVoices, buildDialogue } from './transcript'
import { transcribe } from './whisper'

const STAGE_FOR: Record<SpeakerId, ProcessProgress['stage']> = {
  me: 'transcribing-me',
  them: 'transcribing-them'
}

export interface RunOptions {
  sessionId: string
  language: string
  whisperModel: string
  ollamaModel: string
  /** What the user typed while the conversation was happening. */
  userNotes?: string
  /** Outline to follow; falls back to the saved preference. */
  template?: string
  onProgress: (progress: ProcessProgress) => void
  signal?: AbortSignal
}

export async function run(options: RunOptions): Promise<ProcessResult> {
  const { sessionId } = options
  const session = getCompleted(sessionId)
  if (!session) throw new Error('Registrazione non trovata o già elaborata.')

  const settings = await getSettings()
  const report = (patch: Partial<ProcessProgress> & { stage: ProcessProgress['stage'] }): void =>
    options.onProgress({ sessionId, progress: null, message: '', ...patch })

  report({ stage: 'preparing', message: 'Preparazione dei canali audio…' })

  // Identifying the voices only needs the remote channel, so it runs alongside
  // transcription instead of after it: on a 14-minute meeting that hid more
  // than four minutes of waiting.
  const remote = session.channels.find((channel) => channel.speaker === 'them')
  // Below two declared participants there is nothing to tell apart, and the run
  // would cost minutes of inference to produce a single cluster. Guessing the
  // count is not an option: left to itself the clustering invented 38 speakers
  // on a call that had one.
  const diarizing =
    settings.diarization && settings.expectedSpeakers >= 2 && remote && remote.peak >= 0.01
      ? diarize({
          wavPath: remote.path,
          numSpeakers: settings.expectedSpeakers,
          signal: options.signal
        }).catch(() => [])
      : null

  let live: Segment[] | null = null
  if (session.liveTranscript) {
    report({ stage: 'preparing', message: 'Completamento della trascrizione in diretta…' })
    live = await session.liveTranscript
    // An empty or broken live transcript is no reason to lose the call: redo it.
    if (live && live.length === 0) live = null
    logLine('pipeline', live ? `trascrizione in diretta riusata: ${live.length} segmenti` : 'trascrizione in diretta non utilizzabile, rifaccio la trascrizione')
  }

  const segments: Segment[] = live ? [...live] : []
  // Transcribe the two channels independently so every line keeps its speaker.
  // Skipped when the live transcript came through whole.
  for (const channel of live ? [] : session.channels) {
    if (options.signal?.aborted) throw new Error('Elaborazione annullata.')
    const who = settings.speakerLabels[channel.speaker]
    report({
      stage: STAGE_FOR[channel.speaker],
      progress: 0,
      message: `Trascrizione di "${who}"…`
    })

    const channelSegments = await transcribe({
      sessionId,
      speaker: channel.speaker,
      wavPath: channel.path,
      language: options.language,
      model: options.whisperModel,
      peak: channel.peak,
      energyProfile: channel.energyProfile,
      signal: options.signal,
      onProgress: (fraction) =>
        report({
          stage: STAGE_FOR[channel.speaker],
          progress: fraction,
          message: `Trascrizione di "${who}"… ${Math.round(fraction * 100)}%`
        })
    })
    segments.push(...channelSegments)
  }

  // Voices must be known before turns are joined, so two people are never
  // merged into one.
  let identified = segments
  if (diarizing) {
    report({ stage: 'identifying-voices', message: 'Riconoscimento degli interlocutori…' })
    identified = assignVoices(segments, await diarizing)
  }

  report({ stage: 'merging', message: 'Ricostruzione del dialogo…' })
  const merged = buildDialogue(identified)

  // One playable file of the whole conversation, ready before the result screen
  // offers to play it back. Cheap next to transcription, and reused on save.
  if (settings.keepAudio) {
    await mixToMono(
      session.channels.map((channel) => channel.path),
      join(sessionDir(sessionId), 'mix.wav')
    ).catch(() => false)
  }

  if (merged.length === 0) {
    const empty = session.channels.filter((channel) => channel.durationMs === 0)
    if (empty.length > 0) {
      const names = empty.map((channel) => settings.speakerLabels[channel.speaker]).join(' e ')
      throw new Error(
        `Il canale "${names}" non ha ricevuto alcun audio, quindi non c'è nulla da trascrivere. Se si tratta dell'audio di sistema, manca il permesso "Registrazione schermo e audio di sistema": concedilo e riavvia NoteBro.`
      )
    }
    throw new Error(
      'Nessun parlato riconosciuto nella registrazione. Durante l\'ascolto le barre di livello devono muoversi.'
    )
  }

  let partialSummary = ''
  report({ stage: 'summarizing', message: 'Riassunto con Ollama…', partialSummary })

  const contextLength = await ollama.contextLengthOf(settings.ollamaBaseUrl, options.ollamaModel)
  const summary = await ollama.summarize({
    baseUrl: settings.ollamaBaseUrl,
    model: options.ollamaModel,
    language: options.language,
    segments: merged,
    labels: settings.speakerLabels,
    userName: settings.userName,
    vocabulary: settings.vocabulary,
    userNotes: options.userNotes,
    templateId: options.template ?? settings.template,
    contextLength,
    signal: options.signal,
    onStage: (message, fraction) =>
      report({ stage: 'summarizing', message, progress: fraction, partialSummary }),
    onToken: (token) => {
      partialSummary += token
      report({ stage: 'summarizing', message: 'Riassunto con Ollama…', partialSummary })
    }
  })

  const title = await ollama
    .suggestTitle({
      baseUrl: settings.ollamaBaseUrl,
      model: options.ollamaModel,
      language: options.language,
      summary,
      signal: options.signal
    })
    .catch(() => '')

  report({ stage: 'done', progress: 1, message: 'Pronto.' })

  return {
    sessionId,
    title: title || defaultTitle(),
    summary,
    segments: merged,
    voices: voicesIn(merged),
    userNotes: options.userNotes ?? '',
    template: options.template ?? settings.template,
    durationMs: session.durationMs,
    language: options.language,
    models: { whisper: options.whisperModel, ollama: options.ollamaModel }
  }
}

function defaultTitle(): string {
  const now = new Date()
  return `Registrazione del ${now.toLocaleDateString('it-IT')} alle ${now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
}
