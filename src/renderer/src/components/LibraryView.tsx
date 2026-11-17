import { useMemo, useState } from 'react'
import type { Folder, Library, Note, NoteMeta, Settings } from '@shared/types'
import { useAudioPlayer } from '../audio/useAudioPlayer'
import { formatDate, formatDuration } from '../format'
import { AudioPlayer } from './AudioPlayer'
import { Markdown } from './Markdown'
import { Transcript } from './Transcript'
import { VoiceNames } from './VoiceNames'
import { ALL_NOTES, UNFILED } from './Sidebar'

interface NotesListProps {
  library: Library
  selection: string
  onOpen: (id: string) => void
  onNewRecording: () => void
}

function headingFor(library: Library, selection: string): string {
  if (selection === ALL_NOTES) return 'Tutti i riassunti'
  if (selection === UNFILED) return 'Senza cartella'
  return library.folders.find((folder) => folder.id === selection)?.name ?? 'Cartella'
}

export function NotesList({
  library,
  selection,
  onOpen,
  onNewRecording
}: NotesListProps): React.JSX.Element {
  const [query, setQuery] = useState('')

  const notes = useMemo(() => {
    const inScope = library.notes.filter((note) => {
      if (selection === ALL_NOTES) return true
      if (selection === UNFILED) return note.folderId === null
      return note.folderId === selection
    })
    const needle = query.trim().toLowerCase()
    if (!needle) return inScope
    return inScope.filter(
      (note) =>
        note.title.toLowerCase().includes(needle) ||
        note.excerpt.toLowerCase().includes(needle)
    )
  }, [library.notes, selection, query])

  return (
    <>
      <div className="row row--between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1>{headingFor(library, selection)}</h1>
          <p className="subtitle" style={{ marginBottom: 18 }}>
            {notes.length === 1 ? '1 riassunto' : `${notes.length} riassunti`}
          </p>
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <input
          type="search"
          placeholder="Cerca per titolo o contenuto"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {notes.length === 0 ? (
        <div className="empty">
          <div className="empty__title">
            {query ? 'Nessun risultato' : 'Ancora nessun riassunto qui'}
          </div>
          <p>
            {query
              ? 'Prova con altre parole.'
              : 'Avvia una registrazione: al termine il riassunto finirà in questa libreria.'}
          </p>
          {!query && (
            <button
              type="button"
              className="btn btn--primary"
              style={{ marginTop: 12 }}
              onClick={onNewRecording}
            >
              Nuova registrazione
            </button>
          )}
        </div>
      ) : (
        notes.map((note: NoteMeta) => (
          <button
            key={note.id}
            type="button"
            className="note-item"
            onClick={() => onOpen(note.id)}
          >
            <div className="note-item__title">{note.title}</div>
            <div className="note-item__meta">
              <span>{formatDate(note.createdAt)}</span>
              <span>{formatDuration(note.durationMs)}</span>
              <span>{note.language}</span>
              {note.folderId && selection === ALL_NOTES && (
                <span>
                  {library.folders.find((folder) => folder.id === note.folderId)?.name ?? ''}
                </span>
              )}
            </div>
            <div className="note-item__excerpt">{note.excerpt}</div>
          </button>
        ))
      )}
    </>
  )
}

interface NoteDetailProps {
  note: Note
  folders: Folder[]
  labels: Settings['speakerLabels']
  onBack: () => void
  onUpdate: (patch: {
    title?: string
    folderId?: string | null
    summary?: string
    voiceNames?: Record<string, string>
  }) => void
  onDelete: () => void
  onExport: (withTranscript: boolean) => void
  onReveal: () => void
}

export function NoteDetail({
  note,
  folders,
  labels,
  onBack,
  onUpdate,
  onDelete,
  onExport,
  onReveal
}: NoteDetailProps): React.JSX.Element {
  const [title, setTitle] = useState(note.title)
  const [summary, setSummary] = useState(note.summary)
  const [editing, setEditing] = useState(false)
  const [showTranscript, setShowTranscript] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const player = useAudioPlayer(note.hasAudio ? `notebro-audio://note/${note.id}` : null)
  const [voiceNames, setVoiceNames] = useState<Record<string, string>>(note.voiceNames ?? {})

  return (
    <>
      <button type="button" className="btn btn--ghost" onClick={onBack} style={{ marginBottom: 14 }}>
        ← Torna alla libreria
      </button>

      <div className="card">
        <label className="field">
          <span>Titolo</span>
          <input
            type="text"
            className="title-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => title.trim() && title !== note.title && onUpdate({ title })}
          />
        </label>

        <label className="field" style={{ marginBottom: 0 }}>
          <span>Cartella</span>
          <select
            value={note.folderId ?? ''}
            onChange={(event) => onUpdate({ folderId: event.target.value || null })}
          >
            <option value="">Senza cartella</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </label>

        <div className="row row--wrap faint" style={{ marginTop: 16, gap: 14 }}>
          <span>{formatDate(note.createdAt)}</span>
          <span>Durata {formatDuration(note.durationMs)}</span>
          <span>Lingua {note.language}</span>
          <span>Whisper {note.models.whisper}</span>
          <span>{note.models.provider ?? 'Ollama'} · {note.models.ollama}</span>
        </div>
      </div>

        {note.userNotes?.trim() ? (
          <div className="card">
            <div className="card__head">
              <h2>I tuoi appunti</h2>
              <span className="faint">presi durante la conversazione</span>
            </div>
            <pre className="user-notes">{note.userNotes}</pre>
          </div>
        ) : null}

      <div className="card">
        <div className="card__head">
          <h2>Riassunto</h2>
          <div className="row">
            {editing && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  onUpdate({ summary })
                  setEditing(false)
                }}
              >
                Salva modifiche
              </button>
            )}
            <button type="button" className="btn btn--ghost" onClick={() => setEditing((v) => !v)}>
              {editing ? 'Annulla' : 'Modifica'}
            </button>
          </div>
        </div>
        {editing ? (
          <textarea
            value={summary}
            style={{ minHeight: 360 }}
            onChange={(event) => setSummary(event.target.value)}
          />
        ) : (
          <Markdown source={note.summary} />
        )}
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Registrazione e trascrizione</h2>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setShowTranscript((value) => !value)}
          >
            {showTranscript ? 'Nascondi trascrizione' : 'Mostra trascrizione'}
          </button>
        </div>

        {note.hasAudio ? (
          <>
            <AudioPlayer player={player} />
            <p className="faint" style={{ marginTop: 10, marginBottom: showTranscript ? 14 : 0 }}>
              Clicca una battuta per riascoltarla da quel punto.
            </p>
          </>
        ) : (
          <p className="faint" style={{ marginTop: 0 }}>
            Per questa nota non è stato conservato l'audio.
          </p>
        )}

        <VoiceNames
          segments={note.segments}
          labels={labels}
          voiceNames={voiceNames}
          onChange={(next) => {
            setVoiceNames(next)
            onUpdate({ voiceNames: next })
          }}
          onSeek={note.hasAudio ? player.seek : undefined}
        />

        {showTranscript && (
          <Transcript
            segments={note.segments}
            labels={labels}
            voiceNames={voiceNames}
            onSeek={note.hasAudio ? player.seek : undefined}
            currentTimeMs={note.hasAudio ? player.currentTime * 1000 : undefined}
            follow={player.playing}
          />
        )}
      </div>

      <div className="row row--wrap" style={{ marginTop: 22 }}>
        <button type="button" className="btn" onClick={() => onExport(false)}>
          Esporta riassunto
        </button>
        <button type="button" className="btn" onClick={() => onExport(true)}>
          Esporta con trascrizione
        </button>
        <button type="button" className="btn" onClick={onReveal}>
          {/Mac/.test(navigator.platform) ? 'Mostra nel Finder' : 'Mostra nella cartella'}
        </button>
        <span className="spacer" />
        {confirmDelete ? (
          <>
            <span className="faint">Eliminare definitivamente?</span>
            <button type="button" className="btn btn--danger" onClick={onDelete}>
              Sì, elimina
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>
              No
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--danger" onClick={() => setConfirmDelete(true)}>
            Elimina
          </button>
        )}
      </div>
    </>
  )
}
