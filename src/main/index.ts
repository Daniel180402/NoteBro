import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { constants } from 'node:fs'
import { access, writeFile } from 'node:fs/promises'
import { BrowserWindow, app, dialog, ipcMain, session, shell } from 'electron'
import { handleAudioRequests, registerAudioScheme } from './audio-protocol'
import * as diarization from './diarization'
import { clearDraft, loadDraft, saveDraft } from './draft'
import type {
  DownloadProgress,
  ProcessProgress,
  Settings,
  SpeakerId,
  StartRecordingOptions
} from '@shared/types'
import { logLine, logPath } from './log'
import * as ollama from './ollama'
import { defaultNotesRoot, root, sessionDir } from './paths'
import * as pipeline from './pipeline'
import * as recorder from './recorder'
import * as storage from './storage'
import * as store from './store'
import * as sysaudio from './sysaudio'
import * as whisper from './whisper'

// Must run before anything resolves userData, which derives from the app name.
app.setName('NoteBro')
// Must run before the app is ready, or the scheme loses its streaming privilege.
registerAudioScheme()

let mainWindow: BrowserWindow | null = null
let processAbort: AbortController | null = null

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1115',
    title: 'NoteBro',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Links to documentation open in the real browser, never in the app frame.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function configureSession(): void {
  const current = session.defaultSession

  // The renderer only ever asks for the microphone and, on Windows, loopback.
  current.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture')
  })

  if (process.platform === 'win32') {
    // Windows exposes system audio through Chromium's loopback capture.
    current.setDisplayMediaRequestHandler(
      (_request, callback) => {
        void import('electron').then(({ desktopCapturer }) =>
          desktopCapturer
            .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
            .then((sources) => {
              if (sources.length === 0) {
                callback({})
                return
              }
              callback({ video: sources[0], audio: 'loopback' })
            })
            .catch(() => callback({}))
        )
      },
      { useSystemPicker: false }
    )
  }
}

function registerIpc(): void {
  ipcMain.handle('system:info', async () => ({
    platform: process.platform,
    capability: sysaudio.capability(),
    monitors: await sysaudio.listMonitors()
  }))
  ipcMain.handle('system:openScreenRecordingSettings', () => {
    sysaudio.openScreenRecordingSettings()
  })
  ipcMain.handle('system:openMicrophoneSettings', () => {
    sysaudio.openMicrophoneSettings()
  })
  ipcMain.handle('system:testSystemAudio', () => sysaudio.testSystemAudio())
  ipcMain.handle('system:openLog', () => {
    shell.showItemInFolder(logPath())
  })
  // The screen-recording permission only takes effect on the next launch, so
  // offer the restart instead of asking the user to do it by hand.
  ipcMain.handle('system:restart', () => {
    logLine('app', 'riavvio richiesto dall\'utente')
    app.relaunch()
    app.quit()
  })

  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_event, patch: Partial<Settings>) => store.setSettings(patch))

  ipcMain.handle('whisper:status', () => whisper.status())
  ipcMain.handle('whisper:download', async (_event, name: string) => {
    await whisper.downloadModel(name, (progress: DownloadProgress) =>
      send('whisper:download', progress)
    )
    return whisper.status()
  })
  ipcMain.handle('whisper:cancelDownload', (_event, name: string) => whisper.cancelDownload(name))
  ipcMain.handle('whisper:deleteModel', async (_event, name: string) => {
    await whisper.deleteModel(name)
    return whisper.status()
  })

  ipcMain.handle('diarization:status', () => diarization.status())
  ipcMain.handle('diarization:download', async () => {
    return diarization.downloadModels((progress) => send('diarization:download', progress))
  })
  ipcMain.handle('diarization:delete', () => diarization.deleteModels())

  ipcMain.handle('ollama:status', async () => {
    const settings = await store.getSettings()
    return ollama.status(settings.ollamaBaseUrl)
  })
  ipcMain.handle('ollama:start', async () => {
    const settings = await store.getSettings()
    return ollama.startServer(settings.ollamaBaseUrl)
  })
  ipcMain.handle('ollama:pull', async (_event, model: string) => {
    const settings = await store.getSettings()
    await ollama.pullModel(settings.ollamaBaseUrl, model, (progress) =>
      send('ollama:pull', progress)
    )
    return ollama.status(settings.ollamaBaseUrl)
  })

  ipcMain.handle('recorder:start', (_event, options: StartRecordingOptions) =>
    recorder.start(options, {
      onLevel: (stream, level) => send('recorder:level', { stream, level }),
      onWarning: (message) => send('recorder:warning', message),
      onLiveSegments: (segments) => send('live:segments', segments),
      onLiveStatus: (status) => send('live:status', status)
    })
  )
  ipcMain.on('recorder:pcm', (_event, speaker: SpeakerId, data: Uint8Array) => {
    void recorder.writePcm(speaker, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  })
  ipcMain.handle('recorder:pause', () => recorder.pause())
  ipcMain.handle('recorder:resume', () => recorder.resume())
  ipcMain.handle('recorder:stop', () => recorder.stop())
  ipcMain.handle('recorder:cancel', () => recorder.cancel())

  ipcMain.handle(
    'process:run',
    async (
      _event,
      options: {
        sessionId: string
        language: string
        whisperModel: string
        ollamaModel: string
        userNotes?: string
        template?: string
      }
    ) => {
      processAbort?.abort()
      processAbort = new AbortController()
      try {
        const result = await pipeline.run({
          ...options,
          signal: processAbort.signal,
          onProgress: (progress: ProcessProgress) => send('process:progress', progress)
        })
        // Persist it immediately: until the user files it, this is the only copy.
        await saveDraft(result)
        return result
      } finally {
        processAbort = null
      }
    }
  )
  ipcMain.handle('process:cancel', () => {
    processAbort?.abort()
  })

  ipcMain.handle('storage:report', async () => {
    const library = await store.getLibrary()
    return storage.report(library.notes.map((note) => store.noteDirFor(note.id)))
  })
  ipcMain.handle('storage:cleanSessions', async () => {
    const draft = await loadDraft()
    return storage.cleanSessions(draft?.sessionId)
  })
  ipcMain.handle('storage:compress', async () => {
    const pending = await store.notesToCompress()
    let freed = 0
    for (const [index, id] of pending.entries()) {
      send('storage:compress', { done: index, total: pending.length, freed })
      const result = await store.compressNoteAudio(id).catch((error: Error) => {
        logLine('compress', `nota ${id}: ${error.message}`)
        return null
      })
      if (result) freed += result.beforeBytes - result.afterBytes
    }
    send('storage:compress', { done: pending.length, total: pending.length, freed })
    return freed
  })

  ipcMain.handle('draft:get', () => loadDraft())
  ipcMain.handle('draft:clear', (_event, sessionId?: string) => {
    clearDraft()
    if (sessionId) recorder.discard(sessionId)
  })

  ipcMain.handle('library:load', () => store.getLibrary())
  ipcMain.handle('library:createFolder', (_event, name: string) => store.createFolder(name))
  ipcMain.handle('library:renameFolder', (_event, id: string, name: string) =>
    store.renameFolder(id, name)
  )
  ipcMain.handle('library:deleteFolder', (_event, id: string) => store.deleteFolder(id))
  ipcMain.handle(
    'ui:confirm',
    async (
      _event,
      input: { title: string; message: string; detail?: string; confirmLabel?: string }
    ) => {
      const options = {
        type: 'warning' as const,
        buttons: [input.confirmLabel ?? 'Elimina', 'Annulla'],
        defaultId: 1,
        cancelId: 1,
        title: input.title,
        message: input.message,
        detail: input.detail
      }
      const result = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options)
      return result.response === 0
    }
  )

  ipcMain.handle(
    'notes:save',
    async (
      _event,
      input: {
        sessionId: string
        title: string
        folderId: string | null
        language: string
        durationMs: number
        summary: string
        segments: Parameters<typeof store.saveNote>[0]['segments']
        models: { whisper: string; ollama: string }
        voiceNames?: Record<string, string>
        userNotes?: string
        template?: string
      }
    ) => {
      const settings = await store.getSettings()
      // After a restart the in-memory session is gone, but its files are not:
      // fall back to them so a restored draft still keeps its audio.
      const completed = recorder.getCompleted(input.sessionId)
      const directory = sessionDir(input.sessionId)
      const audio = settings.keepAudio
        ? {
            mix: join(directory, 'mix.wav'),
            channels:
              completed?.channels.map((channel) => channel.path) ??
              ['me', 'them']
                .map((speaker) => join(directory, `${speaker}.wav`))
                .filter((path) => existsSync(path))
          }
        : undefined

      const result = await store.saveNote({ ...input, audio })
      clearDraft()
      recorder.discard(input.sessionId)

      // Shrink the recording once it is safely filed, never before.
      if (result.note.hasAudio) {
        await store
          .compressNoteAudio(result.note.id)
          .catch((error: Error) =>
            logLine('compress', `nota ${result.note.id}: ${error.message}`)
          )
      }
      return { library: await store.getLibrary(), note: result.note }
    }
  )
  ipcMain.handle('notes:get', (_event, id: string) => store.getNote(id))
  ipcMain.handle(
    'notes:update',
    (
      _event,
      id: string,
      patch: {
        title?: string
        folderId?: string | null
        summary?: string
        voiceNames?: Record<string, string>
      }
    ) => store.updateNote(id, patch)
  )
  ipcMain.handle('notes:delete', (_event, id: string) => store.deleteNote(id))
  ipcMain.handle('notes:reveal', (_event, id: string) => {
    shell.showItemInFolder(join(store.noteDirFor(id), 'summary.md'))
  })
  ipcMain.handle('notes:defaultDirectory', () => defaultNotesRoot())
  ipcMain.handle('notes:chooseDirectory', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Cartella delle note',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    const chosen = result.canceled ? undefined : result.filePaths[0]
    if (!chosen) return { path: null }
    try {
      await access(chosen, constants.W_OK)
    } catch {
      return { path: null, error: 'NoteBro non può scrivere in quella cartella.' }
    }
    return { path: chosen }
  })
  ipcMain.handle('notes:reorganize', () => store.reorganizeNotes())
  ipcMain.handle(
    'notes:export',
    async (_event, input: { title: string; summary: string; transcript?: string }) => {
      const safeName = input.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'riassunto'
      const options = {
        title: 'Esporta riassunto',
        defaultPath: `${safeName}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      }
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { saved: false }
      const body = input.transcript
        ? `${input.summary}\n\n---\n\n## Trascrizione\n\n${input.transcript}\n`
        : input.summary
      await writeFile(result.filePath, body, 'utf8')
      return { saved: true, path: result.filePath }
    }
  )

  ipcMain.handle('session:discard', (_event, sessionId: string) => recorder.discard(sessionId))
}

/**
 * Runs the system-audio probe at startup when a flag file is present, writing
 * the outcome to the log.
 *
 * Capture depends on a macOS permission that can only be granted interactively,
 * so this makes the result reproducible without anyone having to click through
 * the interface: `touch "<userData>/selftest"`, launch the app, read the log.
 */
async function runSelfTestIfRequested(): Promise<void> {
  const flag = join(root(), 'selftest')
  if (!existsSync(flag)) return
  rmSync(flag, { force: true })
  logLine('selftest', 'autodiagnosi audio di sistema avviata')
  try {
    const result = await sysaudio.testSystemAudio()
    logLine(
      'selftest',
      `esito: ok=${result.ok} byte=${result.bytes} picco=${result.peak.toFixed(4)}` +
        (result.error ? ` errore=${result.error}` : '')
    )
  } catch (error) {
    logLine('selftest', `autodiagnosi fallita: ${(error as Error).message}`)
  }

  // A recording dropped in as selftest-diarize.wav is run through speaker
  // identification, which is the only way to exercise the native library the
  // way the packaged app actually loads it.
  const sample = join(root(), 'selftest-diarize.wav')
  const state = diarization.status()
  logLine(
    'selftest',
    `diarizzazione: libreria=${state.supported} modelli=${state.modelsInstalled}`
  )
  if (existsSync(sample) && state.supported && state.modelsInstalled) {
    try {
      const spans = await diarization.diarize({ wavPath: sample, numSpeakers: 0 })
      const voices = new Set(spans.map((span) => span.voice))
      logLine(
        'selftest',
        `diarizzazione campione: ${spans.length} intervalli, ${voices.size} voci`
      )
    } catch (error) {
      logLine('selftest', `diarizzazione campione fallita: ${(error as Error).message}`)
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    configureSession()
    handleAudioRequests()
    registerIpc()
    createWindow()
    void runSelfTestIfRequested()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    // Never leave a capture process or a half-written WAV behind.
    processAbort?.abort()
    void recorder.cancel()
  })
}
