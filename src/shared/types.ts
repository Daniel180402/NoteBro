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

export interface NoteMeta {
  id: string
  folderId: string | null
  title: string
  /** Language code the call was recorded in. */
  language: string
  createdAt: number
  durationMs: number
  /** First ~200 characters of the summary, for the list view. */
  excerpt: string
  speakers: SpeakerId[]
  models: { whisper: string; ollama: string }
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
  /** Fall back to picking a virtual input device (BlackHole, VB-Cable…). */
  | 'input-device'

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
  ollamaModel: string
  ollamaBaseUrl: string
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
  models: { whisper: string; ollama: string }
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
