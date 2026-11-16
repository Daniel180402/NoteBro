import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { noteDir, sessionDir } from './paths'
import { parseRange } from './range'

export const AUDIO_SCHEME = 'notebro-audio'

/**
 * Must run before the app is ready: marks the scheme as streaming, which is
 * what lets an <audio> element issue range requests and therefore seek.
 */
export function registerAudioScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: AUDIO_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

interface Resolved {
  path: string
  contentType: string
}

/**
 * notebro-audio://note/<id> and notebro-audio://session/<id>.
 *
 * Saved recordings are compressed to WebM/Opus; the uncompressed WAV is still
 * accepted so notes written before that, or not yet converted, keep playing.
 */
function resolve(url: URL): Resolved | null {
  const id = url.pathname.replace(/^\/+/, '')
  // Ids are generated with randomUUID; refuse anything else, so a crafted URL
  // can never walk out of the data directory.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null

  const candidates =
    url.hostname === 'note'
      ? [
          { path: join(noteDir(id), 'audio.webm'), contentType: 'audio/webm' },
          { path: join(noteDir(id), 'audio.wav'), contentType: 'audio/wav' }
        ]
      : url.hostname === 'session'
        ? [{ path: join(sessionDir(id), 'mix.wav'), contentType: 'audio/wav' }]
        : []

  return candidates.find((candidate) => existsSync(candidate.path)) ?? null
}

function body(path: string, start: number, end: number): ReadableStream {
  return Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
}

export function handleAudioRequests(): void {
  protocol.handle(AUDIO_SCHEME, async (request) => {
    const found = resolve(new URL(request.url))
    if (!found) return new Response('Not found', { status: 404 })

    const { path, contentType } = found
    const size = statSync(path).size
    const common = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' }

    // Serving ranges ourselves keeps seeking instant on a long recording, which
    // would otherwise have to be fetched from the start every time.
    const range = parseRange(request.headers.get('Range'), size)
    if (!range) {
      return new Response(body(path, 0, size - 1), {
        status: 200,
        headers: { ...common, 'Content-Length': String(size) }
      })
    }

    return new Response(body(path, range.start, range.end), {
      status: 206,
      headers: {
        ...common,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`
      }
    })
  })
}
