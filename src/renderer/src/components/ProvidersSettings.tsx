import { useCallback, useEffect, useState } from 'react'
import type { ProviderCheck, ProviderConfig, ProviderKind, ProviderView } from '@shared/types'

interface PullProgress {
  model: string
  status: string
  completed: number
  total: number
  done: boolean
}

const KIND_LABEL: Record<ProviderKind, string> = {
  ollama: 'Ollama',
  openai: 'Compatibile OpenAI',
  anthropic: 'API Anthropic',
  'claude-code': 'Claude Code'
}

interface Preset {
  label: string
  hint: string
  make: () => Omit<ProviderConfig, 'id'>
}

const BLANK = { contextLength: 0, cliPath: '' }

const PRESETS: Preset[] = [
  {
    label: 'Ollama su questo computer',
    hint: 'Tutto resta in locale.',
    make: () => ({ ...BLANK, name: 'Ollama locale', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: '' })
  },
  {
    label: 'Ollama su un altro computer',
    hint: 'Un server Ollama in rete, per esempio con una GPU più potente.',
    make: () => ({ ...BLANK, name: 'Ollama remoto', kind: 'ollama', baseUrl: 'http://', model: '' })
  },
  {
    label: 'OpenRouter',
    hint: 'Centinaia di modelli con una sola chiave API.',
    make: () => ({ ...BLANK, name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '' })
  },
  {
    label: 'Compatibile OpenAI',
    hint: 'Hermes, LM Studio, llama.cpp server, vLLM o qualsiasi servizio con /v1/chat/completions.',
    make: () => ({ ...BLANK, name: 'Server compatibile OpenAI', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: '' })
  },
  {
    label: 'Claude (API Anthropic)',
    hint: 'Con una chiave API di console.anthropic.com, a consumo.',
    make: () => ({ ...BLANK, name: 'Claude', kind: 'anthropic', baseUrl: '', model: 'claude-opus-5-5' })
  },
  {
    label: 'Claude Code',
    hint: 'Usa il tuo abbonamento Claude tramite il comando "claude" già installato.',
    make: () => ({ ...BLANK, name: 'Claude Code', kind: 'claude-code', baseUrl: '', model: 'sonnet' })
  }
]

const SUGGESTED_OLLAMA = ['qwen2.5:7b', 'llama3.2:3b', 'gemma2:9b', 'qwen2.5:14b']

function needsKey(kind: ProviderKind): 'required' | 'optional' | 'none' {
  if (kind === 'anthropic') return 'required'
  if (kind === 'openai') return 'optional'
  return 'none'
}

export function ProvidersSettings({
  pull,
  onChanged
}: {
  pull: PullProgress | null
  /** Called after anything was saved, so the rest of the app reloads. */
  onChanged: () => void
}): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [defaultId, setDefaultId] = useState('')
  const [encrypted, setEncrypted] = useState(true)
  const [checks, setChecks] = useState<Record<string, ProviderCheck | 'checking'>>({})
  const [draft, setDraft] = useState<ProviderConfig | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [keyInput, setKeyInput] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [pullModel, setPullModel] = useState('')
  const [pullTarget, setPullTarget] = useState('')

  const load = useCallback(async (): Promise<ProviderView[]> => {
    const list = await window.notebro.providers.list()
    setProviders(list.providers)
    setDefaultId(list.defaultProviderId)
    setEncrypted(list.encryptionAvailable)
    return list.providers
  }, [])

  const check = useCallback(async (id: string): Promise<void> => {
    setChecks((previous) => ({ ...previous, [id]: 'checking' }))
    const result = await window.notebro.providers.check(id)
    setChecks((previous) => ({ ...previous, [id]: result }))
  }, [])

  useEffect(() => {
    void load().then((list) => list.forEach((provider) => void check(provider.id)))
  }, [load, check])

  const startEditing = (provider: ProviderConfig, fresh: boolean): void => {
    setDraft({ ...provider })
    setIsNew(fresh)
    setKeyInput(undefined)
    setError(null)
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim()) {
      setError('Dai un nome al servizio.')
      return
    }
    if ((draft.kind === 'ollama' || draft.kind === 'openai') && !/^https?:\/\/.+/.test(draft.baseUrl.trim())) {
      setError("L'indirizzo deve iniziare con http:// o https://")
      return
    }
    try {
      await window.notebro.providers.save(
        { ...draft, name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), model: draft.model.trim() },
        keyInput
      )
      const id = draft.id
      setDraft(null)
      await load()
      onChanged()
      void check(id)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  const remove = async (provider: ProviderView): Promise<void> => {
    if (!window.confirm(`Eliminare "${provider.name}"? La sua chiave API viene cancellata.`)) return
    try {
      await window.notebro.providers.remove(provider.id)
      await load()
      onChanged()
    } catch (caught) {
      setError((caught as Error).message)
    }
  }

  const makeDefault = async (id: string): Promise<void> => {
    await window.notebro.settings.set({ defaultProviderId: id })
    setDefaultId(id)
    onChanged()
  }

  const draftCheck = draft ? checks[draft.id] : undefined
  const draftModels = draftCheck && draftCheck !== 'checking' ? draftCheck.models : []

  return (
    <div className="card">
      <h2>Riassunto — servizi</h2>
      <p className="faint" style={{ marginTop: 0 }}>
        I servizi che possono scrivere il riassunto. Quello predefinito si usa per ogni nuova
        registrazione; prima di iniziare puoi sceglierne un altro. La trascrizione resta sempre in
        locale con whisper: cambia solo chi scrive il riassunto.
      </p>

      {providers.map((provider) => {
        const status = checks[provider.id]
        return (
          <div key={provider.id} className="model-row">
            <div className="model-row__body">
              <div className="model-row__name">
                {provider.name}
                {provider.id === defaultId && (
                  <span className="pill" style={{ marginLeft: 8 }}>
                    predefinito
                  </span>
                )}
              </div>
              <div className="faint">
                {KIND_LABEL[provider.kind]}
                {provider.model ? ` · ${provider.model}` : ''}
                {provider.baseUrl && provider.kind !== 'anthropic' ? ` · ${provider.baseUrl}` : ''}
              </div>
              <div className="row row--wrap" style={{ marginTop: 6, gap: 6 }}>
                <span className="pill">
                  <span className={`dot ${provider.remote ? 'dot--warn' : 'dot--ok'}`} />
                  {provider.remote ? `Invia la trascrizione a ${provider.destination}` : 'In locale'}
                </span>
                <span className="pill">
                  <span
                    className={`dot ${status === 'checking' || !status ? 'dot--warn' : status.ok ? 'dot--ok' : 'dot--bad'}`}
                  />
                  {status === 'checking' || !status ? 'Verifica…' : status.detail}
                </span>
              </div>
              {provider.kind === 'ollama' && status && status !== 'checking' && status.canStart && (
                <button
                  type="button"
                  className="btn"
                  style={{ marginTop: 8 }}
                  onClick={() =>
                    void window.notebro.ollama
                      .start(provider.baseUrl)
                      .then(() => check(provider.id))
                      .catch((caught: Error) => setError(caught.message))
                  }
                >
                  Avvia Ollama
                </button>
              )}
            </div>
            <div className="row row--wrap" style={{ gap: 6 }}>
              {provider.id !== defaultId && (
                <button type="button" className="btn btn--ghost" onClick={() => void makeDefault(provider.id)}>
                  Usa come predefinito
                </button>
              )}
              <button type="button" className="btn btn--ghost" onClick={() => void check(provider.id)}>
                Verifica
              </button>
              <button type="button" className="btn" onClick={() => startEditing(provider, false)}>
                Modifica
              </button>
              {providers.length > 1 && (
                <button type="button" className="btn btn--ghost" onClick={() => void remove(provider)}>
                  Elimina
                </button>
              )}
            </div>
          </div>
        )
      })}

      {!draft && (
        <>
          <h2 style={{ marginTop: 20 }}>Aggiungi un servizio</h2>
          <div className="grid-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="btn"
                style={{ textAlign: 'left', whiteSpace: 'normal', height: 'auto', padding: '10px 12px' }}
                onClick={() => startEditing({ id: crypto.randomUUID(), ...preset.make() }, true)}
              >
                <strong>{preset.label}</strong>
                <br />
                <span className="faint">{preset.hint}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {draft && (
        <div className="card" style={{ marginTop: 18, marginBottom: 0 }}>
          <h2>
            {isNew ? 'Nuovo servizio' : `Modifica "${draft.name}"`} · {KIND_LABEL[draft.kind]}
          </h2>

          <label className="field">
            <span>Nome, per riconoscerlo</span>
            <input
              type="text"
              value={draft.name}
              placeholder="es. Ollama del server in ufficio"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>

          {(draft.kind === 'ollama' || draft.kind === 'openai') && (
            <label className="field">
              <span>Indirizzo</span>
              <input
                type="text"
                value={draft.baseUrl}
                placeholder={draft.kind === 'ollama' ? 'http://192.168.1.20:11434' : 'https://example.com/v1'}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </label>
          )}

          {needsKey(draft.kind) !== 'none' && (
            <label className="field">
              <span>
                Chiave API{needsKey(draft.kind) === 'optional' ? ' (se il servizio la richiede)' : ''}
              </span>
              <input
                type="password"
                autoComplete="off"
                value={keyInput ?? ''}
                placeholder={
                  !isNew && providers.find((provider) => provider.id === draft.id)?.hasApiKey
                    ? 'Salvata — scrivi qui per sostituirla'
                    : 'Incolla la chiave'
                }
                onChange={(event) => setKeyInput(event.target.value)}
              />
            </label>
          )}
          {needsKey(draft.kind) !== 'none' &&
            !isNew &&
            providers.find((provider) => provider.id === draft.id)?.hasApiKey && (
              <button
                type="button"
                className="link"
                style={{ marginBottom: 12 }}
                onClick={() => setKeyInput('')}
              >
                Rimuovi la chiave salvata
              </button>
            )}
          {needsKey(draft.kind) !== 'none' && !encrypted && (
            <p className="banner banner--warn">
              Su questo sistema non c'è un portachiavi disponibile (GNOME Keyring o KWallet): la
              chiave viene salvata senza cifratura, in un file leggibile solo dal tuo utente.
            </p>
          )}

          <label className="field">
            <span>Modello</span>
            <input
              type="text"
              list={`models-${draft.id}`}
              value={draft.model}
              placeholder={
                draft.kind === 'claude-code'
                  ? 'opus, sonnet, haiku o il nome completo'
                  : draft.kind === 'openai' && draft.baseUrl.includes('openrouter')
                    ? 'es. anthropic/claude-sonnet-5.5 o qwen/qwen-2.5-72b-instruct'
                    : 'Nome del modello'
              }
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            />
            <datalist id={`models-${draft.id}`}>
              {draftModels.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
          {!isNew && draftModels.length > 0 && (
            <p className="faint" style={{ marginTop: -6 }}>
              {draftModels.length} modelli disponibili: inizia a scrivere per filtrarli.
            </p>
          )}
          {isNew && (
            <p className="faint" style={{ marginTop: -6 }}>
              Dopo il salvataggio NoteBro verifica il servizio e ti propone i modelli disponibili.
            </p>
          )}

          {draft.kind === 'claude-code' && (
            <label className="field">
              <span>Percorso di "claude" (facoltativo)</span>
              <input
                type="text"
                value={draft.cliPath}
                placeholder="Cercato nel PATH"
                onChange={(event) => setDraft({ ...draft, cliPath: event.target.value })}
              />
            </label>
          )}

          <label className="field">
            <span>Finestra di contesto in token (facoltativo)</span>
            <input
              type="number"
              min={0}
              value={draft.contextLength || ''}
              placeholder="Automatica"
              onChange={(event) => setDraft({ ...draft, contextLength: Number(event.target.value) || 0 })}
            />
          </label>

          {draft.kind !== 'ollama' || !/^https?:\/\/(127\.|localhost)/.test(draft.baseUrl) ? (
            <p className="banner banner--warn">
              Con questo servizio la trascrizione completa della call e i tuoi appunti escono dal
              computer. Usalo solo se hai il consenso delle persone registrate e se le condizioni del
              servizio vanno bene per il contenuto delle tue call.
            </p>
          ) : null}

          {error && <p className="banner banner--error">{error}</p>}

          <div className="row row--wrap">
            <button type="button" className="btn btn--primary" onClick={() => void save()}>
              Salva
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setDraft(null)}>
              Annulla
            </button>
          </div>
        </div>
      )}

      {!draft && error && <p className="banner banner--error" style={{ marginTop: 14 }}>{error}</p>}

      {providers.some((provider) => provider.kind === 'ollama') && (
        <>
          <h2 style={{ marginTop: 20 }}>Scarica un modello Ollama</h2>
          <div className="row row--wrap">
            <select
              value={pullTarget || providers.find((provider) => provider.kind === 'ollama')?.id}
              onChange={(event) => setPullTarget(event.target.value)}
            >
              {providers
                .filter((provider) => provider.kind === 'ollama')
                .map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
            </select>
            <input
              type="text"
              value={pullModel}
              placeholder="es. qwen2.5:7b"
              onChange={(event) => setPullModel(event.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={!pullModel.trim() || Boolean(pull && !pull.done)}
              onClick={() => {
                const target =
                  providers.find((provider) => provider.id === pullTarget) ??
                  providers.find((provider) => provider.kind === 'ollama')
                if (!target) return
                void window.notebro.ollama
                  .pull(target.baseUrl, pullModel.trim())
                  .then(() => check(target.id))
                  .catch((caught: Error) => setError(caught.message))
              }}
            >
              Scarica
            </button>
          </div>
          <div className="row row--wrap" style={{ marginTop: 8, gap: 6 }}>
            {SUGGESTED_OLLAMA.map((name) => (
              <button key={name} type="button" className="btn btn--ghost" onClick={() => setPullModel(name)}>
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
                  style={{ width: `${pull.total > 0 ? Math.round((pull.completed / pull.total) * 100) : 0}%` }}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
