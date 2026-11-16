/**
 * Speaker diarization, in its own process.
 *
 * sherpa-onnx's `process()` is a synchronous, CPU-bound call: on a half-hour
 * recording it runs for minutes. Doing that in the main process would freeze
 * the window, so this script runs as an Electron utilityProcess and reports the
 * result back over the port.
 */
import { readFile } from 'node:fs/promises'
import { OfflineSpeakerDiarization } from 'sherpa-onnx-node'

const WAV_HEADER_BYTES = 44

export interface DiarizeRequest {
  wavPath: string
  segmentationModel: string
  embeddingModel: string
  /** Number of people on the far side, or -1 to let the clustering decide. */
  numSpeakers: number
  threshold: number
  threads: number
}

export interface DiarizeResponse {
  ok: boolean
  segments?: Array<{ start: number; end: number; speaker: number }>
  error?: string
}

async function readSamples(path: string): Promise<Float32Array> {
  const file = await readFile(path)
  const pcm = file.subarray(WAV_HEADER_BYTES)
  const samples = new Float32Array(Math.floor(pcm.length / 2))
  for (let i = 0; i < samples.length; i += 1) samples[i] = pcm.readInt16LE(i * 2) / 32768
  return samples
}

async function run(request: DiarizeRequest): Promise<DiarizeResponse> {
  try {
    const samples = await readSamples(request.wavPath)
    if (samples.length === 0) return { ok: true, segments: [] }

    const diarization = new OfflineSpeakerDiarization({
      segmentation: {
        pyannote: { model: request.segmentationModel },
        numThreads: request.threads,
        debug: 0,
        provider: 'cpu'
      },
      embedding: {
        model: request.embeddingModel,
        numThreads: request.threads,
        debug: 0,
        provider: 'cpu'
      },
      clustering:
        request.numSpeakers > 0
          ? { numClusters: request.numSpeakers }
          : { numClusters: -1, threshold: request.threshold },
      minDurationOn: 0.3,
      minDurationOff: 0.5
    })

    return { ok: true, segments: diarization.process(samples) }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

process.parentPort.on('message', (event) => {
  void run(event.data as DiarizeRequest).then((response) => {
    process.parentPort.postMessage(response)
  })
})
