import type {
  LanguageOption,
  MonitorSource,
  OllamaStatus,
  Settings,
  SystemAudioCapability,
  WhisperStatus
} from '@shared/types'
import { TEMPLATES, templateById } from '@shared/templates'
import { LANGUAGES } from '@shared/types'
import { formatDuration } from '../format'
import { Meter } from './Meter'

export interface Blocker {
  title: string
  text: string
  action?: { label: string; run: () => void }
}

interface RecordViewProps {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
  whisper: WhisperStatus | null
  ollama: OllamaStatus | null
  capability: SystemAudioCapability | null
  microphones: MediaDeviceInfo[]
  /** Linux only: the outputs whose playback can be recorded. */
  monitors: MonitorSource[]
  blockers: Blocker[]
  onStart: () => void
  onTestSystemAudio: () => void
  systemAudioTest: { ok: boolean; peak: number; error?: string } | null
  testing: boolean
  starting: boolean
  /** Set when the pre-recording system-audio check failed. */
  preflight: { error: string } | null
  onDismissPreflight: () => void
  onRecordMicOnly: () => void
  onOpenScreenSettings: () => void
  onRestart: () => void
}

export function RecordView({
  settings,
  onPatch,
  whisper,
  ollama,
  capability,
  microphones,
  monitors,
  blockers,
  onStart,
  onTestSystemAudio,
  systemAudioTest,
  testing,
  starting,
  preflight,
  onDismissPreflight,
  onRecordMicOnly,
  onOpenScreenSettings,
  onRestart
}: RecordViewProps): React.JSX.Element {
  const installedModels = whisper?.models.filter((model) => model.installed) ?? []
  const noSource = !settings.captureMic && !settings.captureSystem
  const canStart = blockers.length === 0 && !noSource && !starting
  const linux = capability?.mode === 'linux-pulse-monitor'

  return (
    <>
      <h1>Nuova registrazione</h1>
      <p className="subtitle">
        Scegli la lingua della call, seleziona cosa ascoltare e premi Avvia. Tutto viene elaborato
        sul tuo computer.
      </p>

      {preflight && (
        <div className="banner banner--error">
          <div className="banner__body">
            <div className="banner__title">L'audio di sistema non arriva</div>
            <div className="banner__text">
              Ho verificato il canale prima di registrare e non ha ricevuto alcun dato, quindi la
              voce del tuo interlocutore andrebbe persa. {preflight.error}
              <br />
              <br />
              {linux ? (
                <>
                  Controlla che PipeWire o PulseAudio sia in esecuzione e che l'uscita scelta qui
                  sotto sia quella su cui senti la call.
                </>
              ) : (
                <>
                  Attiva <strong>NoteBro</strong> in Impostazioni di Sistema → Privacy e sicurezza
                  → Registrazione schermo e audio di sistema, poi <strong>riavvia NoteBro</strong>:
                  quel permesso vale solo dal lancio successivo.
                </>
              )}
            </div>
            <div className="row row--wrap" style={{ marginTop: 12 }}>
              {!linux && (
                <>
                  <button type="button" className="btn btn--primary" onClick={onOpenScreenSettings}>
                    Apri impostazioni
                  </button>
                  <button type="button" className="btn" onClick={onRestart}>
                    Riavvia NoteBro
                  </button>
                </>
              )}
              <button type="button" className="btn" onClick={onRecordMicOnly}>
                Registra solo il microfono
              </button>
              <button type="button" className="btn btn--ghost" onClick={onDismissPreflight}>
                Riprova
              </button>
            </div>
          </div>
        </div>
      )}

      {blockers.map((blocker) => (
        <div key={blocker.title} className="banner banner--warn">
          <div className="banner__body">
            <div className="banner__title">{blocker.title}</div>
            <div className="banner__text">{blocker.text}</div>
          </div>
          {blocker.action && (
            <button type="button" className="btn" onClick={blocker.action.run}>
              {blocker.action.label}
            </button>
          )}
        </div>
      ))}

      <div className="card">
        <h2>Lingua della conversazione</h2>
        <label className="field">
          <span>Viene usata sia per la trascrizione sia per la lingua del riassunto</span>
          <select
            value={settings.language}
            onChange={(event) => onPatch({ language: event.target.value })}
          >
            {LANGUAGES.map((language: LanguageOption) => (
              <option key={language.code} value={language.code}>
                {language.label}
              </option>
            ))}
          </select>
        </label>
        {settings.language === 'auto' && (
          <p className="faint" style={{ margin: 0 }}>
            Il rilevamento automatico è meno preciso su registrazioni brevi. Se conosci la lingua,
            selezionala.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Tipo di conversazione</h2>
        <label className="field" style={{ marginBottom: 8 }}>
          <span>Decide le sezioni del riassunto</span>
          <select
            value={settings.template}
            onChange={(event) => onPatch({ template: event.target.value })}
          >
            {TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.label}
              </option>
            ))}
          </select>
        </label>
        <p className="faint" style={{ margin: 0 }}>
          {templateById(settings.template).hint} Sezioni:{' '}
          {templateById(settings.template)
            .outline.map((section) => section.heading)
            .join(' · ')}
        </p>
      </div>

      <div className="card">
        <h2>Cosa ascoltare</h2>
        <div className="grid-2">
          <label className={`toggle${settings.captureMic ? ' toggle--on' : ''}`}>
            <input
              type="checkbox"
              checked={settings.captureMic}
              onChange={(event) => onPatch({ captureMic: event.target.checked })}
            />
            <span>
              <span className="toggle__label">Microfono</span>
              <span className="toggle__hint">La tua voce, dal dispositivo di ingresso scelto.</span>
            </span>
          </label>

          <label className={`toggle${settings.captureSystem ? ' toggle--on' : ''}`}>
            <input
              type="checkbox"
              checked={settings.captureSystem}
              onChange={(event) => onPatch({ captureSystem: event.target.checked })}
            />
            <span>
              <span className="toggle__label">Audio di sistema</span>
              <span className="toggle__hint">
                La voce del tuo interlocutore, così come la senti tu.
              </span>
            </span>
          </label>
        </div>

        {noSource && (
          <p className="banner banner--warn" style={{ marginTop: 14, marginBottom: 0 }}>
            Seleziona almeno una sorgente audio.
          </p>
        )}

        {settings.captureMic && settings.captureSystem && (
          <p className="faint" style={{ marginTop: 14, marginBottom: 0 }}>
            Con le cuffie le due voci restano su canali separati e vengono attribuite
            correttamente. Con gli altoparlanti il microfono può captare anche il tuo
            interlocutore, quindi qualche frase potrebbe risultare doppia.
          </p>
        )}

        {settings.captureMic && (
          <label className="field" style={{ marginTop: 16, marginBottom: 0 }}>
            <span>Microfono</span>
            <select
              value={settings.micDeviceId}
              onChange={(event) => onPatch({ micDeviceId: event.target.value })}
            >
              <option value="default">Predefinito di sistema</option>
              {microphones
                .filter((device) => device.deviceId && device.deviceId !== 'default')
                .map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || 'Microfono senza nome'}
                  </option>
                ))}
            </select>
          </label>
        )}

        {settings.captureSystem && capability?.mode === 'linux-pulse-monitor' && capability.available && (
          <label className="field" style={{ marginTop: 16, marginBottom: 0 }}>
            <span>Uscita da registrare</span>
            <select
              value={settings.systemInputDeviceId}
              onChange={(event) => onPatch({ systemInputDeviceId: event.target.value })}
            >
              <option value="">Uscita audio predefinita</option>
              {monitors.map((monitor) => (
                <option key={monitor.name} value={monitor.name}>
                  {monitor.description}
                </option>
              ))}
              {settings.systemInputDeviceId &&
                !monitors.some((monitor) => monitor.name === settings.systemInputDeviceId) && (
                  <option value={settings.systemInputDeviceId}>
                    {settings.systemInputDeviceId} (non collegata)
                  </option>
                )}
            </select>
          </label>
        )}

        {settings.captureSystem && settings.diarization && (
          <label className="field" style={{ marginTop: 16, marginBottom: 0 }}>
            <span>Quante persone collegate, oltre a te</span>
            <select
              value={String(settings.expectedSpeakers)}
              onChange={(event) => onPatch({ expectedSpeakers: Number(event.target.value) })}
            >
              <option value="1">1 — non distinguere le voci</option>
              {[2, 3, 4, 5, 6, 7, 8].map((count) => (
                <option key={count} value={String(count)}>
                  {count} persone
                </option>
              ))}
            </select>
          </label>
        )}

        {settings.captureSystem && capability && (
          <div style={{ marginTop: 16 }}>
            <p className="faint" style={{ marginTop: 0, marginBottom: 10 }}>
              {capability.detail}
            </p>
            {(capability.mode === 'macos-screencapturekit' ||
              (capability.mode === 'linux-pulse-monitor' && capability.available)) && (
              <div className="row row--wrap">
                <button type="button" className="btn" onClick={onTestSystemAudio} disabled={testing}>
                  {testing ? 'Test in corso…' : 'Testa audio di sistema'}
                </button>
                {systemAudioTest && (
                  <span className="pill">
                    <span className={`dot ${systemAudioTest.ok ? 'dot--ok' : 'dot--bad'}`} />
                    {systemAudioTest.ok
                      ? systemAudioTest.peak > 0.005
                        ? 'Audio rilevato'
                        : 'Collegato, ma silenzioso — fai suonare qualcosa e riprova'
                      : (systemAudioTest.error ?? 'Nessun audio')}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Modelli locali</h2>
          <span className="faint">Nessun dato lascia il computer</span>
        </div>
        <div className="grid-2">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Trascrizione (whisper.cpp)</span>
            <select
              value={settings.whisperModel}
              onChange={(event) => onPatch({ whisperModel: event.target.value })}
              disabled={installedModels.length === 0}
            >
              {installedModels.length === 0 && <option value="">Nessun modello scaricato</option>}
              {installedModels.map((model) => (
                <option key={model.name} value={model.name}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Riassunto (Ollama)</span>
            <select
              value={settings.ollamaModel}
              onChange={(event) => onPatch({ ollamaModel: event.target.value })}
              disabled={!ollama?.running || ollama.models.length === 0}
            >
              {(!ollama?.running || ollama.models.length === 0) && (
                <option value="">Nessun modello disponibile</option>
              )}
              {ollama?.models.map((model) => (
                <option key={model.name} value={model.name}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="row" style={{ marginTop: 22 }}>
        <button type="button" className="btn btn--record" onClick={onStart} disabled={!canStart}>
          <span className="rec-badge__dot" style={{ background: '#fff', animation: 'none' }} />
          {starting ? 'Avvio…' : 'Avvia ascolto'}
        </button>
      </div>
    </>
  )
}

interface RecordingViewProps {
  elapsedMs: number
  levels: { me: number; them: number }
  /** Channels that have produced sound at least once. */
  seen: { me: boolean; them: boolean }
  /** Channels that are delivering samples at all, silent or not. */
  receiving: { me: boolean; them: boolean }
  onOpenScreenSettings: () => void
  paused: boolean
  captureMic: boolean
  captureSystem: boolean
  labels: Settings['speakerLabels']
  warnings: string[]
  /** Free notes typed while the conversation happens. */
  notes: string
  onNotesChange: (notes: string) => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onCancel: () => void
  stopping: boolean
}

export function RecordingView({
  elapsedMs,
  levels,
  seen,
  receiving,
  onOpenScreenSettings,
  paused,
  captureMic,
  captureSystem,
  labels,
  warnings,
  notes,
  onNotesChange,
  onPause,
  onResume,
  onStop,
  onCancel,
  stopping
}: RecordingViewProps): React.JSX.Element {
  // Give each channel a few seconds to come up before calling it dead.
  const settled = elapsedMs > 4000
  const deadChannels = [
    ...(captureMic && settled && !receiving.me ? [labels.me] : []),
    ...(captureSystem && settled && !receiving.them ? [labels.them] : [])
  ]

  return (
    <>
      <span className="rec-badge">
        {!paused && <span className="rec-badge__dot" />}
        {paused ? 'In pausa' : 'Registrazione in corso'}
      </span>
      <div className="timer">{formatDuration(elapsedMs)}</div>
      <p className="subtitle">
        Premi Stop quando hai finito: la trascrizione e il riassunto partono subito dopo.
      </p>

      {deadChannels.length > 0 && (
        <div className="banner banner--error">
          <div className="banner__body">
            <div className="banner__title">
              Il canale "{deadChannels.join('" e "')}" non sta ricevendo nulla
            </div>
            <div className="banner__text">
              Quella voce non finirà nel riassunto. Se si tratta dell'audio di sistema manca il
              permesso di registrazione schermo: ferma la registrazione, concedilo e riavvia
              NoteBro.
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button type="button" className="btn" onClick={onOpenScreenSettings}>
                Apri impostazioni
              </button>
            </div>
          </div>
        </div>
      )}

      {warnings.map((warning) => (
        <div key={warning} className="banner banner--warn">
          <div className="banner__body">
            <div className="banner__title">Attenzione</div>
            <div className="banner__text">{warning}</div>
          </div>
        </div>
      ))}

      <div className="card">
        <div className="card__head">
          <h2>I tuoi appunti</h2>
          <span className="faint">
            {notes.trim() ? `${notes.trim().split(/\s+/).length} parole` : 'facoltativi'}
          </span>
        </div>
        <textarea
          value={notes}
          onChange={(event) => onNotesChange(event.target.value)}
          placeholder={
            'Scrivi liberamente mentre si parla: due parole, un nome, una decisione.\n' +
            'Il riassunto partirà da qui e completerà ogni punto con la trascrizione.'
          }
          style={{ minHeight: 190, fontFamily: 'inherit', fontSize: '14px' }}
        />
      </div>

      <div className="card">
        <h2>Livelli in ingresso</h2>
        {captureMic && (
          <Meter
            label={labels.me}
            level={levels.me}
            silent={!seen.me}
            hint={hintFor(seen.me, receiving.me)}
          />
        )}
        {captureSystem && (
          <Meter
            label={labels.them}
            level={levels.them}
            silent={!seen.them}
            hint={hintFor(seen.them, receiving.them)}
          />
        )}
        <p className="faint" style={{ marginBottom: 0 }}>
          Se una barra resta ferma, quel canale non sta ricevendo nulla e resterà vuoto nel
          riassunto.
        </p>
      </div>

      <div className="row" style={{ marginTop: 22 }}>
        <button type="button" className="btn btn--stop" onClick={onStop} disabled={stopping}>
          {stopping ? 'Chiusura…' : 'Stop e riassumi'}
        </button>
        {paused ? (
          <button type="button" className="btn btn--lg" onClick={onResume} disabled={stopping}>
            Riprendi
          </button>
        ) : (
          <button type="button" className="btn btn--lg" onClick={onPause} disabled={stopping}>
            Pausa
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={stopping}>
          Annulla e scarta
        </button>
      </div>
    </>
  )
}

/** Distinguishes a channel that is silent from one that sends nothing at all. */
function hintFor(seen: boolean, receiving: boolean): string | undefined {
  if (seen) return undefined
  return receiving ? 'collegato, in attesa di voce…' : 'nessun dato in arrivo'
}
