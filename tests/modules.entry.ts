// Re-exports the dependency-free parts of the main process so the test runner
// can bundle them with esbuild and exercise the real implementations.
export { WavWriter, voicedWindow } from '../src/main/wav'
export { parseWhisperSegments, buildDialogue, assignVoices } from '../src/main/transcript'
export { speakerName, voicesIn } from '../src/shared/speakers'
export { mixToMono } from '../src/main/mixdown'
export { parseRange } from '../src/main/range'
export { wavToWebm } from '../src/main/compress'
export * as ollama from '../src/main/ollama'
export * as pulse from '../src/main/pulse'
