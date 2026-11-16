import { useEffect, useMemo, useRef } from 'react'
import { speakerName } from '@shared/speakers'
import type { Segment, Settings } from '@shared/types'
import { timecode } from '../format'

interface TranscriptProps {
  segments: Segment[]
  labels: Settings['speakerLabels']
  /** Provided when there is audio: makes each turn jump to its moment. */
  onSeek?: (seconds: number) => void
  /** Playback position, used to highlight the turn being heard. */
  currentTimeMs?: number
  /** Scroll the highlighted turn into view (only while actually playing). */
  follow?: boolean
  /** Names given to the detected remote voices. */
  voiceNames?: Record<string, string>
}

/**
 * Index of the turn being heard: the last one that has started. Keeping it
 * during the silence after a turn stops the highlight flickering off in gaps.
 */
function activeIndex(segments: Segment[], timeMs: number | undefined): number {
  if (timeMs === undefined) return -1
  let found = -1
  for (const [index, segment] of segments.entries()) {
    if (segment.from <= timeMs) found = index
    else break
  }
  return found
}

export function Transcript({
  segments,
  labels,
  onSeek,
  currentTimeMs,
  follow,
  voiceNames
}: TranscriptProps): React.JSX.Element {
  const active = useMemo(() => activeIndex(segments, currentTimeMs), [segments, currentTimeMs])
  const activeRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (follow && activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [active, follow])

  if (segments.length === 0) {
    return <p className="faint">Nessuna trascrizione disponibile.</p>
  }

  return (
    <div className="transcript">
      {segments.map((segment, index) => {
        // Each remote voice gets its own colour, cycling after a handful.
        const voiceClass =
          segment.speaker === 'them' && segment.voice !== undefined
            ? ` turn--voice-${segment.voice % 5}`
            : ''
        const className = `turn turn--${segment.speaker}${voiceClass}${
          index === active ? ' turn--active' : ''
        }${onSeek ? ' turn--seekable' : ''}`
        const body = (
          <>
            <span className="turn__time">{timecode(segment.from)}</span>
            <span>
              <span className="turn__speaker">
                {speakerName(segment, labels, voiceNames)}:
              </span>
              {segment.text}
            </span>
          </>
        )

        if (!onSeek) {
          return (
            <div
              key={`${segment.from}-${index}`}
              className={className}
              ref={index === active ? (node) => { activeRef.current = node } : undefined}
            >
              {body}
            </div>
          )
        }

        return (
          <button
            key={`${segment.from}-${index}`}
            type="button"
            className={className}
            title={`Riproduci da ${timecode(segment.from)}`}
            onClick={() => onSeek(segment.from / 1000)}
            ref={index === active ? (node) => { activeRef.current = node } : undefined}
          >
            {body}
          </button>
        )
      })}
    </div>
  )
}
