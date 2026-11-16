import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** Creates the directory (and parents) if needed and returns it. */
function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export const root = (): string => ensure(app.getPath('userData'))

/** Whisper GGML models, downloaded on demand. */
export const modelsDir = (): string => ensure(join(root(), 'models'))

/** Raw audio of an in-flight recording. */
export const sessionDir = (sessionId: string): string =>
  ensure(join(root(), 'sessions', sessionId))

/** Everything belonging to a saved note. */
export const noteDir = (noteId: string): string => ensure(join(root(), 'notes', noteId))

export const libraryFile = (): string => join(root(), 'library.json')
export const settingsFile = (): string => join(root(), 'settings.json')

/** Directory holding the bundled native helpers, in dev and when packaged. */
export const binDir = (): string =>
  app.isPackaged ? join(process.resourcesPath, 'bin') : join(app.getAppPath(), 'resources', 'bin')
