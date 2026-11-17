import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { cp, copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { DEFAULT_TEMPLATE } from '@shared/templates'
import type { Folder, Library, Note, NoteMeta, Segment, Settings } from '@shared/types'
import { wavToWebm } from './compress'
import { logLine } from './log'
import { mixToMono } from './mixdown'
import { noteFolderName, uniqueName } from './naming'
import { defaultNotesRoot, legacyNoteDir, libraryFile, settingsFile } from './paths'

const DEFAULT_SETTINGS: Settings = {
  language: 'it',
  captureMic: true,
  captureSystem: true,
  micDeviceId: 'default',
  systemInputDeviceId: '',
  whisperModel: 'small',
  whisperBinaryPath: '',
  whisperThreads: 0,
  providers: [],
  defaultProviderId: '',
  speakerLabels: { me: 'Io', them: 'Interlocutore' },
  userName: '',
  vocabulary: '',
  template: DEFAULT_TEMPLATE,
  diarization: false,
  expectedSpeakers: 2,
  keepAudio: true,
  echoCancellation: true,
  noiseSuppression: true,
  liveTranscription: false,
  liveWhisperModel: '',
  reuseLiveTranscript: false,
  notesDirectory: '',
  noteNaming: 'title'
}

/** Writes via a temp file + rename so a crash can never truncate the library. */
async function writeAtomic(path: string, contents: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, contents, 'utf8')
  await rename(temp, path)
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Settings written before providers existed kept a single Ollama in two fields. */
interface LegacySettings {
  ollamaModel?: string
  ollamaBaseUrl?: string
}

export const LOCAL_OLLAMA_ID = 'ollama-locale'

function withProviders(stored: Partial<Settings> & LegacySettings): Pick<Settings, 'providers' | 'defaultProviderId'> {
  const providers =
    stored.providers && stored.providers.length > 0
      ? stored.providers
      : [
          {
            id: LOCAL_OLLAMA_ID,
            name: 'Ollama locale',
            kind: 'ollama' as const,
            baseUrl: stored.ollamaBaseUrl || 'http://127.0.0.1:11434',
            model: stored.ollamaModel ?? '',
            contextLength: 0,
            cliPath: ''
          }
        ]
  const defaultProviderId = providers.some((provider) => provider.id === stored.defaultProviderId)
    ? (stored.defaultProviderId as string)
    : providers[0].id
  return { providers, defaultProviderId }
}

export async function getSettings(): Promise<Settings> {
  const stored = await readJson<Partial<Settings> & LegacySettings>(settingsFile(), {})
  const { ollamaModel: _model, ollamaBaseUrl: _url, ...current } = stored
  return {
    ...DEFAULT_SETTINGS,
    ...current,
    ...withProviders(stored),
    speakerLabels: { ...DEFAULT_SETTINGS.speakerLabels, ...(stored.speakerLabels ?? {}) }
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  // Mirror the default Ollama into the fields older versions read, so going
  // back to one keeps the summary working.
  const fallback =
    next.providers.find((provider) => provider.id === next.defaultProviderId && provider.kind === 'ollama') ??
    next.providers.find((provider) => provider.kind === 'ollama')
  const legacy: LegacySettings = fallback ? { ollamaBaseUrl: fallback.baseUrl, ollamaModel: fallback.model } : {}
  await writeAtomic(settingsFile(), JSON.stringify({ ...next, ...legacy }, null, 2))
  return next
}

/** Note id → folder, so synchronous callers (the audio protocol) need no disk read. */
const dirCache = new Map<string, string>()
let dirCacheLoaded = false

function remember(library: Library): void {
  dirCache.clear()
  for (const note of library.notes) dirCache.set(note.id, note.dir ?? legacyNoteDir(note.id))
  dirCacheLoaded = true
}

export async function getLibrary(): Promise<Library> {
  const library = await readJson<Library>(libraryFile(), { folders: [], notes: [] })
  remember(library)
  return library
}

async function saveLibrary(library: Library): Promise<Library> {
  await writeAtomic(libraryFile(), JSON.stringify(library, null, 2))
  remember(library)
  return library
}

/** The folder of a saved note, wherever it was filed. */
export function noteDirFor(id: string): string {
  if (!dirCacheLoaded) {
    try {
      remember(JSON.parse(readFileSync(libraryFile(), 'utf8')) as Library)
    } catch {
      dirCacheLoaded = true
    }
  }
  return dirCache.get(id) ?? legacyNoteDir(id)
}

export function notesRoot(settings: Settings): string {
  const custom = settings.notesDirectory.trim()
  return custom ? resolve(custom) : defaultNotesRoot()
}

/**
 * A free folder for a note titled `title`, under the configured root and
 * named by the configured convention. `current` counts as free, so a note can
 * keep its own name.
 */
async function allocateNoteDir(title: string, current?: string): Promise<string> {
  const settings = await getSettings()
  const parent = notesRoot(settings)
  mkdirSync(parent, { recursive: true })
  const name = uniqueName(noteFolderName(title, settings.noteNaming), settings.noteNaming, (candidate) => {
    const path = join(parent, candidate)
    return path !== current && existsSync(path)
  })
  return join(parent, name)
}

/** rename(), or copy-then-delete when the target is on another disk. */
async function moveDir(from: string, to: string): Promise<void> {
  mkdirSync(dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, errorOnExist: true, force: false })
    await rm(from, { recursive: true, force: true })
  }
}

/** Refuses to touch anything that is not plainly a single note's folder. */
function isNoteFolder(dir: string, roots: string[]): boolean {
  const settingsRoots = [defaultNotesRoot(), ...roots]
  return (
    basename(dir).length > 0 &&
    dirname(dir) !== dir &&
    !settingsRoots.includes(dir) &&
    existsSync(join(dir, 'summary.md'))
  )
}

/**
 * Moves every note into the configured folder and renames it by the configured
 * convention. Notes already in place are left alone.
 */
export async function reorganizeNotes(): Promise<{ library: Library; moved: number; failed: string[] }> {
  const library = await getLibrary()
  let moved = 0
  const failed: string[] = []
  for (const note of library.notes) {
    const current = note.dir ?? legacyNoteDir(note.id)
    if (!existsSync(current)) continue
    const target = await allocateNoteDir(note.title, current)
    if (target === current) {
      note.dir = current
      continue
    }
    try {
      await moveDir(current, target)
      note.dir = target
      moved += 1
      // Persist after each move, so an interruption never loses track of a note.
      await saveLibrary(library)
    } catch (error) {
      logLine('store', `spostamento di "${note.title}" fallito: ${(error as Error).message}`)
      failed.push(note.title)
    }
  }
  return { library: await saveLibrary(library), moved, failed }
}

export async function createFolder(
  name: string
): Promise<{ library: Library; folderId: string }> {
  const library = await getLibrary()
  const folder: Folder = {
    id: randomUUID(),
    name: name.trim() || 'Nuova cartella',
    createdAt: Date.now()
  }
  library.folders.push(folder)
  return { library: await saveLibrary(library), folderId: folder.id }
}

export async function renameFolder(id: string, name: string): Promise<Library> {
  const library = await getLibrary()
  const folder = library.folders.find((item) => item.id === id)
  if (folder) folder.name = name.trim() || folder.name
  return saveLibrary(library)
}

/** Deletes a folder; its notes move back to the uncategorised root. */
export async function deleteFolder(id: string): Promise<Library> {
  const library = await getLibrary()
  library.folders = library.folders.filter((folder) => folder.id !== id)
  for (const note of library.notes) if (note.folderId === id) note.folderId = null
  return saveLibrary(library)
}

export interface SaveNoteInput {
  title: string
  folderId: string | null
  language: string
  durationMs: number
  summary: string
  segments: Segment[]
  models: { whisper: string; ollama: string; provider?: string }
  /** Names given to the detected remote voices, keyed by voice index. */
  voiceNames?: Record<string, string>
  userNotes?: string
  template?: string
  /** Recording audio to adopt, if the user chose to keep it. */
  audio?: {
    /** A ready-made mix produced during processing; preferred when present. */
    mix?: string
    /** Per-speaker recordings, mixed on the spot if there is no `mix`. */
    channels: string[]
  }
}

function excerptOf(summary: string): string {
  return summary
    .replace(/[#*_`>-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

export async function saveNote(input: SaveNoteInput): Promise<{ library: Library; note: Note }> {
  const id = randomUUID()
  const dir = await allocateNoteDir(input.title.trim() || 'Senza titolo')
  mkdirSync(dir, { recursive: true })
  const speakers = [...new Set(input.segments.map((segment) => segment.speaker))]

  await writeFile(join(dir, 'summary.md'), input.summary, 'utf8')
  await writeFile(join(dir, 'transcript.json'), JSON.stringify(input.segments, null, 2), 'utf8')

  // One mixed file plays back the conversation as it was heard, and costs a
  // third of the space of keeping both channels plus a mix.
  let hasAudio = false
  const destination = join(dir, 'audio.wav')
  if (input.audio?.mix && existsSync(input.audio.mix)) {
    hasAudio = await copyFile(input.audio.mix, destination).then(
      () => true,
      () => false
    )
  } else if (input.audio && input.audio.channels.length > 0) {
    hasAudio = await mixToMono(input.audio.channels, destination).catch(() => false)
  }

  const meta: NoteMeta = {
    id,
    dir,
    folderId: input.folderId,
    title: input.title.trim() || 'Senza titolo',
    language: input.language,
    createdAt: Date.now(),
    durationMs: input.durationMs,
    excerpt: excerptOf(input.summary),
    speakers,
    models: input.models,
    hasAudio,
    audioFormat: hasAudio ? 'wav' : undefined,
    voiceNames: input.voiceNames,
    userNotes: input.userNotes,
    template: input.template
  }

  const library = await getLibrary()
  library.notes.unshift(meta)
  await saveLibrary(library)
  return { library, note: { ...meta, summary: input.summary, segments: input.segments } }
}

/**
 * Converts a note's recording to Opus, freeing roughly nine tenths of its size.
 * Returns null when there is nothing left to convert.
 */
export async function compressNoteAudio(
  id: string
): Promise<{ beforeBytes: number; afterBytes: number } | null> {
  const dir = noteDirFor(id)
  const wav = join(dir, 'audio.wav')
  if (!existsSync(wav)) return null

  const result = await wavToWebm(wav, join(dir, 'audio.webm'))
  logLine(
    'compress',
    `nota ${id}: ${(result.beforeBytes / 1048576).toFixed(1)} MB -> ${(result.afterBytes / 1048576).toFixed(2)} MB`
  )
  const library = await getLibrary()
  const meta = library.notes.find((note) => note.id === id)
  if (meta) {
    meta.audioFormat = 'webm'
    await saveLibrary(library)
  }
  return result
}

/** Notes still holding an uncompressed recording. */
export async function notesToCompress(): Promise<string[]> {
  const library = await getLibrary()
  return library.notes
    .filter((note) => note.hasAudio && existsSync(join(noteDirFor(note.id), 'audio.wav')))
    .map((note) => note.id)
}

export async function getNote(id: string): Promise<Note | null> {
  const library = await getLibrary()
  const meta = library.notes.find((note) => note.id === id)
  if (!meta) return null
  const dir = noteDirFor(id)
  const summary = await readFile(join(dir, 'summary.md'), 'utf8').catch(() => '')
  const segments = await readJson<Segment[]>(join(dir, 'transcript.json'), [])
  return { ...meta, summary, segments }
}

export async function updateNote(
  id: string,
  patch: {
    title?: string
    folderId?: string | null
    summary?: string
    voiceNames?: Record<string, string>
  }
): Promise<Library> {
  const library = await getLibrary()
  const meta = library.notes.find((note) => note.id === id)
  if (!meta) return library
  if (patch.title !== undefined) {
    const title = patch.title.trim() || meta.title
    // Keep the folder name in step with the title, for notes filed by name.
    if (title !== meta.title && meta.dir && existsSync(meta.dir)) {
      const target = await allocateNoteDir(title, meta.dir)
      if (dirname(target) === dirname(meta.dir) && target !== meta.dir) {
        await moveDir(meta.dir, target).then(
          () => {
            meta.dir = target
          },
          (error: Error) => logLine('store', `rinomina della cartella fallita: ${error.message}`)
        )
      }
    }
    meta.title = title
  }
  if (patch.folderId !== undefined) meta.folderId = patch.folderId
  if (patch.voiceNames !== undefined) meta.voiceNames = patch.voiceNames
  if (patch.summary !== undefined) {
    await writeFile(join(noteDirFor(id), 'summary.md'), patch.summary, 'utf8')
    meta.excerpt = excerptOf(patch.summary)
  }
  return saveLibrary(library)
}

export async function deleteNote(id: string): Promise<Library> {
  const library = await getLibrary()
  library.notes = library.notes.filter((note) => note.id !== id)
  const dir = noteDirFor(id)
  if (existsSync(dir) && isNoteFolder(dir, [notesRoot(await getSettings())])) rmSync(dir, { recursive: true, force: true })
  return saveLibrary(library)
}

export { DEFAULT_SETTINGS }
