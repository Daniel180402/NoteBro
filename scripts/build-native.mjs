#!/usr/bin/env node
/**
 * Compiles the macOS system-audio helper into resources/bin.
 *
 * Builds a universal binary when both slices are available, so the same app
 * runs on Apple Silicon and Intel. On other platforms it is a no-op: Windows
 * gets system audio from Chromium's loopback capture instead.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'native', 'macos', 'SystemAudioCapture.swift')
const outDir = join(root, 'resources', 'bin')
const output = join(outDir, 'notebro-sysaudio')

if (process.platform !== 'darwin') {
  console.log('Non su macOS: helper audio di sistema non necessario, salto la compilazione.')
  process.exit(0)
}

if (!existsSync(source)) {
  console.error(`Sorgente mancante: ${source}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

const frameworks = [
  '-framework', 'ScreenCaptureKit',
  '-framework', 'AVFoundation',
  '-framework', 'CoreMedia'
]

function compile(target, destination) {
  execFileSync(
    'swiftc',
    ['-O', '-parse-as-library', '-target', target, ...frameworks, '-o', destination, source],
    { stdio: 'inherit' }
  )
}

const slices = [
  { target: 'arm64-apple-macos13.0', path: `${output}.arm64` },
  { target: 'x86_64-apple-macos13.0', path: `${output}.x86_64` }
]

const built = []
for (const slice of slices) {
  try {
    compile(slice.target, slice.path)
    built.push(slice.path)
  } catch {
    console.warn(`Slice ${slice.target} non disponibile, la salto.`)
  }
}

if (built.length === 0) {
  console.error('Compilazione fallita per tutte le architetture.')
  process.exit(1)
}

if (built.length === 1) {
  execFileSync('lipo', ['-create', built[0], '-output', output], { stdio: 'inherit' })
} else {
  execFileSync('lipo', ['-create', ...built, '-output', output], { stdio: 'inherit' })
}
for (const path of built) rmSync(path, { force: true })

execFileSync('chmod', ['+x', output])
console.log(`Helper compilato: ${output}`)
console.log(execFileSync('lipo', ['-archs', output]).toString().trim())
