/**
 * Signs the packaged macOS app with the local certificate.
 *
 * macOS ties the Privacy permissions (microphone, screen & system audio
 * recording) to the app's designated requirement. An ad-hoc signature pins that
 * requirement to one build's exact bytes (`cdhash H"…"`), so every rebuild looks
 * like a different app and silently loses the permission the user granted.
 * Signing with the certificate from scripts/make-signing-cert.mjs produces
 * `certificate leaf = H"…"` instead, which survives rebuilds and updates.
 *
 * Without that certificate it falls back to an ad-hoc signature, which still
 * produces a working app — the permission just has to be granted again after
 * each build.
 *
 * Signing must go inside-out: each nested binary and bundle first, the outer
 * .app last. A single `codesign --deep` pass leaves the Electron Framework
 * carrying a different signature from the main executable, and dyld then
 * refuses to load it ("mapping process and mapped file have different Team
 * IDs"), which makes the app fail to start at all.
 */
import { execFileSync } from 'node:child_process'
import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { IDENTITY, signingIdentity } from './make-signing-cert.mjs'

const MACH_O_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xbebafeca, 0xcffaedfe, 0xcefaedfe])
const NESTED_BUNDLE = /\.(app|framework)$/

function isMachO(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const header = Buffer.alloc(4)
    if (readSync(fd, header, 0, 4, 0) < 4) return false
    return MACH_O_MAGIC.has(header.readUInt32BE(0)) || MACH_O_MAGIC.has(header.readUInt32LE(0))
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Every nested bundle and loose Mach-O file that needs its own signature. */
function collect(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (NESTED_BUNDLE.test(entry.name)) found.push(path)
      collect(path, found)
    } else if (entry.isFile() && statSync(path).size > 4 && isMachO(path)) {
      found.push(path)
    }
  }
  return found
}

function sign(path, identity) {
  execFileSync('codesign', ['--force', '--sign', identity, '--timestamp=none', path], {
    stdio: ['ignore', 'ignore', 'pipe']
  })
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  const certificate = signingIdentity()
  const identity = certificate ?? '-'

  try {
    // Deepest paths first, so a bundle is only sealed once its contents are signed.
    const targets = collect(join(appPath, 'Contents')).sort(
      (a, b) => b.split('/').length - a.split('/').length
    )
    for (const target of targets) sign(target, identity)
    sign(appPath, identity)
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
    console.log(
      certificate
        ? `Firmata con "${IDENTITY}" (${certificate}): ${targets.length} elementi annidati. I permessi macOS sopravvivono alle ricompilazioni.`
        : `Firma ad-hoc applicata: ${appPath}. Senza certificato i permessi macOS vanno riconcessi a ogni build — esegui "npm run cert:mac".`
    )
  } catch (error) {
    console.warn(`Firma non applicata: ${error.message}`)
  }
}
