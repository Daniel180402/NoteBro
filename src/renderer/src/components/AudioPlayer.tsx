import { formatDuration } from '../format'
import type { AudioPlayer as Player } from '../audio/useAudioPlayer'

const RATES = [1, 1.25, 1.5, 2]

export function AudioPlayer({ player }: { player: Player }): React.JSX.Element | null {
  if (!player.src) return null

  const duration = player.duration || 0
  const progress = duration > 0 ? (player.currentTime / duration) * 100 : 0

  return (
    <div className="player">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={player.ref} src={player.src} preload="metadata" />

      <button
        type="button"
        className="player__play"
        onClick={player.toggle}
        aria-label={player.playing ? 'Pausa' : 'Riproduci'}
        title={player.playing ? 'Pausa' : 'Riproduci'}
      >
        {player.playing ? '❚❚' : '▶'}
      </button>

      <button
        type="button"
        className="btn btn--ghost player__skip"
        onClick={() => player.skip(-10)}
        title="Indietro di 10 secondi"
      >
        −10s
      </button>

      <span className="player__time">{formatDuration(player.currentTime * 1000)}</span>

      <div className="player__track">
        <div className="player__fill" style={{ width: `${progress}%` }} />
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(player.currentTime, duration || 0)}
          onChange={(event) => player.seek(Number(event.target.value))}
          aria-label="Posizione nella registrazione"
          disabled={duration === 0}
        />
      </div>

      <span className="player__time player__time--total">{formatDuration(duration * 1000)}</span>

      <button
        type="button"
        className="btn btn--ghost player__skip"
        onClick={() => player.skip(10)}
        title="Avanti di 10 secondi"
      >
        +10s
      </button>

      <button
        type="button"
        className="btn btn--ghost player__rate"
        onClick={() => player.setRate(RATES[(RATES.indexOf(player.rate) + 1) % RATES.length])}
        title="Velocità di riproduzione"
      >
        {player.rate}×
      </button>

      {player.error && <span className="player__error">{player.error}</span>}
    </div>
  )
}
