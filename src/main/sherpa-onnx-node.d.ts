/** Minimal typings for the parts of sherpa-onnx-node this app uses. */
declare module 'sherpa-onnx-node' {
  export interface DiarizationSegment {
    start: number
    end: number
    speaker: number
  }

  export interface DiarizationConfig {
    segmentation: {
      pyannote: { model: string }
      numThreads?: number
      debug?: number
      provider?: string
    }
    embedding: {
      model: string
      numThreads?: number
      debug?: number
      provider?: string
    }
    clustering: { numClusters: number; threshold?: number }
    minDurationOn?: number
    minDurationOff?: number
  }

  export class OfflineSpeakerDiarization {
    constructor(config: DiarizationConfig)
    readonly sampleRate: number
    /** Blocking: run it off the main process. */
    process(samples: Float32Array): DiarizationSegment[]
  }
}
