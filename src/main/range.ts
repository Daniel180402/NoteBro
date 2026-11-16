export interface ByteRange {
  /** First byte to send, inclusive. */
  start: number
  /** Last byte to send, inclusive — as HTTP Content-Range expects. */
  end: number
}

/**
 * Parses a single `bytes=…` range header against a known file size.
 *
 * Only the single-range forms a media element actually sends are accepted;
 * anything else returns null and the caller answers with the whole file.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | null {
  if (!header || size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match

  if (rawStart === '') {
    // Suffix form `bytes=-N`: the last N bytes.
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return null
    return { start: Math.max(0, size - length), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return null
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isFinite(end) || end < start) return null
  return { start, end }
}
