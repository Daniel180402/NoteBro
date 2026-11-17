import type { ProcessProgress, Settings, SpeakerId } from '@shared/types'

interface ProcessingViewProps {
  progress: ProcessProgress | null
  channels: SpeakerId[]
  labels: Settings['speakerLabels']
  /** Whether the voice-identification stage is part of this run. */
  diarizing: boolean
  error: string | null
  onCancel: () => void
  onRetry: () => void
  onBack: () => void
}

type StageKey = ProcessProgress['stage']

export function ProcessingView({
  progress,
  channels,
  labels,
  diarizing,
  error,
  onCancel,
  onRetry,
  onBack
}: ProcessingViewProps): React.JSX.Element {
  const stages: Array<{ key: StageKey; label: string }> = [
    { key: 'preparing', label: 'Preparazione dei canali audio' },
    ...channels.map((speaker) => ({
      key: (speaker === 'me' ? 'transcribing-me' : 'transcribing-them') as StageKey,
      label: `Trascrizione di "${labels[speaker]}"`
    })),
    ...(diarizing
      ? [{ key: 'identifying-voices' as StageKey, label: 'Riconoscimento degli interlocutori' }]
      : []),
    { key: 'merging', label: 'Ricostruzione del dialogo' },
    { key: 'summarizing', label: 'Riassunto' }
  ]

  const currentIndex = progress
    ? stages.findIndex((stage) => stage.key === progress.stage)
    : 0
  // 'done' is not in the list, so treat an unknown stage as "everything finished".
  const activeIndex = progress?.stage === 'done' ? stages.length : currentIndex

  if (error) {
    return (
      <>
        <h1>Elaborazione interrotta</h1>
        <div className="banner banner--error">
          <div className="banner__body">
            <div className="banner__title">Non è stato possibile completare il riassunto</div>
            <div className="banner__text">{error}</div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 18 }}>
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            Riprova
          </button>
          <button type="button" className="btn" onClick={onBack}>
            Torna indietro
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <h1>Elaborazione in corso</h1>
      <p className="subtitle">
        {progress?.message || 'Avvio…'} Puoi lasciare la finestra aperta: tutto gira in locale.
      </p>

      <div className="card">
        {stages.map((stage, index) => {
          const done = index < activeIndex
          const active = index === activeIndex
          return (
            <div key={stage.key} className={`stage${!done && !active ? ' stage--pending' : ''}`}>
              <span
                className={`stage__icon${active ? ' stage__icon--active' : ''}${done ? ' stage__icon--done' : ''}`}
              >
                {done ? '✓' : ''}
              </span>
              <span className="stage__label">{stage.label}</span>
            </div>
          )
        })}

        <div className="progress">
          <div
            className={`progress__fill${progress?.progress == null ? ' progress__fill--indeterminate' : ''}`}
            style={{ width: `${Math.round((progress?.progress ?? 0) * 100)}%` }}
          />
        </div>
      </div>

      {progress?.partialSummary ? (
        <div className="card">
          <h2>Riassunto in scrittura</h2>
          <div className="stream-preview">{progress.partialSummary}</div>
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 18 }}>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Annulla elaborazione
        </button>
      </div>
    </>
  )
}
