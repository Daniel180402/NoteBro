/**
 * End-to-end check of the local pipeline: synthesised Italian speech on two
 * aligned channels -> whisper.cpp -> dialogue reconstruction -> Ollama summary.
 *
 * Skips itself when a prerequisite is missing, so it never fails a machine that
 * simply has not installed the engines yet.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { check, section, skip, takeFailures } from './harness.mjs'
import { WavWriter, buildDialogue, ollama, parseWhisperSegments } from './.build/modules.mjs'

const RATE = 16000
const VOICES = { me: 'Alice', them: 'Shelley' }

const TURNS = [
  ['them', 'Buongiorno Daniel, grazie per essere qui. Le va di raccontarmi brevemente il suo percorso?'],
  ['me', 'Buongiorno. Ho lavorato cinque anni come sviluppatore backend, principalmente su Node e Postgres.'],
  ['them', 'Perfetto. Il ruolo prevede anche la gestione di un piccolo team. Ha esperienza di coordinamento?'],
  ['me', "Si, nell'ultimo anno ho guidato tre persone, con stand-up giornalieri e revisioni del codice."],
  ['them', 'Bene. Come inquadramento pensavamo a quarantacinquemila euro lordi, con inizio a novembre.'],
  ['me', "L'inquadramento mi sembra ragionevole. Posso confermare la mia disponibilita entro venerdi."],
  ['them', 'Ottimo. Le mando il riepilogo per email e attendiamo la sua conferma entro venerdi.']
]

function onPath(name) {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of dirs) if (dir && existsSync(join(dir, name))) return join(dir, name)
  return null
}

function findModel() {
  const dir = join(homedir(), 'Library', 'Application Support', 'NoteBro', 'models')
  if (!existsSync(dir)) return null
  const preferred = join(dir, 'ggml-small.bin')
  if (existsSync(preferred)) return preferred
  const any = readdirSync(dir).find((file) => file.startsWith('ggml-') && file.endsWith('.bin'))
  return any ? join(dir, any) : null
}

export async function run() {
  section('Integrazione: parlato sintetico -> whisper.cpp -> Ollama')

  if (process.platform !== 'darwin') {
    skip('pipeline completa', 'il generatore di voce "say" esiste solo su macOS')
    return takeFailures()
  }
  const whisperBin = onPath('whisper-cli') ?? onPath('whisper-cpp')
  const ffmpeg = onPath('ffmpeg')
  const model = findModel()
  if (!whisperBin) return skip('pipeline completa', 'whisper-cli non installato'), takeFailures()
  if (!ffmpeg) return skip('pipeline completa', 'ffmpeg non installato'), takeFailures()
  if (!model) return skip('pipeline completa', 'nessun modello whisper scaricato'), takeFailures()

  const dir = await mkdtemp(join(tmpdir(), 'notebro-e2e-'))
  try {
    // Synthesise each turn, then lay the turns onto two channels so that each
    // channel is silent while the other person speaks — exactly the shape the
    // recorder produces from a microphone plus system audio.
    const parts = []
    for (const [index, [speaker, text]] of TURNS.entries()) {
      const aiff = join(dir, `t${index}.aiff`)
      const wav = join(dir, `t${index}.wav`)
      execFileSync('say', ['-v', VOICES[speaker], '-o', aiff, text])
      execFileSync(ffmpeg, ['-y', '-i', aiff, '-ar', String(RATE), '-ac', '1', '-c:a', 'pcm_s16le', wav, '-loglevel', 'error'])
      const payload = (await readFile(wav)).subarray(44)
      parts.push({ speaker, payload })
    }

    const expectedOnsets = []
    let cursorBytes = 0
    for (const part of parts) {
      expectedOnsets.push({ speaker: part.speaker, fromMs: (cursorBytes / 2 / RATE) * 1000 })
      cursorBytes += part.payload.length
    }

    const channels = {}
    for (const channel of ['me', 'them']) {
      const writer = new WavWriter(join(dir, `${channel}.wav`))
      await writer.open()
      for (const part of parts) {
        await writer.write(part.speaker === channel ? part.payload : Buffer.alloc(part.payload.length))
      }
      await writer.close()
      channels[channel] = writer
    }
    check('both channels have the same length', channels.me.bytes === channels.them.bytes)

    const segments = []
    for (const channel of ['me', 'them']) {
      const base = join(dir, `${channel}-transcript`)
      execFileSync(whisperBin, [
        '-m', model, '-f', channels[channel].path, '-l', 'it',
        '-t', '8', '-oj', '-of', base, '-np', '-sns'
      ], { stdio: 'ignore' })
      const parsed = JSON.parse(await readFile(`${base}.json`, 'utf8'))
      segments.push(
        ...parseWhisperSegments(parsed, channel, channels[channel].energyProfile, channels[channel].peak)
      )
    }

    const dialogue = buildDialogue(segments)
    for (const turn of dialogue) {
      console.log(`     ${(turn.from / 1000).toFixed(1).padStart(5)}s ${turn.speaker.padEnd(5)} ${turn.text.slice(0, 56)}`)
    }

    const trueOrder = TURNS.map(([speaker]) => speaker).join(',')
    check('one turn per utterance', dialogue.length === TURNS.length, `${dialogue.length} vs ${TURNS.length}`)
    check('the speakers alternate in the real order', dialogue.map((t) => t.speaker).join(',') === trueOrder, dialogue.map((t) => t.speaker).join(','))
    check(
      'every onset lands within 1 s of the truth',
      dialogue.length === expectedOnsets.length &&
        dialogue.every((turn, index) => Math.abs(turn.from - expectedOnsets[index].fromMs) < 1000),
      dialogue.map((t, i) => `${(t.from / 1000).toFixed(1)}/${(expectedOnsets[i]?.fromMs / 1000).toFixed(1)}`).join(' ')
    )

    const baseUrl = 'http://127.0.0.1:11434'
    const status = await ollama.status(baseUrl)
    if (!status.running || status.models.length === 0) {
      skip('riassunto Ollama', 'server non raggiungibile o senza modelli')
      return takeFailures()
    }

    const model_ = status.models.find((m) => m.name.startsWith('qwen2.5'))?.name ?? status.models[0].name
    let tokens = 0
    const summary = await ollama.summarize({
      baseUrl,
      model: model_,
      language: 'it',
      segments: dialogue,
      labels: { me: 'Io', them: 'Interlocutore' },
      contextLength: await ollama.contextLengthOf(baseUrl, model_),
      onToken: () => { tokens += 1 },
      onStage: () => undefined
    })

    check('the summary streamed tokens', tokens > 50, `${tokens}`)
    check('it follows the requested outline', /##\s*Sintesi/i.test(summary) && /##\s*Azioni/i.test(summary))
    check('it is written in Italian', /\b(della|con|per|il|la|che)\b/i.test(summary))
    check('it picks up the Friday deadline', /venerd/i.test(summary), summary.slice(0, 0))

    const title = await ollama.suggestTitle({ baseUrl, model: model_, language: 'it', summary })
    check('the title is a single short line', title.length > 3 && title.length < 90 && !title.includes('\n'), title)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  return takeFailures()
}
