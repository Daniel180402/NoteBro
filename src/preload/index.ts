import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  DownloadProgress,
  Library,
  LevelUpdate,
  Note,
  ProcessProgress,
  ProcessResult,
  RecordingResult,
  Segment,
  Settings,
  SpeakerId,
  StartRecordingOptions,
  SystemAudioCapability,
  MonitorSource,
  ProviderCheck,
  ProviderConfig,
  ProviderView,
  LiveStatus,
  WhisperStatus,
  OllamaStatus
} from '@shared/types'

/** Wires a main-process event to a callback and returns the unsubscriber. */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

interface PullProgress {
  model: string
  status: string
  completed: number
  total: number
  done: boolean
}

const api = {
  system: {
    info: (): Promise<{
      platform: string
      capability: SystemAudioCapability
      monitors: MonitorSource[]
    }> =>
      ipcRenderer.invoke('system:info'),
    openScreenRecordingSettings: (): Promise<void> =>
      ipcRenderer.invoke('system:openScreenRecordingSettings'),
    openMicrophoneSettings: (): Promise<void> =>
      ipcRenderer.invoke('system:openMicrophoneSettings'),
    testSystemAudio: (): Promise<{ ok: boolean; peak: number; bytes: number; error?: string }> =>
      ipcRenderer.invoke('system:testSystemAudio'),
    openLog: (): Promise<void> => ipcRenderer.invoke('system:openLog'),
    restart: (): Promise<void> => ipcRenderer.invoke('system:restart')
  },

  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch)
  },

  whisper: {
    status: (): Promise<WhisperStatus> => ipcRenderer.invoke('whisper:status'),
    download: (name: string): Promise<WhisperStatus> =>
      ipcRenderer.invoke('whisper:download', name),
    cancelDownload: (name: string): Promise<void> =>
      ipcRenderer.invoke('whisper:cancelDownload', name),
    deleteModel: (name: string): Promise<WhisperStatus> =>
      ipcRenderer.invoke('whisper:deleteModel', name),
    onDownload: (callback: (progress: DownloadProgress) => void): (() => void) =>
      subscribe('whisper:download', callback)
  },

  ollama: {
    status: (baseUrl: string): Promise<OllamaStatus> => ipcRenderer.invoke('ollama:status', baseUrl),
    start: (baseUrl: string): Promise<OllamaStatus> => ipcRenderer.invoke('ollama:start', baseUrl),
    pull: (baseUrl: string, model: string): Promise<OllamaStatus> =>
      ipcRenderer.invoke('ollama:pull', baseUrl, model),
    onPull: (callback: (progress: PullProgress) => void): (() => void) =>
      subscribe('ollama:pull', callback)
  },

  providers: {
    list: (): Promise<{
      providers: ProviderView[]
      defaultProviderId: string
      encryptionAvailable: boolean
    }> => ipcRenderer.invoke('providers:list'),
    /** `apiKey`: undefined keeps the stored key, '' removes it. */
    save: (provider: ProviderConfig, apiKey?: string): Promise<Settings> =>
      ipcRenderer.invoke('providers:save', provider, apiKey),
    remove: (id: string): Promise<Settings> => ipcRenderer.invoke('providers:delete', id),
    check: (id: string): Promise<ProviderCheck> => ipcRenderer.invoke('providers:check', id)
  },

  diarization: {
    status: (): Promise<{
      supported: boolean
      modelsInstalled: boolean
      totalBytes: number
      installedBytes: number
    }> => ipcRenderer.invoke('diarization:status'),
    download: (): Promise<{
      supported: boolean
      modelsInstalled: boolean
      totalBytes: number
      installedBytes: number
    }> => ipcRenderer.invoke('diarization:download'),
    remove: (): Promise<{
      supported: boolean
      modelsInstalled: boolean
      totalBytes: number
      installedBytes: number
    }> => ipcRenderer.invoke('diarization:delete'),
    onDownload: (
      callback: (progress: {
        receivedBytes: number
        totalBytes: number
        done: boolean
        error?: string
      }) => void
    ): (() => void) => subscribe('diarization:download', callback)
  },

  recorder: {
    start: (
      options: StartRecordingOptions
    ): Promise<{ sessionId: string; systemAudioHandledInMain: boolean }> =>
      ipcRenderer.invoke('recorder:start', options),
    /** Fire-and-forget PCM push; the buffer is transferred, not copied. */
    pcm: (speaker: SpeakerId, data: Uint8Array): void =>
      ipcRenderer.send('recorder:pcm', speaker, data),
    pause: (): Promise<void> => ipcRenderer.invoke('recorder:pause'),
    resume: (): Promise<void> => ipcRenderer.invoke('recorder:resume'),
    stop: (): Promise<RecordingResult> => ipcRenderer.invoke('recorder:stop'),
    cancel: (): Promise<void> => ipcRenderer.invoke('recorder:cancel'),
    onLevel: (callback: (update: LevelUpdate) => void): (() => void) =>
      subscribe('recorder:level', callback),
    onWarning: (callback: (message: string) => void): (() => void) =>
      subscribe('recorder:warning', callback)
  },

  live: {
    onSegments: (callback: (segments: Segment[]) => void): (() => void) =>
      subscribe('live:segments', callback),
    onStatus: (callback: (status: LiveStatus) => void): (() => void) =>
      subscribe('live:status', callback)
  },

  process: {
    run: (options: {
      sessionId: string
      language: string
      whisperModel: string
      providerId?: string
      userNotes?: string
      template?: string
    }): Promise<ProcessResult> => ipcRenderer.invoke('process:run', options),
    cancel: (): Promise<void> => ipcRenderer.invoke('process:cancel'),
    onProgress: (callback: (progress: ProcessProgress) => void): (() => void) =>
      subscribe('process:progress', callback)
  },

  storage: {
    report: (): Promise<{
      audioBytes: number
      modelBytes: number
      sessionBytes: number
      pendingCompression: number
      reclaimableBytes: number
    }> => ipcRenderer.invoke('storage:report'),
    cleanSessions: (): Promise<number> => ipcRenderer.invoke('storage:cleanSessions'),
    compress: (): Promise<number> => ipcRenderer.invoke('storage:compress'),
    onCompress: (
      callback: (progress: { done: number; total: number; freed: number }) => void
    ): (() => void) => subscribe('storage:compress', callback)
  },

  draft: {
    list: (): Promise<ProcessResult[]> => ipcRenderer.invoke('draft:list'),
    clear: (sessionId: string): Promise<void> => ipcRenderer.invoke('draft:clear', sessionId)
  },

  library: {
    load: (): Promise<Library> => ipcRenderer.invoke('library:load'),
    createFolder: (name: string): Promise<{ library: Library; folderId: string }> =>
      ipcRenderer.invoke('library:createFolder', name),
    renameFolder: (id: string, name: string): Promise<Library> =>
      ipcRenderer.invoke('library:renameFolder', id, name),
    deleteFolder: (id: string): Promise<Library> => ipcRenderer.invoke('library:deleteFolder', id)
  },

  ui: {
    confirm: (input: {
      title: string
      message: string
      detail?: string
      confirmLabel?: string
    }): Promise<boolean> => ipcRenderer.invoke('ui:confirm', input)
  },

  notes: {
    save: (input: {
      sessionId: string
      title: string
      folderId: string | null
      language: string
      durationMs: number
      summary: string
      segments: Segment[]
      models: { whisper: string; ollama: string; provider?: string }
      voiceNames?: Record<string, string>
      userNotes?: string
      template?: string
    }): Promise<{ library: Library; note: Note }> => ipcRenderer.invoke('notes:save', input),
    get: (id: string): Promise<Note | null> => ipcRenderer.invoke('notes:get', id),
    update: (
      id: string,
      patch: {
        title?: string
        folderId?: string | null
        summary?: string
        voiceNames?: Record<string, string>
      }
    ): Promise<Library> => ipcRenderer.invoke('notes:update', id, patch),
    remove: (id: string): Promise<Library> => ipcRenderer.invoke('notes:delete', id),
    reveal: (id: string): Promise<void> => ipcRenderer.invoke('notes:reveal', id),
    defaultDirectory: (): Promise<string> => ipcRenderer.invoke('notes:defaultDirectory'),
    chooseDirectory: (): Promise<{ path: string | null; error?: string }> =>
      ipcRenderer.invoke('notes:chooseDirectory'),
    reorganize: (): Promise<{ library: Library; moved: number; failed: string[] }> =>
      ipcRenderer.invoke('notes:reorganize'),
    export: (input: {
      title: string
      summary: string
      transcript?: string
    }): Promise<{ saved: boolean; path?: string }> => ipcRenderer.invoke('notes:export', input)
  },

  session: {
    discard: (sessionId: string): Promise<void> => ipcRenderer.invoke('session:discard', sessionId)
  }
}

contextBridge.exposeInMainWorld('notebro', api)

export type NoteBroApi = typeof api
