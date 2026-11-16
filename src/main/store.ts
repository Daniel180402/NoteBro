import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_TEMPLATE } from '@shared/templates'
import type { Folder, Library, Note, NoteMeta, Segment, Settings } from '@shared/types'
import { wavToWebm } from './compress'
import { logLine } from './log'
import { mixToMono } from './mixdown'
import { libraryFile, noteDir, settingsFile } from './paths'

const DEFAULT_SETTINGS: Settings = {
  language: 'it',
  captureMic: true,
  captureSystem: true,
  micDeviceId: 'default',
  systemInputDeviceId: '',
  whisperModel: 'small',
  whisperBinaryPath: '',
  whisperThreads: 0,
  ollamaModel: '',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  speakerLabels: { me: 'Io', them: 'Interlocutore' },
  userName: '',
  vocabulary: '',
  template: DEFAULT_TEMPLATE,
  diarization: false,
  expectedSpeakers: 2,
  keepAudio: true,
  echoCancellation: true,
  noiseSuppression: true
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

export async function getSettings(): Promise<Settings> {
  const stored = await readJson<Partial<Settings>>(settingsFile(), {})
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    speakerLabels: { ...DEFAULT_SETTINGS.speakerLabels, ...(stored.speakerLabels ?? {}) }
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await writeAtomic(settingsFile(), JSON.stringify(next, null, 2))
  return next
}

export async function getLibrary(): Promise<Library> {
  return readJson<Library>(libraryFile(), { folders: [], notes: [] })
}

async function saveLibrary(library: Library): Promise<Library> {
  await writeAtomic(libraryFile(), JSON.stringify(library, null, 2))
  return library
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
  models: { whisper: string; ollama: string }
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
  const dir = noteDir(id)
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
  const dir = noteDir(id)
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
    .filter((note) => note.hasAudio && existsSync(join(noteDir(note.id), 'audio.wav')))
    .map((note) => note.id)
}

export async function getNote(id: string): Promise<Note | null> {
  const library = await getLibrary()
  const meta = library.notes.find((note) => note.id === id)
  if (!meta) return null
  const dir = noteDir(id)
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
  if (patch.title !== undefined) meta.title = patch.title.trim() || meta.title
  if (patch.folderId !== undefined) meta.folderId = patch.folderId
  if (patch.voiceNames !== undefined) meta.voiceNames = patch.voiceNames
  if (patch.summary !== undefined) {
    await writeFile(join(noteDir(id), 'summary.md'), patch.summary, 'utf8')
    meta.excerpt = excerptOf(patch.summary)
  }
  return saveLibrary(library)
}

export async function deleteNote(id: string): Promise<Library> {
  const library = await getLibrary()
  library.notes = library.notes.filter((note) => note.id !== id)
  const dir = join(noteDir(id))
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  return saveLibrary(library)
}

export { DEFAULT_SETTINGS }
