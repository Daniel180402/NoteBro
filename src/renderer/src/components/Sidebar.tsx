import { useState } from 'react'
import type { Library, WhisperStatus } from '@shared/types'

export const ALL_NOTES = 'all'
export const UNFILED = 'unfiled'

interface SidebarProps {
  library: Library
  selection: string
  onSelect: (selection: string) => void
  onNewRecording: () => void
  onOpenSettings: () => void
  onCreateFolder: (name: string) => void
  onRenameFolder: (id: string, name: string) => void
  onDeleteFolder: (id: string, name: string) => void
  whisper: WhisperStatus | null
  /** The summary service for the next recording, and whether it answers. */
  summary: { name: string; ok: boolean | null; remote: boolean } | null
  /** The recording under way, which goes on while other screens are open. */
  recording: { elapsedMs: number; paused: boolean; current: boolean } | null
  onResumeRecording: () => void
  /** Stopped recordings still being transcribed and summarised, when not on screen. */
  processing: { count: number; failed: boolean } | null
  onResumeProcessing: () => void
  /** Finished summaries that have not been filed yet. */
  pendingResults: number
  onResumeResult: () => void
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}

export function Sidebar({
  library,
  selection,
  onSelect,
  onNewRecording,
  onOpenSettings,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  whisper,
  summary,
  recording,
  onResumeRecording,
  processing,
  onResumeProcessing,
  pendingResults,
  onResumeResult
}: SidebarProps): React.JSX.Element {
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  const countIn = (folderId: string | null): number =>
    library.notes.filter((note) => note.folderId === folderId).length

  const submitFolder = (): void => {
    const name = (newFolder ?? '').trim()
    if (name) onCreateFolder(name)
    setNewFolder(null)
  }

  const modelReady = Boolean(whisper?.available && whisper.models.some((model) => model.installed))

  return (
    <aside className="sidebar">
      <div className="sidebar__drag" />
      <div className="sidebar__brand">
        <div className="sidebar__logo">NB</div>
        <div className="sidebar__title">NoteBro</div>
      </div>

      <div style={{ padding: '0 12px 6px' }}>
        {recording ? (
          <button
            type="button"
            className={`btn btn--block live-recording${recording.current ? ' live-recording--current' : ''}`}
            onClick={onResumeRecording}
            title="La registrazione continua anche mentre guardi altro"
          >
            <span className={`live-recording__dot${recording.paused ? ' live-recording__dot--paused' : ''}`} />
            {recording.paused ? 'In pausa' : 'Registrazione'} · {clock(recording.elapsedMs)}
          </button>
        ) : (
          <button type="button" className="btn btn--primary btn--block" onClick={onNewRecording}>
            Nuova registrazione
          </button>
        )}

        {processing && (
          <button
            type="button"
            className="btn btn--block pending"
            onClick={onResumeProcessing}
            style={{ marginTop: 8 }}
          >
            <span className="pending__dot" />
            {processing.failed
              ? 'Elaborazione non riuscita'
              : `Elaborazione in corso${processing.count > 1 ? ` (${processing.count})` : '…'}`}
          </button>
        )}

        {pendingResults > 0 && (
          <button
            type="button"
            className="btn btn--block pending"
            onClick={onResumeResult}
            style={{ marginTop: 8 }}
          >
            <span className="pending__dot" />
            {pendingResults > 1 ? `${pendingResults} riassunti da salvare` : 'Riassunto da salvare'}
          </button>
        )}
      </div>

      <div className="sidebar__scroll">
        <div className="sidebar__section">Libreria</div>
        <button
          type="button"
          className={`folder${selection === ALL_NOTES ? ' folder--active' : ''}`}
          onClick={() => onSelect(ALL_NOTES)}
        >
          <span className="folder__name">Tutti i riassunti</span>
          <span className="folder__count">{library.notes.length}</span>
        </button>
        <button
          type="button"
          className={`folder${selection === UNFILED ? ' folder--active' : ''}`}
          onClick={() => onSelect(UNFILED)}
        >
          <span className="folder__name">Senza cartella</span>
          <span className="folder__count">{countIn(null)}</span>
        </button>

        <div className="sidebar__section">
          <span>Cartelle</span>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ padding: '0 4px', fontSize: 16, lineHeight: 1 }}
            title="Nuova cartella"
            onClick={() => setNewFolder('')}
          >
            +
          </button>
        </div>

        {newFolder !== null && (
          <div style={{ padding: '2px 4px 8px' }}>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              type="text"
              autoFocus
              value={newFolder}
              placeholder="Nome cartella"
              onChange={(event) => setNewFolder(event.target.value)}
              onBlur={submitFolder}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitFolder()
                if (event.key === 'Escape') setNewFolder(null)
              }}
            />
          </div>
        )}

        {library.folders.length === 0 && newFolder === null && (
          <p className="faint" style={{ padding: '4px 10px' }}>
            Nessuna cartella. Creane una per categorizzare i riassunti.
          </p>
        )}

        {library.folders.map((folder) =>
          renaming?.id === folder.id ? (
            <div key={folder.id} style={{ padding: '2px 4px 8px' }}>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input
                type="text"
                autoFocus
                value={renaming.name}
                onChange={(event) => setRenaming({ id: folder.id, name: event.target.value })}
                onBlur={() => {
                  if (renaming.name.trim()) onRenameFolder(folder.id, renaming.name)
                  setRenaming(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') setRenaming(null)
                }}
              />
            </div>
          ) : (
            <div
              key={folder.id}
              className={`folder${selection === folder.id ? ' folder--active' : ''}`}
            >
              <button
                type="button"
                className="folder__label"
                onClick={() => onSelect(folder.id)}
                title={folder.name}
              >
                <span className="folder__name">{folder.name}</span>
              </button>
              <span className="folder__count">{countIn(folder.id)}</span>
              <button
                type="button"
                className="folder__action"
                title="Rinomina"
                aria-label={`Rinomina ${folder.name}`}
                onClick={() => setRenaming({ id: folder.id, name: folder.name })}
              >
                ✎
              </button>
              <button
                type="button"
                className="folder__action folder__action--danger"
                title="Elimina"
                aria-label={`Elimina ${folder.name}`}
                onClick={() => onDeleteFolder(folder.id, folder.name)}
              >
                ×
              </button>
            </div>
          )
        )}
      </div>

      <div className="sidebar__footer">
        <div className="row row--wrap" style={{ gap: 6, marginBottom: 9 }}>
          <span className="pill" title={whisper?.binaryPath ?? 'whisper.cpp non trovato'}>
            <span className={`dot ${modelReady ? 'dot--ok' : 'dot--bad'}`} />
            Trascrizione
          </span>
          <span
            className="pill"
            title={summary?.remote ? 'Il riassunto viene scritto da un servizio in rete' : 'Riassunto in locale'}
          >
            <span
              className={`dot ${summary?.ok ? 'dot--ok' : summary?.ok === false ? 'dot--bad' : 'dot--warn'}`}
            />
            {summary?.name ?? 'Riassunto'}
          </span>
        </div>
        <button type="button" className="btn btn--ghost btn--block" onClick={onOpenSettings}>
          Impostazioni
        </button>
      </div>
    </aside>
  )
}
