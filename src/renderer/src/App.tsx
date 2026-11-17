import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DownloadProgress,
  Library,
  Note,
  OllamaStatus,
  ProcessProgress,
  ProcessResult,
  Settings,
  SpeakerId,
  SystemAudioCapability,
  MonitorSource,
  WhisperStatus
} from '@shared/types'
import { startCapture, listMicrophones, type CaptureHandle } from './audio/capture'
import { ALL_NOTES, Sidebar, UNFILED } from './components/Sidebar'
import { NoteDetail, NotesList } from './components/LibraryView'
import { ProcessingView } from './components/ProcessingView'
import { RecordView, RecordingView, type Blocker } from './components/RecordView'
import { ResultView } from './components/ResultView'
import {
  SettingsView,
  type DiarizationStatus,
  type StorageReport
} from './components/SettingsView'
import { timecode } from './format'

type Screen = 'record' | 'recording' | 'processing' | 'result' | 'library' | 'note' | 'settings'

interface PullProgress {
  model: string
  status: string
  completed: number
  total: number
  done: boolean
}

/** Preference order when auto-picking a summariser the user already has. */
const PREFERRED_OLLAMA = ['qwen2.5', 'llama3.1', 'llama3.2', 'gemma2', 'mistral']

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [library, setLibrary] = useState<Library>({ folders: [], notes: [] })
  const [whisper, setWhisper] = useState<WhisperStatus | null>(null)
  const [ollama, setOllama] = useState<OllamaStatus | null>(null)
  const [platform, setPlatform] = useState('')
  const [monitors, setMonitors] = useState<MonitorSource[]>([])
  const [capability, setCapability] = useState<SystemAudioCapability | null>(null)
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([])

  const [screen, setScreen] = useState<Screen>('record')
  const [selection, setSelection] = useState(ALL_NOTES)
  const [openNote, setOpenNote] = useState<Note | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [channels, setChannels] = useState<SpeakerId[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [paused, setPaused] = useState(false)
  const [levels, setLevels] = useState({ me: 0, them: 0 })
  /** A channel that produced sound at least once. */
  const [seen, setSeen] = useState({ me: false, them: false })
  /** A channel that is delivering samples at all, silent or not. */
  const [receiving, setReceiving] = useState({ me: false, them: false })
  const [preflight, setPreflight] = useState<{ error: string } | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  /** What the user types while the conversation is happening. */
  const [liveNotes, setLiveNotes] = useState('')
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)

  const [progress, setProgress] = useState<ProcessProgress | null>(null)
  const [processError, setProcessError] = useState<string | null>(null)
  const [result, setResult] = useState<ProcessResult | null>(null)
  const [saving, setSaving] = useState(false)

  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({})
  const [pull, setPull] = useState<PullProgress | null>(null)
  const [diarization, setDiarization] = useState<DiarizationStatus | null>(null)
  const [storage, setStorage] = useState<StorageReport | null>(null)
  const [compressProgress, setCompressProgress] = useState<{
    done: number
    total: number
    freed: number
  } | null>(null)
  const [diarizationDownload, setDiarizationDownload] = useState<{
    receivedBytes: number
    totalBytes: number
    done: boolean
    error?: string
  } | null>(null)
  const [busyModel, setBusyModel] = useState<string | null>(null)
  const [systemAudioTest, setSystemAudioTest] = useState<{
    ok: boolean
    peak: number
    error?: string
  } | null>(null)
  const [testing, setTesting] = useState(false)

  const capture = useRef<CaptureHandle | null>(null)
  /** Set once the system-audio path has proven itself in this app session. */
  const systemAudioVerified = useRef(false)
  const startedAt = useRef(0)
  const pausedTotal = useRef(0)
  const pausedAt = useRef<number | null>(null)

  const refreshEngines = useCallback(async (): Promise<void> => {
    const [whisperStatus, ollamaStatus, info, diarizationStatus] = await Promise.all([
      window.notebro.whisper.status(),
      window.notebro.ollama.status(),
      window.notebro.system.info(),
      window.notebro.diarization.status()
    ])
    setStorage(await window.notebro.storage.report())
    setWhisper(whisperStatus)
    setOllama(ollamaStatus)
    setPlatform(info.platform)
    setCapability(info.capability)
    setMonitors(info.monitors)
    setDiarization(diarizationStatus)
  }, [])

  // A different output has to prove itself again before the next recording.
  useEffect(() => {
    systemAudioVerified.current = false
  }, [settings?.systemInputDeviceId])

  // Initial load.
  useEffect(() => {
    void (async () => {
      const [loadedSettings, loadedLibrary] = await Promise.all([
        window.notebro.settings.get(),
        window.notebro.library.load()
      ])
      setSettings(loadedSettings)
      setLibrary(loadedLibrary)
      // A summary left unfiled last time is restored rather than lost.
      const draft = await window.notebro.draft.get()
      if (draft) setResult(draft)
      await refreshEngines()
      setMicrophones(await listMicrophones().catch(() => []))
    })()
  }, [refreshEngines])

  // Main-process events.
  useEffect(() => {
    const offLevel = window.notebro.recorder.onLevel(({ stream, level }) => {
      setLevels((previous) => ({ ...previous, [stream]: level }))
      setReceiving((previous) => (previous[stream] ? previous : { ...previous, [stream]: true }))
      if (level > 0.002) setSeen((previous) => ({ ...previous, [stream]: true }))
    })
    const offWarning = window.notebro.recorder.onWarning((message) => {
      setWarnings((previous) => (previous.includes(message) ? previous : [...previous, message]))
    })
    const offProgress = window.notebro.process.onProgress(setProgress)
    const offDownload = window.notebro.whisper.onDownload((payload) => {
      setDownloads((previous) => ({ ...previous, [payload.name]: payload }))
    })
    const offPull = window.notebro.ollama.onPull(setPull)
    const offDiarization = window.notebro.diarization.onDownload(setDiarizationDownload)
    const offCompress = window.notebro.storage.onCompress(setCompressProgress)
    return () => {
      offCompress()
      offDiarization()
      offLevel()
      offWarning()
      offProgress()
      offDownload()
      offPull()
    }
  }, [])

  // Recording clock, plus a decay so the meters fall back when audio stops.
  useEffect(() => {
    if (screen !== 'recording') return undefined
    const timer = setInterval(() => {
      const held = pausedAt.current !== null ? Date.now() - pausedAt.current : 0
      setElapsed(Date.now() - startedAt.current - pausedTotal.current - held)
      setLevels((previous) => ({ me: previous.me * 0.6, them: previous.them * 0.6 }))
    }, 120)
    return () => clearInterval(timer)
  }, [screen])

  const patch = useCallback(async (changes: Partial<Settings>): Promise<void> => {
    setSettings((previous) => (previous ? { ...previous, ...changes } : previous))
    const saved = await window.notebro.settings.set(changes)
    setSettings(saved)
  }, [])

  // Fill in sensible model choices once we know what is installed.
  useEffect(() => {
    if (!settings || !whisper || !ollama) return
    const installed = whisper.models.filter((model) => model.installed).map((model) => model.name)
    const changes: Partial<Settings> = {}
    if (installed.length > 0 && !installed.includes(settings.whisperModel)) {
      changes.whisperModel = installed.includes('small') ? 'small' : installed[0]
    }
    const names = ollama.models.map((model) => model.name)
    if (names.length > 0 && !names.includes(settings.ollamaModel)) {
      const preferred = PREFERRED_OLLAMA.map((prefix) =>
        names.find((name) => name.startsWith(prefix))
      ).find(Boolean)
      changes.ollamaModel = preferred ?? names[0]
    }
    if (Object.keys(changes).length > 0) void patch(changes)
  }, [settings, whisper, ollama, patch])

  const blockers = useMemo<Blocker[]>(() => {
    if (!settings) return []
    const found: Blocker[] = []
    const installed = whisper?.models.filter((model) => model.installed) ?? []

    if (whisper && !whisper.available) {
      found.push({
        title: 'Motore di trascrizione mancante',
        text:
          platform === 'darwin'
            ? 'Installa whisper.cpp con "brew install whisper-cpp", poi ricontrolla dalle impostazioni.'
            : platform === 'linux'
              ? 'Installa whisper.cpp dal gestore di pacchetti (deve fornire whisper-cli) oppure indicane il percorso nelle impostazioni.'
              : 'Indica il percorso di whisper-cli.exe nelle impostazioni.',
        action: { label: 'Impostazioni', run: () => setScreen('settings') }
      })
    } else if (whisper && installed.length === 0) {
      found.push({
        title: 'Nessun modello di trascrizione',
        text: 'Scarica almeno un modello whisper (Small è il compromesso consigliato per l\'italiano).',
        action: { label: 'Scarica', run: () => setScreen('settings') }
      })
    }

    if (ollama && !ollama.running) {
      found.push({
        title: 'Ollama non è in esecuzione',
        text: ollama.cliFound
          ? 'Serve per generare il riassunto in locale.'
          : 'Installa Ollama da ollama.com per generare i riassunti.',
        action: ollama.cliFound
          ? {
              label: 'Avvia Ollama',
              run: () => {
                void window.notebro.ollama.start().then(setOllama)
              }
            }
          : { label: 'Impostazioni', run: () => setScreen('settings') }
      })
    } else if (ollama && ollama.models.length === 0) {
      found.push({
        title: 'Nessun modello di riassunto',
        text: 'Scarica un modello in Ollama, per esempio qwen2.5:7b.',
        action: { label: 'Impostazioni', run: () => setScreen('settings') }
      })
    }

    if (
      settings.captureSystem &&
      capability?.mode === 'macos-screencapturekit' &&
      capability.permission === 'denied'
    ) {
      found.push({
        title: 'Permesso per l\'audio di sistema negato',
        text: 'Attiva NoteBro in Privacy e sicurezza → Registrazione schermo e audio di sistema, poi riavvia l\'app.',
        action: {
          label: 'Apri impostazioni',
          run: () => void window.notebro.system.openScreenRecordingSettings()
        }
      })
    }

    return found
  }, [settings, whisper, ollama, capability, platform])

  const handleStart = async (): Promise<void> => {
    if (!settings) return
    setStarting(true)
    setWarnings([])
    setLiveNotes('')
    setLevels({ me: 0, them: 0 })
    setSeen({ me: false, them: false })
    setReceiving({ me: false, them: false })
    setSystemAudioTest(null)
    setPreflight(null)
    try {
      // Prove the system-audio path delivers samples before committing to a
      // recording: otherwise a dead channel only surfaces once it is too late.
      const probesSystemAudio =
        platform === 'darwin' ||
        (capability?.mode === 'linux-pulse-monitor' && capability.available)
      if (settings.captureSystem && probesSystemAudio && !systemAudioVerified.current) {
        const probe = await window.notebro.system.testSystemAudio()
        if (!probe.ok || probe.bytes === 0) {
          setPreflight({
            error:
              probe.error ??
              "Il canale dell'audio di sistema non ha ricevuto alcun dato dal sistema."
          })
          setStarting(false)
          return
        }
        systemAudioVerified.current = true
      }

      const outcome = await window.notebro.recorder.start({
        language: settings.language,
        captureMic: settings.captureMic,
        captureSystem: settings.captureSystem
      })

      const handle = await startCapture({
        captureMic: settings.captureMic,
        captureSystemInRenderer: settings.captureSystem && !outcome.systemAudioHandledInMain,
        micDeviceId: settings.micDeviceId,
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        onLevel: (stream, level) => {
          setLevels((previous) => ({ ...previous, [stream]: level }))
          setReceiving((previous) => (previous[stream] ? previous : { ...previous, [stream]: true }))
          if (level > 0.002) setSeen((previous) => ({ ...previous, [stream]: true }))
        },
        onWarning: (message) =>
          setWarnings((previous) => (previous.includes(message) ? previous : [...previous, message]))
      })

      capture.current = handle
      setSessionId(outcome.sessionId)
      setChannels([
        ...(settings.captureMic ? (['me'] as SpeakerId[]) : []),
        ...(settings.captureSystem ? (['them'] as SpeakerId[]) : [])
      ])
      startedAt.current = Date.now()
      pausedTotal.current = 0
      pausedAt.current = null
      setElapsed(0)
      setPaused(false)
      setScreen('recording')
      // Device labels only become readable once a stream has been granted.
      setMicrophones(await listMicrophones().catch(() => []))
    } catch (error) {
      await window.notebro.recorder.cancel().catch(() => undefined)
      setFatal(error instanceof Error ? error.message : String(error))
    } finally {
      setStarting(false)
    }
  }

  const runProcessing = useCallback(
    async (id: string, language: string, userNotes: string): Promise<void> => {
      if (!settings) return
      setProcessError(null)
      setProgress(null)
      setScreen('processing')
      try {
        const outcome = await window.notebro.process.run({
          sessionId: id,
          language,
          whisperModel: settings.whisperModel,
          ollamaModel: settings.ollamaModel,
          userNotes,
          template: settings.template
        })
        setResult(outcome)
        setScreen('result')
      } catch (error) {
        setProcessError(error instanceof Error ? error.message : String(error))
      }
    },
    [settings]
  )

  const handleStop = async (): Promise<void> => {
    if (!settings) return
    setStopping(true)
    try {
      await capture.current?.stop()
      capture.current = null
      const recording = await window.notebro.recorder.stop()
      setSessionId(recording.sessionId)
      await runProcessing(recording.sessionId, settings.language, liveNotes)
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error))
      setScreen('record')
    } finally {
      setStopping(false)
    }
  }

  const handleCancelRecording = async (): Promise<void> => {
    await capture.current?.stop().catch(() => undefined)
    capture.current = null
    await window.notebro.recorder.cancel().catch(() => undefined)
    setSessionId(null)
    setScreen('record')
  }

  const handlePause = (): void => {
    pausedAt.current = Date.now()
    setPaused(true)
    void window.notebro.recorder.pause()
  }

  const handleResume = (): void => {
    if (pausedAt.current !== null) pausedTotal.current += Date.now() - pausedAt.current
    pausedAt.current = null
    setPaused(false)
    void window.notebro.recorder.resume()
  }

  const deleteFolder = async (id: string, name: string): Promise<void> => {
    const notesInside = library.notes.filter((note) => note.folderId === id).length
    const confirmed = await window.notebro.ui.confirm({
      title: 'Elimina cartella',
      message: `Eliminare la cartella "${name}"?`,
      detail:
        notesInside === 0
          ? 'La cartella è vuota.'
          : `${notesInside === 1 ? 'Il riassunto contenuto' : `I ${notesInside} riassunti contenuti`} non ${notesInside === 1 ? 'verrà eliminato' : 'verranno eliminati'}: ${notesInside === 1 ? 'tornerà' : 'torneranno'} in "Senza cartella".`,
      confirmLabel: 'Elimina cartella'
    })
    if (!confirmed) return
    setLibrary(await window.notebro.library.deleteFolder(id))
    // Showing a folder that no longer exists would leave an empty list.
    setSelection((current) => (current === id ? ALL_NOTES : current))
  }

  const createFolder = async (name: string): Promise<string> => {
    const { library: next, folderId } = await window.notebro.library.createFolder(name)
    setLibrary(next)
    return folderId
  }

  const handleSave = async (input: {
    title: string
    folderId: string | null
    summary: string
    voiceNames: Record<string, string>
  }): Promise<void> => {
    if (!result) return
    setSaving(true)
    try {
      const { library: next, note } = await window.notebro.notes.save({
        sessionId: result.sessionId,
        title: input.title,
        folderId: input.folderId,
        language: result.language,
        durationMs: result.durationMs,
        summary: input.summary,
        segments: result.segments,
        models: result.models,
        voiceNames: input.voiceNames,
        userNotes: result.userNotes,
        template: result.template
      })
      setLibrary(next)
      setResult(null)
      setOpenNote(note)
      setSelection(input.folderId ?? UNFILED)
      setScreen('note')
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const exportMarkdown = async (
    title: string,
    summary: string,
    segments: ProcessResult['segments'],
    withTranscript: boolean
  ): Promise<void> => {
    const transcript = withTranscript
      ? segments
          .map(
            (segment) =>
              `**${timecode(segment.from)} ${settings?.speakerLabels[segment.speaker] ?? segment.speaker}:** ${segment.text}`
          )
          .join('\n\n')
      : undefined
    await window.notebro.notes.export({ title, summary, transcript })
  }

  const openNoteById = async (id: string): Promise<void> => {
    const note = await window.notebro.notes.get(id)
    if (note) {
      setOpenNote(note)
      setScreen('note')
    }
  }

  if (!settings) {
    return (
      <div className="app" style={{ gridTemplateColumns: '1fr' }}>
        <div className="empty" style={{ alignSelf: 'center' }}>
          Caricamento…
        </div>
      </div>
    )
  }

  const recordingActive = screen === 'recording'

  return (
    <div className="app">
      <Sidebar
        library={library}
        selection={selection}
        whisper={whisper}
        ollama={ollama}
        busy={recordingActive || screen === 'processing'}
        pendingResult={result !== null && screen !== 'result'}
        onResumeResult={() => setScreen('result')}
        onSelect={(next) => {
          setSelection(next)
          setOpenNote(null)
          setScreen('library')
        }}
        onNewRecording={() => setScreen('record')}
        onOpenSettings={() => setScreen('settings')}
        onCreateFolder={(name) => void createFolder(name)}
        onRenameFolder={(id, name) => {
          void window.notebro.library.renameFolder(id, name).then(setLibrary)
        }}
        onDeleteFolder={(id, name) => void deleteFolder(id, name)}
      />

      <div className="main">
        <div className="main__drag" />
        <div className={`main__body${screen === 'note' || screen === 'result' ? ' main__body--wide' : ''}`}>
          {fatal && (
            <div className="banner banner--error">
              <div className="banner__body">
                <div className="banner__title">Qualcosa è andato storto</div>
                <div className="banner__text">{fatal}</div>
              </div>
              <button type="button" className="btn btn--ghost" onClick={() => setFatal(null)}>
                Chiudi
              </button>
            </div>
          )}

          {screen === 'record' && (
            <RecordView
              settings={settings}
              onPatch={(changes) => void patch(changes)}
              whisper={whisper}
              ollama={ollama}
              capability={capability}
              microphones={microphones}
              monitors={monitors}
              blockers={blockers}
              starting={starting}
              testing={testing}
              preflight={preflight}
              onDismissPreflight={() => setPreflight(null)}
              onRecordMicOnly={() => {
                setPreflight(null)
                void patch({ captureSystem: false })
              }}
              onOpenScreenSettings={() =>
                void window.notebro.system.openScreenRecordingSettings()
              }
              onRestart={() => void window.notebro.system.restart()}
              systemAudioTest={systemAudioTest}
              onTestSystemAudio={() => {
                setTesting(true)
                void window.notebro.system
                  .testSystemAudio()
                  .then(setSystemAudioTest)
                  .finally(() => {
                    setTesting(false)
                    void refreshEngines()
                  })
              }}
              onStart={() => void handleStart()}
            />
          )}

          {recordingActive && (
            <RecordingView
              elapsedMs={elapsed}
              levels={levels}
              seen={seen}
              receiving={receiving}
              onOpenScreenSettings={() =>
                void window.notebro.system.openScreenRecordingSettings()
              }
              paused={paused}
              captureMic={settings.captureMic}
              captureSystem={settings.captureSystem}
              labels={settings.speakerLabels}
              warnings={warnings}
              notes={liveNotes}
              onNotesChange={setLiveNotes}
              stopping={stopping}
              onPause={handlePause}
              onResume={handleResume}
              onStop={() => void handleStop()}
              onCancel={() => void handleCancelRecording()}
            />
          )}

          {screen === 'processing' && (
            <ProcessingView
              progress={progress}
              channels={channels}
              labels={settings.speakerLabels}
              diarizing={settings.diarization && settings.captureSystem}
              error={processError}
              onCancel={() => {
                void window.notebro.process.cancel()
                setScreen('record')
              }}
              onRetry={() => {
                if (sessionId) void runProcessing(sessionId, settings.language, liveNotes)
              }}
              onBack={() => setScreen('record')}
            />
          )}

          {screen === 'result' && result && (
            <ResultView
              result={result}
              folders={library.folders}
              labels={settings.speakerLabels}
              saving={saving}
              audioUrl={
                settings.keepAudio ? `notebro-audio://session/${result.sessionId}` : null
              }
              onSave={(input) => void handleSave(input)}
              onCreateFolder={createFolder}
              onExport={(title, summary) =>
                void exportMarkdown(title, summary, result.segments, false)
              }
              onDiscard={() => {
                void window.notebro.ui
                  .confirm({
                    title: 'Scarta riassunto',
                    message: 'Scartare questo riassunto?',
                    detail:
                      'Il testo e la registrazione verranno eliminati definitivamente. Trascrizione e riassunto andrebbero rifatti da capo.',
                    confirmLabel: 'Scarta'
                  })
                  .then((confirmed) => {
                    if (!confirmed) return
                    void window.notebro.draft.clear(result.sessionId)
                    setResult(null)
                    setScreen('record')
                  })
              }}
            />
          )}

          {screen === 'library' && (
            <NotesList
              library={library}
              selection={selection}
              onOpen={(id) => void openNoteById(id)}
              onNewRecording={() => setScreen('record')}
            />
          )}

          {screen === 'note' && openNote && (
            <NoteDetail
              note={openNote}
              folders={library.folders}
              labels={settings.speakerLabels}
              onBack={() => {
                setOpenNote(null)
                setScreen('library')
              }}
              onUpdate={(changes) => {
                void window.notebro.notes.update(openNote.id, changes).then((next) => {
                  setLibrary(next)
                  setOpenNote((previous) =>
                    previous ? { ...previous, ...changes, summary: changes.summary ?? previous.summary } : previous
                  )
                })
              }}
              onDelete={() => {
                void window.notebro.notes.remove(openNote.id).then((next) => {
                  setLibrary(next)
                  setOpenNote(null)
                  setScreen('library')
                })
              }}
              onExport={(withTranscript) =>
                void exportMarkdown(
                  openNote.title,
                  openNote.summary,
                  openNote.segments,
                  withTranscript
                )
              }
              onReveal={() => void window.notebro.notes.reveal(openNote.id)}
            />
          )}

          {screen === 'settings' && (
            <SettingsView
              settings={settings}
              onPatch={(changes) => void patch(changes)}
              whisper={whisper}
              ollama={ollama}
              capability={capability}
              platform={platform}
              downloads={downloads}
              pull={pull}
              diarization={diarization}
              storage={storage}
              compressProgress={compressProgress}
              onCompressAudio={() => {
                void window.notebro.storage
                  .compress()
                  .then(() => window.notebro.storage.report().then(setStorage))
                  .catch((error: Error) => setFatal(error.message))
              }}
              onCleanSessions={() => {
                void window.notebro.storage
                  .cleanSessions()
                  .then(() => window.notebro.storage.report().then(setStorage))
              }}
              diarizationDownload={diarizationDownload}
              onDownloadDiarization={() => {
                setDiarizationDownload({ receivedBytes: 0, totalBytes: 0, done: false })
                void window.notebro.diarization
                  .download()
                  .then((status) => {
                    setDiarization(status)
                    // Downloading them is a clear sign the feature is wanted.
                    if (status.modelsInstalled) void patch({ diarization: true })
                  })
                  .catch((error: Error) => setFatal(error.message))
              }}
              onDeleteDiarization={() => {
                void window.notebro.diarization.remove().then((status) => {
                  setDiarization(status)
                  setDiarizationDownload(null)
                  void patch({ diarization: false })
                })
              }}
              busyModel={busyModel}
              onDownloadModel={(name) => {
                setBusyModel(name)
                void window.notebro.whisper
                  .download(name)
                  .then(setWhisper)
                  .catch((error: Error) => setFatal(error.message))
                  .finally(() => setBusyModel(null))
              }}
              onDeleteModel={(name) => {
                void window.notebro.whisper.deleteModel(name).then(setWhisper)
              }}
              onStartOllama={() => {
                void window.notebro.ollama
                  .start()
                  .then(setOllama)
                  .catch((error: Error) => setFatal(error.message))
              }}
              onPullOllama={(model) => {
                void window.notebro.ollama
                  .pull(model)
                  .then(setOllama)
                  .catch((error: Error) => setFatal(error.message))
              }}
              onRefresh={() => void refreshEngines()}
              onOpenScreenSettings={() =>
                void window.notebro.system.openScreenRecordingSettings()
              }
              onOpenMicSettings={() => void window.notebro.system.openMicrophoneSettings()}
              onOpenLog={() => void window.notebro.system.openLog()}
              onRestart={() => void window.notebro.system.restart()}
              onBack={() => setScreen('record')}
            />
          )}
        </div>
      </div>
    </div>
  )
}
