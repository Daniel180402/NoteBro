import type { Segment, SpeakerId } from '@shared/types'
import { voicedWindow } from './wav'

/** Same speaker, separated by less than this, reads better as one turn. */
const COALESCE_GAP_MS = 1200
const COALESCE_MAX_CHARS = 400
/** Bracketed non-speech markers whisper emits instead of staying silent. */
const NON_SPEECH = /^[\s\p{P}]*[[(（][^\])）]*[\])）][\s\p{P}]*$/u
/** A real utterance occupies at least this many 100 ms buckets of energy. */
const MIN_VOICED_BUCKETS = 3

export interface WhisperJson {
  transcription?: Array<{
    offsets?: { from?: number; to?: number }
    text?: string
  }>
}

/**
 * Turns whisper.cpp JSON into segments placed on the real timeline.
 *
 * whisper reports segment boundaries rather than speech onsets: on a channel
 * that stayed quiet while the other person talked, a segment typically begins
 * where the previous one ended, not where the voice does. Snapping each
 * segment onto the channel's recorded energy profile fixes the placement — and
 * therefore the order once both channels are interleaved — while dropping the
 * filler whisper invents over silence.
 */
export function parseWhisperSegments(
  parsed: WhisperJson,
  speaker: SpeakerId,
  energyProfile: number[],
  peak: number
): Segment[] {
  const threshold = Math.max(0.006, peak * 0.03)
  const segments: Segment[] = []

  for (const entry of parsed.transcription ?? []) {
    const text = (entry.text ?? '').trim()
    if (!text || NON_SPEECH.test(text)) continue

    const window = voicedWindow(
      energyProfile,
      entry.offsets?.from ?? 0,
      entry.offsets?.to ?? 0,
      threshold
    )
    if (!window || window.buckets < MIN_VOICED_BUCKETS) continue

    segments.push({ from: window.from, to: window.to, speaker, text })
  }

  return segments
}

/**
 * Interleaves the per-channel transcripts into a single dialogue and joins
 * consecutive segments from the same speaker into readable turns.
 */
export function buildDialogue(segments: Segment[]): Segment[] {
  const ordered = [...segments].sort((a, b) => a.from - b.from || a.to - b.to)
  const result: Segment[] = []

  for (const segment of ordered) {
    const previous = result[result.length - 1]
    if (
      previous &&
      previous.speaker === segment.speaker &&
      // Two different people on the far side must never become one turn.
      previous.voice === segment.voice &&
      segment.from - previous.to <= COALESCE_GAP_MS &&
      previous.text.length + segment.text.length <= COALESCE_MAX_CHARS
    ) {
      previous.text = `${previous.text} ${segment.text}`.replace(/\s+/g, ' ').trim()
      previous.to = Math.max(previous.to, segment.to)
    } else {
      result.push({ ...segment })
    }
  }

  return result
}

export interface VoiceSpan {
  /** Seconds. */
  start: number
  end: number
  voice: number
}

/**
 * Labels each remote turn with the voice that spoke it.
 *
 * Diarization segments the audio on its own boundaries, which rarely line up
 * with whisper's, so every turn takes the voice it overlaps with most. Voices
 * are then renumbered in order of first appearance: the clustering hands back
 * arbitrary ids like 0, 3, 7, and "Interlocutore 1, 2, 3" reads better.
 *
 * A turn that overlaps nothing keeps no voice at all and stays the plain
 * "Interlocutore", which is honest about not knowing.
 */
/**
 * Share of remote speech below which a cluster is treated as noise.
 *
 * On a real meeting, automatic clustering produced four voices holding 96% of
 * the talking and eight more splinters sharing the remaining 4% — fragments of
 * the same people, not extra participants. Dropping them keeps the speaker list
 * honest.
 */
const MIN_VOICE_SHARE = 0.03

/** Removes clusters too small to be a participant. */
function significantSpans(spans: VoiceSpan[]): VoiceSpan[] {
  const duration = new Map<number, number>()
  let total = 0
  for (const span of spans) {
    const length = Math.max(0, span.end - span.start)
    duration.set(span.voice, (duration.get(span.voice) ?? 0) + length)
    total += length
  }
  if (total <= 0) return spans

  const kept = [...duration.entries()].filter(([, length]) => length / total >= MIN_VOICE_SHARE)
  // Never filter everything away: the loudest voice always survives.
  if (kept.length === 0) {
    const loudest = [...duration.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    return spans.filter((span) => span.voice === loudest)
  }
  const keepSet = new Set(kept.map(([voice]) => voice))
  return spans.filter((span) => keepSet.has(span.voice))
}

export function assignVoices(segments: Segment[], rawSpans: VoiceSpan[]): Segment[] {
  if (rawSpans.length === 0) return segments
  const spans = significantSpans(rawSpans)

  const renumbered = new Map<number, number>()
  const result = segments.map((segment) => {
    if (segment.speaker !== 'them') return segment

    let best: { voice: number; overlap: number } | null = null
    for (const span of spans) {
      const overlap =
        Math.min(segment.to, span.end * 1000) - Math.max(segment.from, span.start * 1000)
      if (overlap > 0 && (!best || overlap > best.overlap)) {
        best = { voice: span.voice, overlap }
      }
    }
    if (!best) return segment

    if (!renumbered.has(best.voice)) renumbered.set(best.voice, renumbered.size)
    return { ...segment, voice: renumbered.get(best.voice) }
  })

  // A single voice adds nothing over the plain label, so drop the numbering.
  if (renumbered.size <= 1) {
    return result.map(({ voice: _voice, ...segment }) => segment)
  }
  return result
}
