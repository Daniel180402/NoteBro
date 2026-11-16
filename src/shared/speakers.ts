import type { Segment, Settings } from './types'

/**
 * Display name for whoever said a turn.
 *
 * The far side is one anonymous "Interlocutore" until diarization tells the
 * voices apart; after that each voice gets a number, or the name the user typed
 * for it.
 */
export function speakerName(
  segment: Pick<Segment, 'speaker' | 'voice'>,
  labels: Settings['speakerLabels'],
  voiceNames?: Record<string, string>
): string {
  if (segment.speaker === 'me') return labels.me
  if (segment.voice === undefined) return labels.them
  const custom = voiceNames?.[String(segment.voice)]?.trim()
  return custom || `${labels.them} ${segment.voice + 1}`
}

/** Remote voice indices present in a transcript, in order of first appearance. */
export function voicesIn(segments: Segment[]): number[] {
  const seen: number[] = []
  for (const segment of segments) {
    if (segment.speaker === 'them' && segment.voice !== undefined && !seen.includes(segment.voice)) {
      seen.push(segment.voice)
    }
  }
  return seen
}
