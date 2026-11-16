import { useState } from 'react'
import type { Library, OllamaStatus, WhisperStatus } from '@shared/types'

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
  ollama: OllamaStatus | null
  busy: boolean
  /** A finished summary that has not been filed yet. */
  pendingResult: boolean
  onResumeResult: () => void
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
  ollama,
  busy,
  pendingResult,
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
        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={onNewRecording}
          disabled={busy}
        >
          Nuova registrazione
        </button>

        {pendingResult && (
          <button
            type="button"
            className="btn btn--block pending"
            onClick={onResumeResult}
            style={{ marginTop: 8 }}
          >
            <span className="pending__dot" />
            Riassunto da salvare
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
          <span className="pill" title={ollama?.baseUrl}>
            <span className={`dot ${ollama?.running ? 'dot--ok' : 'dot--bad'}`} />
            Ollama
          </span>
        </div>
        <button type="button" className="btn btn--ghost btn--block" onClick={onOpenSettings}>
          Impostazioni
        </button>
      </div>
    </aside>
  )
}
