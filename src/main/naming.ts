/**
 * Folder names for saved notes. Dependency-free so the test runner can bundle it.
 */
import type { NoteNaming } from '@shared/types'

const MAX_LENGTH = 80

/** Characters no common filesystem accepts in a name (Windows is the strictest). */
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g

/** Names Windows reserves, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

function clip(name: string, separator: string): string {
  if (name.length <= MAX_LENGTH) return name
  const cut = name.slice(0, MAX_LENGTH)
  // Prefer ending on a whole word.
  const lastBreak = cut.lastIndexOf(separator)
  return (lastBreak > MAX_LENGTH / 2 ? cut.slice(0, lastBreak) : cut).replace(/[\s._-]+$/, '')
}

/**
 * "Riunione con Marco: budget 2027" becomes
 *   title → "Riunione con Marco budget 2027"
 *   snake → "riunione_con_marco_budget_2027"
 */
export function noteFolderName(title: string, style: NoteNaming): string {
  const base = title.normalize('NFC').trim()
  let name: string
  if (style === 'snake') {
    name = base
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '')
    name = clip(name, '_')
  } else {
    name = base
      .replace(FORBIDDEN, ' ')
      .replace(/\s+/g, ' ')
      // A trailing dot or space is silently dropped by Windows.
      .replace(/^[\s.]+|[\s.]+$/g, '')
    name = clip(name, ' ')
  }
  if (!name || RESERVED.test(name)) name = style === 'snake' ? 'senza_titolo' : 'Senza titolo'
  return name
}

/** Appends " (2)" or "_2" until the name is free. */
export function uniqueName(base: string, style: NoteNaming, taken: (name: string) => boolean): string {
  if (!taken(base)) return base
  for (let counter = 2; ; counter += 1) {
    const candidate = style === 'snake' ? `${base}_${counter}` : `${base} (${counter})`
    if (!taken(candidate)) return candidate
  }
}
