import { useState } from 'react'
import type { Folder, ProcessResult, Settings } from '@shared/types'
import { useAudioPlayer } from '../audio/useAudioPlayer'
import { formatDuration } from '../format'
import { AudioPlayer } from './AudioPlayer'
import { Markdown } from './Markdown'
import { Transcript } from './Transcript'
import { VoiceNames } from './VoiceNames'

interface ResultViewProps {
  result: ProcessResult
  folders: Folder[]
  labels: Settings['speakerLabels']
  onSave: (input: {
    title: string
    folderId: string | null
    summary: string
    voiceNames: Record<string, string>
  }) => void
  onCreateFolder: (name: string) => Promise<string>
  onExport: (title: string, summary: string, withTranscript: boolean) => void
  onDiscard: () => void
  saving: boolean
  /** Set when the recording was kept and can be played back. */
  audioUrl: string | null
}

export function ResultView({
  result,
  folders,
  labels,
  onSave,
  onCreateFolder,
  onExport,
  onDiscard,
  saving,
  audioUrl
}: ResultViewProps): React.JSX.Element {
  const [title, setTitle] = useState(result.title)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [summary, setSummary] = useState(result.summary)
  const [editing, setEditing] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const player = useAudioPlayer(audioUrl)
  const [voiceNames, setVoiceNames] = useState<Record<string, string>>({})

  const confirmNewFolder = async (): Promise<void> => {
    const name = folderName.trim()
    if (!name) {
      setCreatingFolder(false)
      return
    }
    const id = await onCreateFolder(name)
    setFolderId(id)
    setFolderName('')
    setCreatingFolder(false)
  }

  return (
    <>
      <h1>Riassunto pronto</h1>
      <p className="subtitle">
        Dai un nome al riassunto, scegli la cartella in cui archiviarlo e salva.
      </p>

      <div className="card">
        <label className="field">
          <span>Titolo</span>
          <input
            type="text"
            className="title-input"
            value={title}
            placeholder="Es. Colloquio con Rossi"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className="field" style={{ marginBottom: creatingFolder ? 10 : 0 }}>
          <span>Cartella</span>
          <div className="row">
            <select
              value={folderId ?? ''}
              onChange={(event) => setFolderId(event.target.value || null)}
            >
              <option value="">Senza cartella</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              onClick={() => setCreatingFolder((value) => !value)}
            >
              Nuova
            </button>
          </div>
        </label>

        {creatingFolder && (
          <div className="row">
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              type="text"
              autoFocus
              placeholder="Nome della nuova cartella"
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void confirmNewFolder()
                if (event.key === 'Escape') setCreatingFolder(false)
              }}
            />
            <button type="button" className="btn btn--primary" onClick={() => void confirmNewFolder()}>
              Crea
            </button>
          </div>
        )}

        <div className="row row--wrap faint" style={{ marginTop: 16, gap: 14 }}>
          <span>Durata {formatDuration(result.durationMs)}</span>
          <span>Lingua {result.language}</span>
          <span>Whisper {result.models.whisper}</span>
          <span>Ollama {result.models.ollama}</span>
        </div>
      </div>

        {result.userNotes?.trim() ? (
          <div className="card">
            <div className="card__head">
              <h2>I tuoi appunti</h2>
              <span className="faint">presi durante la conversazione</span>
            </div>
            <pre className="user-notes">{result.userNotes}</pre>
          </div>
        ) : null}

      <div className="card">
        <div className="card__head">
          <h2>Riassunto</h2>
          <button type="button" className="btn btn--ghost" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Anteprima' : 'Modifica'}
          </button>
        </div>
        {editing ? (
          <textarea
            value={summary}
            style={{ minHeight: 360 }}
            onChange={(event) => setSummary(event.target.value)}
          />
        ) : (
          <Markdown source={summary} />
        )}
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Registrazione e trascrizione ({result.segments.length} interventi)</h2>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setShowTranscript((value) => !value)}
          >
            {showTranscript ? 'Nascondi trascrizione' : 'Mostra trascrizione'}
          </button>
        </div>

        {audioUrl ? (
          <>
            <AudioPlayer player={player} />
            <p className="faint" style={{ marginTop: 10, marginBottom: showTranscript ? 14 : 0 }}>
              Clicca una battuta per riascoltarla da quel punto. L'audio viene salvato insieme al
              riassunto.
            </p>
          </>
        ) : (
          <p className="faint" style={{ marginTop: 0 }}>
            L'audio non viene conservato: puoi attivarlo in Impostazioni.
          </p>
        )}

        <VoiceNames
          segments={result.segments}
          labels={labels}
          voiceNames={voiceNames}
          onChange={setVoiceNames}
          onSeek={audioUrl ? player.seek : undefined}
        />

        {showTranscript && (
          <Transcript
            segments={result.segments}
            labels={labels}
            voiceNames={voiceNames}
            onSeek={audioUrl ? player.seek : undefined}
            currentTimeMs={audioUrl ? player.currentTime * 1000 : undefined}
            follow={player.playing}
          />
        )}
      </div>

      <div className="row row--wrap" style={{ marginTop: 22 }}>
        <button
          type="button"
          className="btn btn--primary btn--lg"
          onClick={() => onSave({ title, folderId, summary, voiceNames })}
          disabled={saving}
        >
          {saving ? 'Salvataggio…' : 'Salva nella libreria'}
        </button>
        <button type="button" className="btn" onClick={() => onExport(title, summary, false)}>
          Esporta .md
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn--danger" onClick={onDiscard} disabled={saving}>
          Scarta
        </button>
      </div>
    </>
  )
}
