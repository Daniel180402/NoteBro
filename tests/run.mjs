#!/usr/bin/env node
/**
 * Bundles the dependency-free main-process modules, then runs the test files
 * against the real implementations. `--integration` additionally exercises
 * whisper.cpp and Ollama end to end (macOS, both must be installed).
 */
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '.build')

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await build({
  entryPoints: [join(here, 'modules.entry.ts')],
  outfile: join(outDir, 'modules.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@shared': join(here, '..', 'src', 'shared') },
  // Prebuilt .node binaries cannot be bundled; load them from node_modules.
  external: ['@evan/opus'],
  logLevel: 'warning'
})

const files = ['unit.test.mjs']
if (process.argv.includes('--integration')) files.push('integration.test.mjs')

let failed = 0
for (const file of files) {
  const module = await import(pathToFileURL(join(here, file)).href)
  failed += await module.run()
}

await rm(outDir, { recursive: true, force: true })

if (failed === 0) {
  console.log('\n✓ Tutti i test sono passati.')
  process.exit(0)
}
console.log(`\n✗ ${failed} test falliti.`)
process.exit(1)
