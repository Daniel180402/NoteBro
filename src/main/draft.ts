import { existsSync, rmSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProcessResult } from '@shared/types'
import { logLine } from './log'
import { root } from './paths'

function draftFile(): string {
  return join(root(), 'draft.json')
}

/**
 * Keeps the finished summary that has not been filed yet.
 *
 * Until the user gives it a name and a folder it exists nowhere else, so
 * navigating away — or quitting — would otherwise destroy a recording that
 * took minutes to transcribe. Writing it down makes leaving the screen
 * harmless.
 */
export async function saveDraft(result: ProcessResult): Promise<void> {
  try {
    const temp = `${draftFile()}.tmp`
    await writeFile(temp, JSON.stringify(result), 'utf8')
    await rename(temp, draftFile())
    logLine('draft', `bozza salvata per la sessione ${result.sessionId}`)
  } catch (error) {
    logLine('draft', `salvataggio bozza fallito: ${(error as Error).message}`)
  }
}

export async function loadDraft(): Promise<ProcessResult | null> {
  try {
    if (!existsSync(draftFile())) return null
    const draft = JSON.parse(await readFile(draftFile(), 'utf8')) as ProcessResult
    logLine('draft', `bozza ripristinata: "${draft.title}" (${draft.segments.length} turni)`)
    return draft
  } catch (error) {
    logLine('draft', `bozza illeggibile, ignorata: ${(error as Error).message}`)
    return null
  }
}

export function clearDraft(): void {
  try {
    rmSync(draftFile(), { force: true })
  } catch {
    // Nothing to clear.
  }
}
