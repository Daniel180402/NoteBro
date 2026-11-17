/** Types shared between the main process, the preload bridge and the renderer. */

export type SpeakerId = 'me' | 'them'

export interface Segment {
  /** Milliseconds from the start of the recording. */
  from: number
  to: number
  speaker: SpeakerId
  text: string
  /**
   * Which remote voice said it, when diarization told them apart. Absent on
   * your own channel and when only one person was on the far side.
   */
  voice?: number
}

export interface LanguageOption {
  /** Whisper language code, or 'auto' for detection. */
  code: string
  label: string
}

export interface Folder {
  id: string
  name: string
  createdAt: number
}

/** How a note's folder on disk is named: as typed, or lowercase_with_underscores. */
export type NoteNaming = 'title' | 'snake'

export interface NoteMeta {
  id: string
  /** Absolute folder holding the note's files; absent on notes saved before it was configurable. */
  dir?: string
  folderId: string | null
  title: string
  /** Language code the call was recorded in. */
  language: string
  createdAt: number
  durationMs: number
  /** First ~200 characters of the summary, for the list view. */
  excerpt: string
  speakers: SpeakerId[]
  /** `ollama` holds the summary model, whatever service ran it; `provider` its nickname. */
  models: { whisper: string; ollama: string; provider?: string }
  /** True when a mixed recording was kept and can be played back. */
  hasAudio: boolean
  /** Format the recording is stored in; 'wav' only for notes not yet converted. */
  audioFormat?: 'wav' | 'webm'
  /** Names given to the detected remote voices, keyed by voice index. */
  voiceNames?: Record<string, string>
  /** What you typed while the conversation was happening. */
  userNotes?: string
  /** Outline the summary followed; see shared/templates.ts. */
  template?: string
}

export interface Note extends NoteMeta {
  summary: string
  segments: Segment[]
}

export interface Library {
  folders: Folder[]
  notes: NoteMeta[]
}

export type SystemAudioMode =
  /** ScreenCaptureKit helper — needs the Screen Recording permission. */
  | 'macos-screencapturekit'
  /** Chromium loopback via getDisplayMedia. */
  | 'windows-loopback'
  /** parec on the monitor of a PulseAudio/PipeWire sink. */
  | 'linux-pulse-monitor'
  /** Fall back to picking a virtual input device (BlackHole, VB-Cable…). */
  | 'input-device'

/** A PulseAudio/PipeWire monitor source, i.e. what an output device is playing. */
export interface MonitorSource {
  /** Source name as parec expects it. */
  name: string
  /** Human-readable label, e.g. "Monitor of Built-in Audio Analog Stereo". */
  description: string
}

export interface SystemAudioCapability {
  mode: SystemAudioMode
  available: boolean
  /** Whether the OS permission has been granted, when that is knowable. */
  permission: 'granted' | 'denied' | 'unknown' | 'not-required'
  /** Human-readable explanation shown in the UI when unavailable. */
  detail: string
}

export interface WhisperModelInfo {
  name: string
  label: string
  sizeBytes: number
  installed: boolean
  note: string
}

export interface WhisperStatus {
  available: boolean
  binaryPath: string | null
  /** whisper-server, needed only for live transcription. */
  serverBinaryPath: string | null
  source: 'settings' | 'bundled' | 'path' | 'none'
  models: WhisperModelInfo[]
}

export interface OllamaModelInfo {
  name: string
  sizeBytes: number
}

export interface OllamaStatus {
  running: boolean
  baseUrl: string
  models: OllamaModelInfo[]
  /** Set when the CLI exists but the server is not answering. */
  cliFound: boolean
}

export interface Settings {
  language: string
  captureMic: boolean
  captureSystem: boolean
  micDeviceId: string
  systemInputDeviceId: string
  whisperModel: string
  whisperBinaryPath: string
  whisperThreads: number
  /** Services that can write the summary; see ProviderConfig. */
  providers: ProviderConfig[]
  /** The one used unless a recording picks another. */
  defaultProviderId: string
  speakerLabels: { me: string; them: string }
  /** Your name, so the summary knows who the other side is addressing. */
  userName: string
  /** Which summary outline to follow; see shared/templates.ts. */
  template: string
  /** Tell apart several people on the far side of the call. */
  diarization: boolean
  /** Known number of remote participants, or 0 to detect it automatically. */
  expectedSpeakers: number
  /** Names, jargon and product names that recur; biases the transcription. */
  vocabulary: string
  keepAudio: boolean
  /** Removes the speaker output from the mic signal; vital without headphones. */
  echoCancellation: boolean
  noiseSuppression: boolean
  /** Show the transcript while recording, through whisper-server. Costs CPU/GPU during the call. */
  liveTranscription: boolean
  /** Model for the live transcript; empty means the same as whisperModel. */
  liveWhisperModel: string
  /** Skip the final transcription and keep the live one. */
  reuseLiveTranscript: boolean
  /** Where new notes are saved; empty means inside the app's data folder. */
  notesDirectory: string
  noteNaming: NoteNaming
}

/**
 * How a provider is reached:
 * - ollama: an Ollama server, local or remote
 * - openai: any OpenAI-compatible /chat/completions endpoint (OpenRouter, LM Studio, Hermes…)
 * - anthropic: the Claude API, with an API key
 * - claude-code: the local `claude` CLI, on the user's own Claude subscription
 */
export type ProviderKind = 'ollama' | 'openai' | 'anthropic' | 'claude-code'

export interface ProviderConfig {
  id: string
  /** The user's own name for it, e.g. "Ollama del server". */
  name: string
  kind: ProviderKind
  /** Server address for ollama and openai; unused otherwise. */
  baseUrl: string
  model: string
  /** Context window in tokens when the service cannot report it; 0 = ask or guess. */
  contextLength: number
  /** Path of the `claude` executable for claude-code; empty = search PATH. */
  cliPath: string
}

/** What the interface may know about a provider: never the key itself. */
export interface ProviderView extends ProviderConfig {
  hasApiKey: boolean
  /** True when the transcript leaves this computer. */
  remote: boolean
  /** Host the transcript is sent to, for the privacy notice. */
  destination: string
}

export interface ProviderCheck {
  ok: boolean
  /** Why it is not usable, or a short confirmation. */
  detail: string
  /** Models the service offers, when it can list them. */
  models: string[]
  /** Ollama on this machine, installed but not running. */
  canStart: boolean
}

export interface LiveStatus {
  state: 'off' | 'starting' | 'ready' | 'lagging' | 'error'
  message: string
}

export interface StartRecordingOptions {
  language: string
  captureMic: boolean
  captureSystem: boolean
}

export interface RecordingResult {
  sessionId: string
  durationMs: number
  /** Channels that actually received audio. */
  streams: Array<{ stream: SpeakerId; path: string; bytes: number; peak: number }>
}

export type ProcessStage =
  | 'preparing'
  | 'transcribing-me'
  | 'transcribing-them'
  | 'identifying-voices'
  | 'merging'
  | 'summarizing'
  | 'done'
  | 'error'

export interface ProcessProgress {
  sessionId: string
  stage: ProcessStage
  /** 0..1 within the current stage, or null when indeterminate. */
  progress: number | null
  message: string
  /** Streamed summary text so far, during 'summarizing'. */
  partialSummary?: string
  error?: string
}

export interface ProcessResult {
  sessionId: string
  title: string
  summary: string
  segments: Segment[]
  /** Indices of the remote voices that were told apart, in order of first use. */
  voices: number[]
  /** What you typed while the conversation was happening. */
  userNotes: string
  /** Outline the summary followed. */
  template: string
  durationMs: number
  language: string
  models: { whisper: string; ollama: string; provider?: string }
}

export interface LevelUpdate {
  stream: SpeakerId
  /** 0..1 */
  level: number
}

export interface DownloadProgress {
  name: string
  receivedBytes: number
  totalBytes: number
  done: boolean
  error?: string
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'auto', label: 'Rilevamento automatico' },
  { code: 'it', label: 'Italiano' },
  { code: 'en', label: 'Inglese' },
  { code: 'de', label: 'Tedesco' },
  { code: 'fr', label: 'Francese' },
  { code: 'es', label: 'Spagnolo' },
  { code: 'pt', label: 'Portoghese' },
  { code: 'nl', label: 'Olandese' },
  { code: 'ru', label: 'Russo' },
  { code: 'pl', label: 'Polacco' },
  { code: 'tr', label: 'Turco' },
  { code: 'zh', label: 'Cinese' },
  { code: 'ja', label: 'Giapponese' },
  { code: 'ko', label: 'Coreano' },
  { code: 'ar', label: 'Arabo' },
  { code: 'hi', label: 'Hindi' }
]

/** Name used in prompts so the local model answers in the right language. */
export const LANGUAGE_NAMES: Record<string, string> = {
  auto: 'la lingua della trascrizione',
  it: 'italiano',
  en: 'inglese',
  de: 'tedesco',
  fr: 'francese',
  es: 'spagnolo',
  pt: 'portoghese',
  nl: 'olandese',
  ru: 'russo',
  pl: 'polacco',
  tr: 'turco',
  zh: 'cinese',
  ja: 'giapponese',
  ko: 'coreano',
  ar: 'arabo',
  hi: 'hindi'
}

export const SAMPLE_RATE = 16_000
