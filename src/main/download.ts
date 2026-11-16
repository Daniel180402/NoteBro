import { createWriteStream } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface DownloadReport {
  receivedBytes: number
  totalBytes: number
}

/**
 * Streams a file to disk through a temporary name, so an interrupted download
 * can never be mistaken for a complete model.
 */
export async function downloadFile(
  url: string,
  target: string,
  onProgress: (report: DownloadReport) => void,
  signal?: AbortSignal
): Promise<void> {
  const partial = `${target}.part`
  try {
    const response = await fetch(url, { signal })
    if (!response.ok || !response.body) {
      throw new Error(`Download fallito (HTTP ${response.status}).`)
    }

    const totalBytes = Number(response.headers.get('content-length') ?? 0)
    let receivedBytes = 0
    let lastReport = 0

    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length
      const now = Date.now()
      if (now - lastReport > 200) {
        lastReport = now
        onProgress({ receivedBytes, totalBytes })
      }
    })

    await pipeline(source, createWriteStream(partial))
    await rename(partial, target)
    onProgress({ receivedBytes, totalBytes })
  } catch (error) {
    await unlink(partial).catch(() => undefined)
    throw error instanceof Error ? error : new Error(String(error))
  }
}
