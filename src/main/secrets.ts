import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { logLine } from './log'
import { root } from './paths'

/**
 * API keys, kept apart from settings.json so they never travel to the
 * interface and never end up in a settings backup by accident. Each value is
 * encrypted with the OS keychain (Keychain, DPAPI, libsecret/kwallet) when one
 * is available.
 */
interface StoredSecret {
  /** base64 of the encrypted bytes, or of the plain text when encryption is unavailable. */
  value: string
  encrypted: boolean
}

const file = (): string => join(root(), 'secrets.json')

function load(): Record<string, StoredSecret> {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Record<string, StoredSecret>
  } catch {
    return {}
  }
}

async function save(secrets: Record<string, StoredSecret>): Promise<void> {
  const temp = `${file()}.${process.pid}.tmp`
  // Owner-only: the file may hold keys in plain text where no keychain exists.
  await writeFile(temp, JSON.stringify(secrets, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, file())
}

/**
 * True when keys are protected by the OS. On Linux without a keyring Electron
 * falls back to a fixed password ("basic_text"), which is not real protection.
 */
export function encryptionAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux') {
    return safeStorage.getSelectedStorageBackend() !== 'basic_text'
  }
  return true
}

export function hasSecret(id: string): boolean {
  return Boolean(load()[id]?.value)
}

export function getSecret(id: string): string {
  const entry = load()[id]
  if (!entry?.value) return ''
  try {
    const bytes = Buffer.from(entry.value, 'base64')
    return entry.encrypted ? safeStorage.decryptString(bytes) : bytes.toString('utf8')
  } catch (error) {
    logLine('secrets', `chiave di ${id} illeggibile: ${(error as Error).message}`)
    return ''
  }
}

/** Stores, replaces or (with an empty value) removes a key. */
export async function setSecret(id: string, value: string): Promise<void> {
  const secrets = load()
  const trimmed = value.trim()
  if (!trimmed) {
    delete secrets[id]
  } else if (safeStorage.isEncryptionAvailable()) {
    secrets[id] = { value: safeStorage.encryptString(trimmed).toString('base64'), encrypted: true }
  } else {
    secrets[id] = { value: Buffer.from(trimmed, 'utf8').toString('base64'), encrypted: false }
  }
  await save(secrets)
}
