import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import type { ProviderCheck, ProviderConfig, ProviderView } from '@shared/types'
import { logLine } from './log'
import * as ollama from './ollama'
import type { ChatRequest, Llm } from './ollama'
import { getSecret, hasSecret } from './secrets'
import { destinationOf, hostOf, isLoopback, isRemote } from './provider-rules'
import { findExecutable } from './sysaudio'

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'

/** Models whose refusals the Claude API can hand to another model on its own. */
const FALLBACK_MODELS = new Set([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5'
])

export function viewOf(provider: ProviderConfig): ProviderView {
  return {
    ...provider,
    hasApiKey: hasSecret(provider.id),
    remote: isRemote(provider),
    destination: destinationOf(provider)
  }
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// OpenAI-compatible: OpenRouter, LM Studio, llama.cpp server, vLLM, Hermes…

function openAiHeaders(provider: ProviderConfig, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (hostOf(provider.baseUrl).endsWith('openrouter.ai')) {
    // Lets OpenRouter attribute traffic to the app; carries nothing about the user.
    headers['X-Title'] = 'NoteBro'
  }
  return headers
}

/** Yields the `data:` payloads of a server-sent events stream. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
        if (line.startsWith('data:')) yield line.slice(5).trim()
        newline = buffer.indexOf('\n')
      }
    }
    const rest = buffer.trim()
    if (rest.startsWith('data:')) yield rest.slice(5).trim()
  } finally {
    reader.releaseLock()
  }
}

async function openAiChat(provider: ProviderConfig, apiKey: string, request: ChatRequest): Promise<string> {
  const response = await fetch(`${trimSlash(provider.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: openAiHeaders(provider, apiKey),
    body: JSON.stringify({
      model: provider.model,
      stream: true,
      temperature: 0.2,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user }
      ]
    }),
    signal: request.signal
  })
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${provider.name} ha risposto HTTP ${response.status}. ${detail.slice(0, 300)}`)
  }

  let output = ''
  for await (const data of sse(response.body)) {
    if (data === '[DONE]') break
    let payload: {
      choices?: Array<{ delta?: { content?: string | null } }>
      error?: { message?: string } | string
    }
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    if (payload.error) {
      throw new Error(typeof payload.error === 'string' ? payload.error : (payload.error.message ?? 'errore'))
    }
    const token = payload.choices?.[0]?.delta?.content
    if (token) {
      output += token
      request.onToken?.(token)
    }
  }
  return output.trim()
}

interface OpenAiModel {
  id: string
  context_length?: number
}

async function openAiModels(provider: ProviderConfig, apiKey: string): Promise<OpenAiModel[]> {
  const response = await fetch(`${trimSlash(provider.baseUrl)}/models`, {
    headers: openAiHeaders(provider, apiKey),
    signal: AbortSignal.timeout(8000)
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}. ${detail.slice(0, 200)}`)
  }
  const json = (await response.json()) as { data?: OpenAiModel[] }
  return json.data ?? []
}

// ---------------------------------------------------------------------------
// Claude API

function anthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey })
}

async function anthropicChat(provider: ProviderConfig, apiKey: string, request: ChatRequest): Promise<string> {
  const client = anthropicClient(apiKey)
  const model = provider.model || DEFAULT_ANTHROPIC_MODEL
  const params = {
    model,
    max_tokens: 64000,
    system: request.system,
    messages: [{ role: 'user' as const, content: request.user }]
  }
  // On a policy decline, let the API retry on a model chosen for that case
  // instead of returning an empty summary.
  const stream = FALLBACK_MODELS.has(model)
    ? client.beta.messages.stream(
        { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
        { signal: request.signal }
      )
    : client.beta.messages.stream(params, { signal: request.signal })

  let output = ''
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      output += event.delta.text
      request.onToken?.(event.delta.text)
    }
  }
  const message = await stream.finalMessage()
  if (message.stop_reason === 'refusal') {
    throw new Error('Il modello ha rifiutato di riassumere questa conversazione.')
  }
  return output.trim()
}

function describeAnthropicError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return 'Chiave API non valida.'
  if (error instanceof Anthropic.PermissionDeniedError) return 'La chiave non ha accesso a questo modello.'
  if (error instanceof Anthropic.NotFoundError) return 'Modello non trovato.'
  if (error instanceof Anthropic.RateLimitError) return 'Limite di richieste raggiunto: riprova tra poco.'
  if (error instanceof Anthropic.APIConnectionError) return 'Impossibile raggiungere api.anthropic.com.'
  if (error instanceof Anthropic.APIError) return `Errore dell'API (${error.status}): ${error.message}`
  return (error as Error).message
}

// ---------------------------------------------------------------------------
// Claude Code CLI

function claudeBinary(provider: ProviderConfig): string | null {
  if (provider.cliPath && existsSync(provider.cliPath)) return provider.cliPath
  return findExecutable('claude')
}

/**
 * Runs `claude -p` with no tools, no project settings and no saved session, in
 * an empty folder: it only ever sees the prompt it is given.
 */
async function claudeCodeChat(provider: ProviderConfig, request: ChatRequest): Promise<string> {
  const binary = claudeBinary(provider)
  if (!binary) throw new Error('Claude Code non trovato: installalo o indica il percorso di "claude".')

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', '',
    '--safe-mode',
    '--no-session-persistence',
    '--system-prompt', request.system
  ]
  if (provider.model) args.push('--model', provider.model)

  const workdir = mkdtempSync(join(tmpdir(), 'notebro-claude-'))
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'] })
      let output = ''
      let result: string | null = null
      let failure: string | null = null
      let buffer = ''
      let stderrTail = ''

      const onAbort = (): void => {
        child.kill('SIGTERM')
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const handle = (line: string): void => {
        let payload: {
          type?: string
          subtype?: string
          is_error?: boolean
          result?: string
          event?: { type?: string; delta?: { type?: string; text?: string } }
        }
        try {
          payload = JSON.parse(line)
        } catch {
          return
        }
        const delta = payload.event?.delta
        if (payload.type === 'stream_event' && delta?.type === 'text_delta' && delta.text) {
          output += delta.text
          request.onToken?.(delta.text)
        } else if (payload.type === 'result') {
          if (payload.is_error || payload.subtype !== 'success') failure = payload.result ?? payload.subtype ?? 'errore'
          else result = payload.result ?? output
        }
      }

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          handle(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2000)
      })
      child.on('error', (error) => reject(new Error(`Avvio di Claude Code fallito: ${error.message}`)))
      child.on('close', (code) => {
        request.signal?.removeEventListener('abort', onAbort)
        if (buffer.trim()) handle(buffer)
        if (request.signal?.aborted) reject(new Error('Elaborazione annullata.'))
        else if (failure) reject(new Error(`Claude Code: ${failure}`))
        else if (result !== null) resolve(String(result).trim())
        else reject(new Error(`Claude Code è terminato senza risposta (codice ${code}). ${stderrTail.trim()}`.trim()))
      })

      // The transcript goes through stdin: no length limit, nothing in the process list.
      child.stdin.end(request.user)
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Public entry points

/** A ready client for a configured provider. */
export async function createLlm(provider: ProviderConfig): Promise<Llm> {
  const apiKey = getSecret(provider.id)
  switch (provider.kind) {
    case 'ollama': {
      const baseUrl = trimSlash(provider.baseUrl)
      const context = provider.contextLength || (await ollama.contextLengthOf(baseUrl, provider.model))
      return ollama.ollamaLlm(baseUrl, provider.model, context)
    }
    case 'openai': {
      let context = provider.contextLength
      if (!context) {
        // OpenRouter reports each model's window; other servers usually do not.
        const listed = await openAiModels(provider, apiKey).catch(() => [])
        context = listed.find((model) => model.id === provider.model)?.context_length ?? 32_768
      }
      return {
        contextTokens: context,
        maxPassTokens: 128_000,
        chat: (request) => openAiChat(provider, apiKey, request)
      }
    }
    case 'anthropic':
      if (!apiKey) throw new Error(`Manca la chiave API di "${provider.name}".`)
      return {
        contextTokens: provider.contextLength || 1_000_000,
        maxPassTokens: 150_000,
        chat: (request) =>
          anthropicChat(provider, apiKey, request).catch((error: unknown) => {
            throw new Error(describeAnthropicError(error))
          })
      }
    case 'claude-code':
      return {
        contextTokens: provider.contextLength || 200_000,
        maxPassTokens: 150_000,
        chat: (request) => claudeCodeChat(provider, request)
      }
  }
}

/** Whether a provider is usable right now, and which models it offers. */
export async function checkProvider(provider: ProviderConfig): Promise<ProviderCheck> {
  const apiKey = getSecret(provider.id)
  try {
    switch (provider.kind) {
      case 'ollama': {
        const status = await ollama.status(trimSlash(provider.baseUrl))
        const models = status.models.map((model) => model.name)
        if (!status.running) {
          return {
            ok: false,
            detail: `Ollama non risponde su ${provider.baseUrl}.`,
            models: [],
            canStart: status.cliFound && isLoopback(hostOf(provider.baseUrl))
          }
        }
        if (models.length === 0) {
          return { ok: false, detail: 'Nessun modello installato in Ollama.', models, canStart: false }
        }
        if (!provider.model) return { ok: false, detail: 'Scegli un modello.', models, canStart: false }
        if (!models.includes(provider.model)) {
          return { ok: false, detail: `Il modello "${provider.model}" non è installato.`, models, canStart: false }
        }
        return { ok: true, detail: 'Pronto.', models, canStart: false }
      }
      case 'openai': {
        if (!provider.baseUrl) return { ok: false, detail: "Manca l'indirizzo del server.", models: [], canStart: false }
        const models = (await openAiModels(provider, apiKey)).map((model) => model.id).sort()
        if (!provider.model) return { ok: false, detail: 'Scegli un modello.', models, canStart: false }
        return { ok: true, detail: 'Pronto.', models, canStart: false }
      }
      case 'anthropic': {
        if (!apiKey) return { ok: false, detail: 'Manca la chiave API.', models: [], canStart: false }
        const models: string[] = []
        for await (const model of anthropicClient(apiKey).models.list()) models.push(model.id)
        return { ok: true, detail: 'Pronto.', models, canStart: false }
      }
      case 'claude-code': {
        const binary = claudeBinary(provider)
        if (!binary) return { ok: false, detail: 'Claude Code non trovato.', models: [], canStart: false }
        return {
          ok: true,
          detail: `Claude Code trovato in ${binary}. Usa il tuo abbonamento Claude.`,
          // Aliases the CLI resolves to the newest model of each family.
          models: ['opus', 'sonnet', 'haiku', 'fable'],
          canStart: false
        }
      }
    }
  } catch (error) {
    const message = provider.kind === 'anthropic' ? describeAnthropicError(error) : (error as Error).message
    logLine('llm', `verifica di "${provider.name}" fallita: ${message}`)
    return { ok: false, detail: message, models: [], canStart: false }
  }
}
