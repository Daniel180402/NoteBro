import { useState } from 'react'
import type {
  DownloadProgress,
  OllamaStatus,
  Settings,
  SystemAudioCapability,
  WhisperStatus
} from '@shared/types'
import { TEMPLATES, templateById } from '@shared/templates'
import { formatBytes } from '../format'

interface PullProgress {
  model: string
  status: string
  completed: number
  total: number
  done: boolean
}

export interface StorageReport {
  audioBytes: number
  modelBytes: number
  sessionBytes: number
  pendingCompression: number
  reclaimableBytes: number
}

export interface DiarizationStatus {
  supported: boolean
  modelsInstalled: boolean
  totalBytes: number
  installedBytes: number
}

interface SettingsViewProps {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
  whisper: WhisperStatus | null
  ollama: OllamaStatus | null
  capability: SystemAudioCapability | null
  platform: string
  downloads: Record<string, DownloadProgress>
  pull: PullProgress | null
  diarization: DiarizationStatus | null
  storage: StorageReport | null
  compressProgress: { done: number; total: number; freed: number } | null
  onCompressAudio: () => void
  onCleanSessions: () => void
  diarizationDownload: { receivedBytes: number; totalBytes: number; done: boolean; error?: string } | null
  onDownloadDiarization: () => void
  onDeleteDiarization: () => void
  busyModel: string | null
  onDownloadModel: (name: string) => void
  onDeleteModel: (name: string) => void
  onStartOllama: () => void
  onPullOllama: (model: string) => void
  onRefresh: () => void
  onOpenScreenSettings: () => void
  onOpenMicSettings: () => void
  onOpenLog: () => void
  onRestart: () => void
  onBack: () => void
}

const SUGGESTED_OLLAMA = ['qwen2.5:7b', 'llama3.2:3b', 'gemma2:9b', 'qwen2.5:14b']

export function SettingsView({
  settings,
  onPatch,
  whisper,
  ollama,
  capability,
  platform,
  downloads,
  pull,
  diarization,
  storage,
  compressProgress,
  onCompressAudio,
  onCleanSessions,
  diarizationDownload,
  onDownloadDiarization,
  onDeleteDiarization,
  busyModel,
  onDownloadModel,
  onDeleteModel,
  onStartOllama,
  onPullOllama,
  onRefresh,
  onOpenScreenSettings,
  onOpenMicSettings,
  onOpenLog,
  onRestart,
  onBack
}: SettingsViewProps): React.JSX.Element {
  const [customModel, setCustomModel] = useState('')

  return (
    <>
      <button type="button" className="btn btn--ghost" onClick={onBack} style={{ marginBottom: 14 }}>
        ← Indietro
      </button>
      <div className="row row--between">
        <h1>Impostazioni</h1>
        <button type="button" className="btn" onClick={onRefresh}>
          Ricontrolla
        </button>
      </div>
      <p className="subtitle">
        NoteBro funziona interamente in locale: whisper.cpp per la trascrizione, Ollama per il
        riassunto.
      </p>

      <div className="card">
        <div className="card__head">
          <h2>Trascrizione — whisper.cpp</h2>
          <span className="pill">
            <span className={`dot ${whisper?.available ? 'dot--ok' : 'dot--bad'}`} />
            {whisper?.available ? 'Eseguibile trovato' : 'Eseguibile mancante'}
          </span>
        </div>

        {whisper?.available ? (
          <p className="faint" style={{ marginTop: 0 }}>
            <code>{whisper.binaryPath}</code>
          </p>
        ) : (
          <div className="banner banner--warn">
            <div className="banner__body">
              <div className="banner__title">whisper.cpp non è installato</div>
              <div className="banner__text">
                {platform === 'darwin'
                  ? 'Installalo con "brew install whisper-cpp", oppure indica qui sotto il percorso dell\'eseguibile.'
                  : 'Scarica una release di whisper.cpp e indica qui sotto il percorso di whisper-cli.exe.'}
              </div>
            </div>
          </div>
        )}

        <label className="field">
          <span>Percorso personalizzato dell'eseguibile (opzionale)</span>
          <input
            type="text"
            value={settings.whisperBinaryPath}
            placeholder="/opt/homebrew/bin/whisper-cli"
            onChange={(event) => onPatch({ whisperBinaryPath: event.target.value })}
          />
        </label>

        <h2 style={{ marginTop: 20 }}>Modelli di trascrizione</h2>
        {whisper?.models.map((model) => {
          const download = downloads[model.name]
          const downloading = download && !download.done
          const percent =
            downloading && download.totalBytes > 0
              ? Math.round((download.receivedBytes / download.totalBytes) * 100)
              : 0
          return (
            <div key={model.name} className="model-row">
              <div className="model-row__body">
                <div className="model-row__name">
                  {model.label}
                  {settings.whisperModel === model.name && model.installed && (
                    <span className="pill" style={{ marginLeft: 8 }}>
                      in uso
                    </span>
                  )}
                </div>
                <div className="faint">
                  {model.note} · {formatBytes(model.sizeBytes)}
                </div>
                {downloading && (
                  <div className="progress" style={{ marginTop: 7 }}>
                    <div className="progress__fill" style={{ width: `${percent}%` }} />
                  </div>
                )}
                {download?.error && (
                  <div className="faint" style={{ color: 'var(--danger)' }}>
                    {download.error}
                  </div>
                )}
              </div>
              {model.installed ? (
                <div className="row">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onPatch({ whisperModel: model.name })}
                    disabled={settings.whisperModel === model.name}
                  >
                    Usa
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={() => onDeleteModel(model.name)}
                  >
                    Rimuovi
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => onDownloadModel(model.name)}
                  disabled={Boolean(downloading) || busyModel === model.name}
                >
                  {downloading ? `${percent}%` : 'Scarica'}
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Riassunto — Ollama</h2>
          <span className="pill">
            <span className={`dot ${ollama?.running ? 'dot--ok' : 'dot--bad'}`} />
            {ollama?.running ? 'Server attivo' : 'Server non raggiungibile'}
          </span>
        </div>

        {!ollama?.running && (
          <div className="banner banner--warn">
            <div className="banner__body">
              <div className="banner__title">Ollama non risponde</div>
              <div className="banner__text">
                {ollama?.cliFound
                  ? 'Ollama è installato ma il server non è in esecuzione.'
                  : 'Installa Ollama da ollama.com, poi torna qui.'}
              </div>
            </div>
            {ollama?.cliFound && (
              <button type="button" className="btn btn--primary" onClick={onStartOllama}>
                Avvia Ollama
              </button>
            )}
          </div>
        )}

        <label className="field">
          <span>Indirizzo del server</span>
          <input
            type="text"
            value={settings.ollamaBaseUrl}
            onChange={(event) => onPatch({ ollamaBaseUrl: event.target.value })}
          />
        </label>

        {ollama && ollama.models.length > 0 && (
          <>
            <h2 style={{ marginTop: 18 }}>Modelli disponibili</h2>
            {ollama.models.map((model) => (
              <div key={model.name} className="model-row">
                <div className="model-row__body">
                  <div className="model-row__name">
                    {model.name}
                    {settings.ollamaModel === model.name && (
                      <span className="pill" style={{ marginLeft: 8 }}>
                        in uso
                      </span>
                    )}
                  </div>
                  <div className="faint">{formatBytes(model.sizeBytes)}</div>
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => onPatch({ ollamaModel: model.name })}
                  disabled={settings.ollamaModel === model.name}
                >
                  Usa
                </button>
              </div>
            ))}
          </>
        )}

        <h2 style={{ marginTop: 18 }}>Scarica un altro modello</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <input
            type="text"
            placeholder="nome:tag, es. qwen2.5:7b"
            value={customModel}
            onChange={(event) => setCustomModel(event.target.value)}
          />
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onPullOllama(customModel.trim())}
            disabled={!customModel.trim() || !ollama?.running || Boolean(pull && !pull.done)}
          >
            Scarica
          </button>
        </div>
        <div className="row row--wrap">
          {SUGGESTED_OLLAMA.filter(
            (name) => !ollama?.models.some((model) => model.name === name)
          ).map((name) => (
            <button
              key={name}
              type="button"
              className="btn btn--ghost"
              onClick={() => setCustomModel(name)}
            >
              {name}
            </button>
          ))}
        </div>
        {pull && !pull.done && (
          <>
            <p className="faint" style={{ marginBottom: 4, marginTop: 12 }}>
              {pull.model}: {pull.status}
            </p>
            <div className="progress">
              <div
                className="progress__fill"
                style={{
                  width: `${pull.total > 0 ? Math.round((pull.completed / pull.total) * 100) : 0}%`
                }}
              />
            </div>
          </>
        )}
      </div>

      {platform === 'darwin' && (
        <div className="card">
          <div className="card__head">
            <h2>Permessi di macOS</h2>
            <span className="pill">
              <span
                className={`dot ${capability?.permission === 'granted' ? 'dot--ok' : capability?.permission === 'denied' ? 'dot--bad' : 'dot--warn'}`}
              />
              {capability?.permission === 'granted'
                ? 'Registrazione schermo concessa'
                : capability?.permission === 'denied'
                  ? 'Registrazione schermo negata'
                  : 'Registrazione schermo da verificare'}
            </span>
          </div>
          <p className="faint" style={{ marginTop: 0 }}>
            Per sentire il tuo interlocutore, NoteBro usa ScreenCaptureKit: macOS lo classifica
            sotto "Registrazione schermo e audio di sistema". Non vengono salvate immagini dello
            schermo, solo l'audio. Dopo aver concesso il permesso, riavvia l'app.
          </p>
          <div className="row row--wrap">
            <button type="button" className="btn" onClick={onOpenScreenSettings}>
              Apri impostazioni registrazione schermo
            </button>
            <button type="button" className="btn" onClick={onOpenMicSettings}>
              Apri impostazioni microfono
            </button>
            <button type="button" className="btn btn--primary" onClick={onRestart}>
              Riavvia NoteBro
            </button>
          </div>
          <p className="faint" style={{ marginBottom: 0, marginTop: 14 }}>
            Se l'audio di sistema resta muto, il log diagnostico riporta esattamente cosa ha
            risposto macOS alla richiesta di cattura.{' '}
            <button type="button" className="link" onClick={onOpenLog}>
              Mostra il log nel Finder
            </button>
          </p>
        </div>
      )}

      <div className="card">
        <div className="card__head">
          <h2>Spazio su disco</h2>
          {storage && (
            <span className="faint">
              {formatBytes(storage.audioBytes + storage.modelBytes + storage.sessionBytes)} in
              totale
            </span>
          )}
        </div>

        {storage && (
          <>
            <div className="model-row">
              <div className="model-row__body">
                <div className="model-row__name">Registrazioni</div>
                <div className="faint">
                  {formatBytes(storage.audioBytes)}
                  {storage.pendingCompression > 0 &&
                    ` · ${storage.pendingCompression} non ancora compresse`}
                </div>
                {compressProgress && compressProgress.done < compressProgress.total && (
                  <div className="progress" style={{ marginTop: 7 }}>
                    <div
                      className="progress__fill"
                      style={{
                        width: `${Math.round((compressProgress.done / compressProgress.total) * 100)}%`
                      }}
                    />
                  </div>
                )}
              </div>
              {storage.pendingCompression > 0 && (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={onCompressAudio}
                  disabled={Boolean(
                    compressProgress && compressProgress.done < compressProgress.total
                  )}
                >
                  {compressProgress && compressProgress.done < compressProgress.total
                    ? `${compressProgress.done}/${compressProgress.total}`
                    : `Comprimi, libera ~${formatBytes(storage.reclaimableBytes)}`}
                </button>
              )}
            </div>

            <div className="model-row">
              <div className="model-row__body">
                <div className="model-row__name">Modelli</div>
                <div className="faint">{formatBytes(storage.modelBytes)} · costo fisso</div>
              </div>
            </div>

            <div className="model-row">
              <div className="model-row__body">
                <div className="model-row__name">File temporanei</div>
                <div className="faint">
                  {storage.sessionBytes > 0
                    ? `${formatBytes(storage.sessionBytes)} di registrazioni mai archiviate`
                    : 'Nessun residuo'}
                </div>
              </div>
              {storage.sessionBytes > 0 && (
                <button type="button" className="btn" onClick={onCleanSessions}>
                  Svuota
                </button>
              )}
            </div>

            <p className="faint" style={{ marginBottom: 0, marginTop: 12 }}>
              Le registrazioni vengono compresse in Opus subito dopo il salvataggio: circa un nono
              dello spazio, senza perdita udibile sul parlato. Il WAV non compresso serve solo
              durante la trascrizione.
            </p>
          </>
        )}
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Riconoscimento degli interlocutori</h2>
          <span className="pill">
            <span
              className={`dot ${diarization?.modelsInstalled ? 'dot--ok' : diarization?.supported ? 'dot--warn' : 'dot--bad'}`}
            />
            {diarization?.modelsInstalled
              ? 'Pronto'
              : diarization?.supported
                ? 'Modelli da scaricare'
                : 'Non disponibile'}
          </span>
        </div>

        <p className="faint" style={{ marginTop: 0 }}>
          Separa le voci delle persone collegate, così la trascrizione distingue chi ha detto
          cosa invece di mettere tutti sotto un unico "{settings.speakerLabels.them}". Funziona
          sul canale dell'audio di sistema; la tua voce arriva già dal microfono ed è sempre
          distinta.
        </p>

        {!diarization?.supported && (
          <div className="banner banner--warn">
            <div className="banner__body">
              <div className="banner__text">
                La libreria di riconoscimento non è disponibile su questa piattaforma.
              </div>
            </div>
          </div>
        )}

        {diarization?.supported && !diarization.modelsInstalled && (
          <div className="model-row">
            <div className="model-row__body">
              <div className="model-row__name">Modelli di riconoscimento</div>
              <div className="faint">
                Segmentazione dei turni e confronto dei timbri ·{' '}
                {formatBytes(diarization.totalBytes)}
              </div>
              {diarizationDownload && !diarizationDownload.done && (
                <div className="progress" style={{ marginTop: 7 }}>
                  <div
                    className="progress__fill"
                    style={{
                      width: `${
                        diarizationDownload.totalBytes > 0
                          ? Math.round(
                              (diarizationDownload.receivedBytes /
                                diarizationDownload.totalBytes) *
                                100
                            )
                          : 0
                      }%`
                    }}
                  />
                </div>
              )}
              {diarizationDownload?.error && (
                <div className="faint" style={{ color: 'var(--danger)' }}>
                  {diarizationDownload.error}
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn btn--primary"
              onClick={onDownloadDiarization}
              disabled={Boolean(diarizationDownload && !diarizationDownload.done)}
            >
              {diarizationDownload && !diarizationDownload.done ? 'Scarico…' : 'Scarica'}
            </button>
          </div>
        )}

        {diarization?.modelsInstalled && (
          <>
            <label
              className={`toggle${settings.diarization ? ' toggle--on' : ''}`}
              style={{ marginBottom: 14 }}
            >
              <input
                type="checkbox"
                checked={settings.diarization}
                onChange={(event) => onPatch({ diarization: event.target.checked })}
              />
              <span>
                <span className="toggle__label">Distingui gli interlocutori</span>
                <span className="toggle__hint">
                  Aggiunge qualche secondo di elaborazione ogni minuto registrato.
                </span>
              </span>
            </label>

            <label className="field" style={{ marginBottom: 10 }}>
              <span>Quante persone collegate, oltre a te</span>
              <select
                value={String(settings.expectedSpeakers)}
                onChange={(event) =>
                  onPatch({ expectedSpeakers: Number(event.target.value) })
                }
                disabled={!settings.diarization}
              >
                <option value="1">1 — non distinguere</option>
                {[2, 3, 4, 5, 6, 7, 8].map((count) => (
                  <option key={count} value={String(count)}>
                    {count} persone
                  </option>
                ))}
              </select>
            </label>
            <div className="banner banner--warn" style={{ marginBottom: 0 }}>
              <div className="banner__body">
                <div className="banner__text">
                  Il numero va dichiarato: su audio di call reale il rilevamento automatico si è
                  rivelato inservibile — su una conversazione con <strong>un solo</strong>
                  interlocutore ne ha contati 38 — e non viene più offerto. Una stima sbagliata
                  degrada con grazia, indovinare no. Puoi cambiare il numero anche subito prima
                  di avviare una registrazione.
                </div>
              </div>
            </div>

            <div className="row">
              <button type="button" className="btn btn--danger" onClick={onDeleteDiarization}>
                Rimuovi i modelli ({formatBytes(diarization.installedBytes)})
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>Tipo di conversazione predefinito</h2>
        <label className="field" style={{ marginBottom: 8 }}>
          <span>Puoi comunque cambiarlo prima di ogni registrazione</span>
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
        <p className="faint" style={{ marginBottom: 0 }}>
          {templateById(settings.template).hint}
        </p>
      </div>

      <div className="card">
        <h2>Chi sei</h2>
        <label className="field">
          <span>Il tuo nome</span>
          <input
            type="text"
            value={settings.userName}
            placeholder="Es. Daniel"
            onChange={(event) => onPatch({ userName: event.target.value })}
          />
        </label>
        <p className="faint" style={{ marginTop: -8 }}>
          Serve al riassunto per capire che quando il tuo interlocutore ti chiama per nome sta
          parlando con te, e per intestarti le azioni da fare. Aiuta anche la trascrizione a
          scrivere il nome correttamente.
        </p>

        <label className="field" style={{ marginBottom: 0 }}>
          <span>Termini ricorrenti (facoltativo)</span>
          <input
            type="text"
            value={settings.vocabulary}
            placeholder="Nomi di colleghi, clienti, prodotti, sigle…"
            onChange={(event) => onPatch({ vocabulary: event.target.value })}
          />
        </label>
        <p className="faint" style={{ marginTop: 6, marginBottom: 0 }}>
          Separa con virgole. La trascrizione tende a rendere i nomi propri con la parola comune
          più vicina: elencarli qui la indirizza.
        </p>
      </div>

      <div className="card">
        <h2>Audio e trascrizione</h2>
        <div className="grid-2" style={{ marginBottom: 14 }}>
          <label className={`toggle${settings.echoCancellation ? ' toggle--on' : ''}`}>
            <input
              type="checkbox"
              checked={settings.echoCancellation}
              onChange={(event) => onPatch({ echoCancellation: event.target.checked })}
            />
            <span>
              <span className="toggle__label">Cancellazione dell'eco</span>
              <span className="toggle__hint">
                Utile con gli altoparlanti, per ridurre il rientro della voce dell'interlocutore
                nel microfono. Non è però garantita sull'audio di altre app: per una separazione
                sicura delle due voci usa le cuffie.
              </span>
            </span>
          </label>
          <label className={`toggle${settings.noiseSuppression ? ' toggle--on' : ''}`}>
            <input
              type="checkbox"
              checked={settings.noiseSuppression}
              onChange={(event) => onPatch({ noiseSuppression: event.target.checked })}
            />
            <span>
              <span className="toggle__label">Riduzione del rumore</span>
              <span className="toggle__hint">Migliora la trascrizione in ambienti rumorosi.</span>
            </span>
          </label>
        </div>

        <label className={`toggle${settings.keepAudio ? ' toggle--on' : ''}`} style={{ marginBottom: 14 }}>
          <input
            type="checkbox"
            checked={settings.keepAudio}
            onChange={(event) => onPatch({ keepAudio: event.target.checked })}
          />
          <span>
            <span className="toggle__label">Conserva l'audio registrato</span>
            <span className="toggle__hint">
              Salva i file WAV accanto al riassunto. Disattiva per tenere solo il testo.
            </span>
          </span>
        </label>

        <div className="grid-2">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Come chiamare te</span>
            <input
              type="text"
              value={settings.speakerLabels.me}
              onChange={(event) =>
                onPatch({ speakerLabels: { ...settings.speakerLabels, me: event.target.value } })
              }
            />
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Come chiamare l'altra persona</span>
            <input
              type="text"
              value={settings.speakerLabels.them}
              onChange={(event) =>
                onPatch({ speakerLabels: { ...settings.speakerLabels, them: event.target.value } })
              }
            />
          </label>
        </div>

        <label className="field" style={{ marginTop: 14, marginBottom: 0 }}>
          <span>Thread di trascrizione (0 = automatico)</span>
          <input
            type="text"
            inputMode="numeric"
            value={String(settings.whisperThreads)}
            onChange={(event) => {
              const parsed = Number(event.target.value.replace(/\D/g, ''))
              onPatch({ whisperThreads: Number.isFinite(parsed) ? parsed : 0 })
            }}
          />
        </label>
      </div>
    </>
  )
}
