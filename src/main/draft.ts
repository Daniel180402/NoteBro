import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProcessResult } from '@shared/types'
import { logLine } from './log'
import { root } from './paths'

/** Where the single draft lived before several could wait at once. */
function legacyDraftFile(): string {
  return join(root(), 'draft.json')
}

function draftsDir(): string {
  return join(root(), 'drafts')
}

/** Session ids are randomUUID(); anything else never becomes a path. */
function draftFile(sessionId: string): string | null {
  return /^[0-9a-f-]{36}$/i.test(sessionId) ? join(draftsDir(), `${sessionId}.json`) : null
}

/**
 * Keeps the finished summaries that have not been filed yet, one file each.
 *
 * Until the user gives one a name and a folder it exists nowhere else, so
 * navigating away — or quitting — would otherwise destroy a recording that
 * took minutes to transcribe. A second recording can finish while the first
 * is still unfiled, so each session keeps its own draft.
 */
export async function saveDraft(result: ProcessResult): Promise<void> {
  const file = draftFile(result.sessionId)
  if (!file) return
  try {
    mkdirSync(draftsDir(), { recursive: true })
    const temp = `${file}.tmp`
    await writeFile(temp, JSON.stringify(result), 'utf8')
    await rename(temp, file)
    logLine('draft', `bozza salvata per la sessione ${result.sessionId}`)
  } catch (error) {
    logLine('draft', `salvataggio bozza fallito: ${(error as Error).message}`)
  }
}

async function readDraft(path: string): Promise<ProcessResult | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ProcessResult
  } catch (error) {
    logLine('draft', `bozza illeggibile, ignorata: ${(error as Error).message}`)
    return null
  }
}

/** Every unfiled summary, oldest first. */
export async function loadDrafts(): Promise<ProcessResult[]> {
  // Adopt the old single draft, so an update never loses one.
  if (existsSync(legacyDraftFile())) {
    const legacy = await readDraft(legacyDraftFile())
    if (legacy) await saveDraft(legacy)
    rmSync(legacyDraftFile(), { force: true })
  }
  if (!existsSync(draftsDir())) return []
  const drafts: Array<{ draft: ProcessResult; writtenAt: number }> = []
  for (const entry of readdirSync(draftsDir())) {
    if (!entry.endsWith('.json')) continue
    const path = join(draftsDir(), entry)
    const draft = await readDraft(path)
    if (draft) drafts.push({ draft, writtenAt: statSync(path).mtimeMs })
  }
  const sorted = drafts.sort((a, b) => a.writtenAt - b.writtenAt).map((item) => item.draft)
  for (const draft of sorted) {
    logLine('draft', `bozza ripristinata: "${draft.title}" (${draft.segments.length} turni)`)
  }
  return sorted
}

export function clearDraft(sessionId: string): void {
  const file = draftFile(sessionId)
  if (!file) return
  try {
    rmSync(file, { force: true })
  } catch {
    // Nothing to clear.
  }
}
