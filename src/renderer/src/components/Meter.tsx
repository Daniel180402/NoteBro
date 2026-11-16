interface MeterProps {
  label: string
  level: number
  hint?: string
  /** Shown when the channel has produced no sound at all so far. */
  silent?: boolean
}

export function Meter({ label, level, hint, silent }: MeterProps): React.JSX.Element {
  // Amplitude is perceptually compressed so quiet speech is still visible.
  const width = Math.min(100, Math.round(Math.sqrt(Math.max(0, level)) * 115))
  return (
    <div className="meter">
      <div className="meter__head">
        <span>{label}</span>
        <span className="faint">{hint}</span>
      </div>
      <div className="meter__track">
        <div
          className={`meter__fill${silent ? ' meter__fill--silent' : ''}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  )
}
