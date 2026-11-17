/**
 * Whether a summary provider sends the transcript off this computer, and where.
 * Dependency-free so the test runner can bundle it.
 */
import type { ProviderConfig } from '@shared/types'

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return baseUrl
  }
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host)
}

/** True when using this provider sends the transcript off this computer. */
export function isRemote(provider: Pick<ProviderConfig, 'kind' | 'baseUrl' | 'model'>): boolean {
  if (provider.kind === 'anthropic' || provider.kind === 'claude-code') return true
  // Ollama's ":cloud" models run on ollama.com even through a local server.
  if (provider.kind === 'ollama' && /:cloud$|-cloud$/.test(provider.model)) return true
  return !isLoopback(hostOf(provider.baseUrl))
}

export function destinationOf(provider: Pick<ProviderConfig, 'kind' | 'baseUrl' | 'model'>): string {
  if (provider.kind === 'anthropic') return 'api.anthropic.com'
  if (provider.kind === 'claude-code') return 'Anthropic, tramite Claude Code'
  if (provider.kind === 'ollama' && /:cloud$|-cloud$/.test(provider.model)) return 'ollama.com'
  return hostOf(provider.baseUrl)
}

