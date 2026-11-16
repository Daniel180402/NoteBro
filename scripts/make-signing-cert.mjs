#!/usr/bin/env node
/**
 * Creates the local code-signing certificate NoteBro is signed with, if it is
 * not already in the keychain. Idempotent.
 *
 * Why this exists: macOS ties the "Screen & System Audio Recording" permission
 * to the app's designated requirement. An ad-hoc signature pins that
 * requirement to the exact bytes of one build (`cdhash H"…"`), so every rebuild
 * looks like a different app and silently loses the permission the user
 * granted. Signing with a certificate instead produces a requirement anchored
 * to the certificate, which survives rebuilds and app updates.
 *
 * The certificate is self-signed and local: it is not trusted by anyone else,
 * it only makes the app's identity stable on this machine, and it can be
 * deleted from Keychain Access at any time (rebuild afterwards).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const IDENTITY = 'NoteBro Local Signing'

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options })
}

/**
 * SHA-1 of the signing certificate, or null when it is not installed.
 *
 * codesign is given this hash rather than the common name: the name can match
 * more than one certificate in the keychain, and codesign then refuses with
 * "ambiguous" instead of picking one.
 *
 * The listing deliberately omits -v, which would show only identities with a
 * trusted chain — a self-signed certificate never has one, yet signs fine.
 */
export function signingIdentity() {
  try {
    const listing = run('security', ['find-identity', '-p', 'codesigning'])
    for (const line of listing.split('\n')) {
      const match = line.match(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"/)
      if (match && match[2] === IDENTITY) return match[1]
    }
  } catch {
    // security is unavailable or the keychain is locked.
  }
  return null
}

export function certificateExists() {
  return signingIdentity() !== null
}

function create() {
  const dir = mkdtempSync(join(tmpdir(), 'notebro-cert-'))
  const password = randomBytes(18).toString('base64url')
  try {
    const config = join(dir, 'openssl.cnf')
    writeFileSync(
      config,
      [
        '[req]',
        'distinguished_name = dn',
        'x509_extensions = v3',
        'prompt = no',
        '',
        '[dn]',
        `CN = ${IDENTITY}`,
        '',
        '[v3]',
        'basicConstraints = critical,CA:false',
        'keyUsage = critical,digitalSignature',
        'extendedKeyUsage = critical,codeSigning',
        'subjectKeyIdentifier = hash'
      ].join('\n')
    )

    const key = join(dir, 'key.pem')
    const cert = join(dir, 'cert.pem')
    const bundle = join(dir, 'cert.p12')

    run('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
      '-config', config, '-keyout', key, '-out', cert
    ])
    run('openssl', [
      'pkcs12', '-export', '-out', bundle, '-inkey', key, '-in', cert,
      '-name', IDENTITY, '-passout', `pass:${password}`
    ])

    // -A lets codesign use the key without an interactive keychain prompt, which
    // would otherwise stall an automated build.
    run('security', [
      'import', bundle,
      '-k', `${process.env.HOME}/Library/Keychains/login.keychain-db`,
      '-P', password,
      '-T', '/usr/bin/codesign',
      '-A'
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Only act when run directly; after-pack.mjs imports this module for IDENTITY.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.platform !== 'darwin') {
    console.log('Non su macOS: nessun certificato necessario.')
    process.exit(0)
  }

  if (certificateExists()) {
    console.log(`Certificato già presente: "${IDENTITY}"`)
  } else {
    create()
    if (!certificateExists()) {
      console.error(`Creazione del certificato "${IDENTITY}" fallita.`)
      process.exit(1)
    }
    console.log(`Certificato creato nel portachiavi "login": "${IDENTITY}"`)
  }
}
