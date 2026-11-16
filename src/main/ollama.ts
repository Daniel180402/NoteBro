import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { speakerName, voicesIn } from '@shared/speakers'
import { renderOutline, templateById } from '@shared/templates'
import { LANGUAGE_NAMES, type OllamaStatus, type Segment, type Settings } from '@shared/types'

interface TagsResponse {
  models?: Array<{
    name: string
    size?: number
    details?: { context_length?: number }
  }>
}

const DEFAULT_CONTEXT = 8192
/** Head-room inside the context window for the prompt scaffolding and answer. */
const RESERVED_TOKENS = 1500
/** Rough characters-per-token ratio for European languages. */
const CHARS_PER_TOKEN = 3.6

function ollamaCli(): string | null {
  const names = process.platform === 'win32' ? ['ollama.exe'] : ['ollama']
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama')
  ].filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

async function tags(baseUrl: string, timeoutMs = 2500): Promise<TagsResponse | null> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) return null
    return (await response.json()) as TagsResponse
  } catch {
    return null
  }
}

export async function status(baseUrl: string): Promise<OllamaStatus> {
  const data = await tags(baseUrl)
  return {
    running: data !== null,
    baseUrl,
    cliFound: ollamaCli() !== null,
    models: (data?.models ?? []).map((model) => ({
      name: model.name,
      sizeBytes: model.size ?? 0
    }))
  }
}

/** Launches `ollama serve` detached, then waits for the API to answer. */
export async function startServer(baseUrl: string): Promise<OllamaStatus> {
  const cli = ollamaCli()
  if (!cli) throw new Error('Ollama non è installato su questo computer.')

  const child = spawn(cli, ['serve'], { detached: true, stdio: 'ignore' })
  child.unref()

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const data = await tags(baseUrl, 1000)
    if (data) break
  }
  return status(baseUrl)
}

export interface PullProgress {
  model: string
  status: string
  completed: number
  total: number
  done: boolean
  error?: string
}

export async function pullModel(
  baseUrl: string,
  model: string,
  onProgress: (progress: PullProgress) => void
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true })
  })
  if (!response.ok || !response.body) {
    throw new Error(`Download del modello fallito (HTTP ${response.status}).`)
  }

  for await (const line of ndjson(response.body)) {
    const payload = line as { status?: string; completed?: number; total?: number; error?: string }
    if (payload.error) throw new Error(payload.error)
    onProgress({
      model,
      status: payload.status ?? '',
      completed: payload.completed ?? 0,
      total: payload.total ?? 0,
      done: payload.status === 'success'
    })
  }
  onProgress({ model, status: 'success', completed: 1, total: 1, done: true })
}

/** Yields each JSON object from a newline-delimited JSON stream. */
async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
          try {
            yield JSON.parse(line)
          } catch {
            // Ignore partial or malformed lines.
          }
        }
        newline = buffer.indexOf('\n')
      }
    }
    const rest = buffer.trim()
    if (rest) {
      try {
        yield JSON.parse(rest)
      } catch {
        // Ignore trailing noise.
      }
    }
  } finally {
    reader.releaseLock()
  }
}

interface ChatOptions {
  baseUrl: string
  model: string
  system: string
  user: string
  numCtx: number
  onToken?: (token: string) => void
  signal?: AbortSignal
}

async function chat(options: ChatOptions): Promise<string> {
  const response = await fetch(`${options.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.model,
      stream: true,
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.user }
      ],
      options: { temperature: 0.2, top_p: 0.9, num_ctx: options.numCtx }
    }),
    signal: options.signal
  })

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Ollama ha risposto HTTP ${response.status}. ${detail.slice(0, 200)}`)
  }

  let output = ''
  for await (const line of ndjson(response.body)) {
    const payload = line as {
      message?: { content?: string }
      error?: string
      done?: boolean
    }
    if (payload.error) throw new Error(payload.error)
    const token = payload.message?.content
    if (token) {
      output += token
      options.onToken?.(token)
    }
  }
  return output.trim()
}

function timecode(ms: number): string {
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function renderTranscript(
  segments: Segment[],
  labels: Settings['speakerLabels'],
  voiceNames?: Record<string, string>
): string {
  return segments
    .map(
      (segment) =>
        `[${timecode(segment.from)}] ${speakerName(segment, labels, voiceNames)}: ${segment.text}`
    )
    .join('\n')
}

function systemPrompt(
  languageName: string,
  labels: Settings['speakerLabels'],
  userName: string,
  voices: number[],
  vocabulary: string,
  userNotes: string
): string {
  const sources = userNotes
    ? 'nella trascrizione o negli appunti di chi registrava'
    : 'nella trascrizione'

  const rules = [
    'Sei un assistente che redige verbali di call e colloqui a partire da trascrizioni automatiche.',
    `Scrivi SEMPRE e soltanto in ${languageName}.`,
    'Regole rigide:',
    `- Usa esclusivamente informazioni presenti ${sources}: non inventare nomi, cifre, date o impegni.`,
    '- La trascrizione è automatica e può contenere errori: se un passaggio è incomprensibile, ignoralo invece di indovinare.',
    '- Attribuisci correttamente le affermazioni a chi le ha dette.',
    '- Se una sezione non ha contenuto, scrivi "—" invece di riempirla.',
    '- Rispondi in Markdown, senza preamboli né commenti sul tuo lavoro.'
  ]

  if (voices.length > 1) {
    rules.push(
      `- Alla conversazione partecipano ${voices.length} persone oltre a chi registra, distinte nella trascrizione da etichette diverse: attribuisci a ciascuna ciò che ha detto e non confonderle.`
    )
  }

  if (userNotes) {
    rules.push(
      '- Chi registrava ha preso degli appunti durante la conversazione: sono la traccia di ciò che per lui conta.',
      '- Parti da quegli appunti e completali con la trascrizione: espandi ogni punto accennato, correggi ciò che la conversazione smentisce, aggiungi ciò che è stato detto e che gli è sfuggito.',
      '- Non limitarti a ricopiarli, e non ignorarli: il verbale deve sembrare i suoi appunti finiti.',
      '- Gli appunti sono una fonte legittima quanto la trascrizione: se contengono un nome, un impegno o una correzione che nessuno ha pronunciato, riportali comunque. Non sono invenzioni tue.'
    )
  }

  const terms = vocabulary.trim()
  if (terms) {
    rules.push(
      `- Questi nomi ricorrono nella conversazione e vanno scritti esattamente così: ${terms}. La trascrizione automatica può averli resi male: correggili.`
    )
  }

  const name = userName.trim()
  if (name) {
    rules.push(
      `- Chi ha registrato la conversazione si chiama ${name}, ed è la persona marcata "${labels.me}" nella trascrizione.`,
      `- Quando "${labels.them}" dice "${name}", o si rivolge direttamente a qualcuno, si riferisce a ${name}.`,
      `- Nelle azioni da fare scrivi "${name}" invece di "${labels.me}", così il verbale resta leggibile anche per altri.`
    )
  }

  return rules.join('\n')
}


export interface SummarizeOptions {
  baseUrl: string
  model: string
  language: string
  segments: Segment[]
  labels: Settings['speakerLabels']
  /** Empty when the user has not said who they are. */
  userName?: string
  /** Names given to the detected remote voices, keyed by voice index. */
  voiceNames?: Record<string, string>
  /** Recurring names the transcription may have mangled. */
  vocabulary?: string
  /** Notes the user typed while the conversation was happening. */
  userNotes?: string
  /** Which outline to follow. */
  templateId?: string
  contextLength?: number
  onToken: (token: string) => void
  onStage: (message: string, fraction: number | null) => void
  signal?: AbortSignal
}

export async function summarize(options: SummarizeOptions): Promise<string> {
  const languageName = LANGUAGE_NAMES[options.language] ?? LANGUAGE_NAMES.auto
  const system = systemPrompt(
    languageName,
    options.labels,
    options.userName ?? '',
    voicesIn(options.segments),
    options.vocabulary ?? '',
    (options.userNotes ?? '').trim()
  )
  const outline = renderOutline(templateById(options.templateId ?? ''))
  const notes = (options.userNotes ?? '').trim()
  const notesBlock = notes
    ? `\n\nAppunti presi da chi registrava, mentre la conversazione avveniva:\n\n${notes}\n`
    : ''
  const numCtx = Math.max(4096, Math.min(options.contextLength ?? DEFAULT_CONTEXT, 16_384))
  const budgetChars = Math.floor((numCtx - RESERVED_TOKENS) * CHARS_PER_TOKEN)

  const transcript = renderTranscript(options.segments, options.labels, options.voiceNames)
  if (!transcript.trim()) {
    return '## Sintesi\n\nLa registrazione non contiene parlato riconoscibile.\n'
  }

  if (transcript.length <= budgetChars) {
    options.onStage('Riassunto in corso…', null)
    return chat({
      baseUrl: options.baseUrl,
      model: options.model,
      system,
      numCtx,
      signal: options.signal,
      onToken: options.onToken,
      user: `Trascrizione della conversazione:\n\n${transcript}${notesBlock}\n\nRedigi il verbale con esattamente questa struttura:\n\n${outline}`
    })
  }

  // Too long for one pass: summarise slices, then synthesise the notes.
  const chunks = chunkTranscript(options.segments, options.labels, budgetChars, options.voiceNames)
  const partials: string[] = []

  for (const [index, chunk] of chunks.entries()) {
    options.onStage(
      `Analisi della parte ${index + 1} di ${chunks.length}…`,
      index / (chunks.length + 1)
    )
    const note = await chat({
      baseUrl: options.baseUrl,
      model: options.model,
      system,
      numCtx,
      signal: options.signal,
      user: `Questa è la parte ${index + 1} di ${chunks.length} di una conversazione più lunga.\n\n${chunk}\n\nElenca in modo compatto: temi trattati, decisioni, azioni con responsabile, domande aperte, dati e nomi citati. Solo punti elenco, nessuna introduzione.`
    })
    partials.push(`### Parte ${index + 1}\n${note}`)
  }

  options.onStage('Sintesi finale…', chunks.length / (chunks.length + 1))
  return chat({
    baseUrl: options.baseUrl,
    model: options.model,
    system,
    numCtx,
    signal: options.signal,
    onToken: options.onToken,
    user: `Sintesi di parti successive della stessa conversazione:\n\n${partials.join('\n\n')}${notesBlock}\n\nUnificale in un unico verbale, eliminando le ripetizioni e mantenendo l'ordine cronologico. Usa esattamente questa struttura:\n\n${outline}`
  })
}

/** Splits on segment boundaries so no sentence is cut in half. */
function chunkTranscript(
  segments: Segment[],
  labels: Settings['speakerLabels'],
  budgetChars: number,
  voiceNames?: Record<string, string>
): string[] {
  const chunks: string[] = []
  let current = ''
  for (const segment of segments) {
    const line = `[${timecode(segment.from)}] ${speakerName(segment, labels, voiceNames)}: ${segment.text}\n`
    if (current.length + line.length > budgetChars && current) {
      chunks.push(current)
      current = ''
    }
    current += line
  }
  if (current.trim()) chunks.push(current)
  return chunks
}

export interface TitleOptions {
  baseUrl: string
  model: string
  language: string
  summary: string
  signal?: AbortSignal
}

export async function suggestTitle(options: TitleOptions): Promise<string> {
  const languageName = LANGUAGE_NAMES[options.language] ?? LANGUAGE_NAMES.auto
  const raw = await chat({
    baseUrl: options.baseUrl,
    model: options.model,
    numCtx: 4096,
    signal: options.signal,
    system: `Rispondi con un titolo solo, in ${languageName}, massimo 8 parole, senza virgolette, senza punto finale.`,
    user: `Proponi un titolo per questo verbale:\n\n${options.summary.slice(0, 2000)}`
  })
  return raw
    .split('\n')[0]
    .replace(/^["'*#\s-]+|["'*\s.]+$/g, '')
    .slice(0, 90)
}

export async function contextLengthOf(baseUrl: string, model: string): Promise<number> {
  const data = await tags(baseUrl)
  const entry = data?.models?.find((candidate) => candidate.name === model)
  return entry?.details?.context_length ?? DEFAULT_CONTEXT
}
