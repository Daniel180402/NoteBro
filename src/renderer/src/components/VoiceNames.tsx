import { speakerName, voicesIn } from '@shared/speakers'
import type { Segment, Settings } from '@shared/types'
import { timecode } from '../format'

interface VoiceNamesProps {
  segments: Segment[]
  labels: Settings['speakerLabels']
  voiceNames: Record<string, string>
  onChange: (voiceNames: Record<string, string>) => void
  /** When the recording is available, jump to where this voice first speaks. */
  onSeek?: (seconds: number) => void
}

/**
 * Lets the user put a name to each voice the diarization found.
 *
 * Clustering can only say "these turns are the same person", never who that is,
 * so each voice is shown with the first thing it said — enough to recognise it,
 * and clickable to hear it.
 */
export function VoiceNames({
  segments,
  labels,
  voiceNames,
  onChange,
  onSeek
}: VoiceNamesProps): React.JSX.Element | null {
  const voices = voicesIn(segments)
  if (voices.length < 2) return null

  return (
    <div className="voices">
      <div className="voices__head">
        Riconosciute {voices.length} voci diverse. Dai un nome a ciascuna: comparirà nella
        trascrizione e nel riassunto.
      </div>
      {voices.map((voice) => {
        const first = segments.find(
          (segment) => segment.speaker === 'them' && segment.voice === voice
        )
        return (
          <div key={voice} className={`voices__row voices__row--${voice % 5}`}>
            <input
              type="text"
              className="voices__input"
              value={voiceNames[String(voice)] ?? ''}
              placeholder={speakerName({ speaker: 'them', voice }, labels)}
              aria-label={`Nome per ${speakerName({ speaker: 'them', voice }, labels)}`}
              onChange={(event) =>
                onChange({ ...voiceNames, [String(voice)]: event.target.value })
              }
            />
            {first &&
              (onSeek ? (
                <button
                  type="button"
                  className="voices__sample voices__sample--seekable"
                  title={`Ascolta da ${timecode(first.from)}`}
                  onClick={() => onSeek(first.from / 1000)}
                >
                  <span className="turn__time">{timecode(first.from)}</span>
                  {first.text.slice(0, 110)}
                </button>
              ) : (
                <span className="voices__sample">
                  <span className="turn__time">{timecode(first.from)}</span>
                  {first.text.slice(0, 110)}
                </span>
              ))}
          </div>
        )
      })}
    </div>
  )
}
