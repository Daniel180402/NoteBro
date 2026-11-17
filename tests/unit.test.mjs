import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, section, takeFailures } from './harness.mjs'
import {
  WavWriter,
  assignVoices,
  buildDialogue,
  mixToMono,
  parseRange,
  parseWhisperSegments,
  wavToWebm,
  speakerName,
  voicedWindow,
  voicesIn,
  pulse,
  chunker,
  naming
} from './.build/modules.mjs'

export async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'notebro-test-'))

  // A 400 Hz tone at 16 kHz, as the raw bytes the recorder would receive.
  const SAMPLES = 16000 * 3
  const source = Buffer.alloc(SAMPLES * 2)
  for (let i = 0; i < SAMPLES; i += 1) {
    source.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 400 * i) / 16000) * 20000), i * 2)
  }

  section('WavWriter: odd-length chunks written concurrently')
  {
    const path = join(dir, 'odd.wav')
    const writer = new WavWriter(path)
    await writer.open()
    // 999 bytes is odd on purpose: every chunk ends mid-sample.
    const pending = []
    for (let offset = 0; offset < source.length; offset += 999) {
      pending.push(writer.write(source.subarray(offset, Math.min(offset + 999, source.length))))
    }
    await Promise.all(pending)
    await writer.close()

    const file = await readFile(path)
    check('RIFF/WAVE header', file.toString('ascii', 0, 4) === 'RIFF' && file.toString('ascii', 8, 12) === 'WAVE')
    check('16 kHz mono 16-bit', file.readUInt32LE(24) === 16000 && file.readUInt16LE(22) === 1 && file.readUInt16LE(34) === 16)
    const dataBytes = file.readUInt32LE(40)
    check('data size matches the payload', dataBytes === source.length, `${dataBytes} vs ${source.length}`)
    check('RIFF size is 36 + data', file.readUInt32LE(4) === 36 + dataBytes)
    check('payload is byte-identical, no sample shift', file.subarray(44).equals(source))
    check('duration is 3000 ms', Math.round(writer.durationMs) === 3000, `${writer.durationMs}`)
    check('peak tracks the signal', Math.abs(writer.peak - 20000 / 32768) < 0.01, `${writer.peak}`)
  }

  section('WavWriter: leading silence for channel alignment')
  {
    const path = join(dir, 'silence.wav')
    const writer = new WavWriter(path)
    await writer.open()
    await writer.writeSilence(500)
    await writer.write(source.subarray(0, 3200))
    await writer.close()
    const file = await readFile(path)
    const silentSamples = 0.5 * 16000
    check('data size is silence + payload', file.readUInt32LE(40) === silentSamples * 2 + 3200)
    check(
      'the padding really is silent',
      file.subarray(44, 44 + silentSamples * 2).every((byte) => byte === 0)
    )
  }

  section('WavWriter: energy profile')
  {
    const path = join(dir, 'energy.wav')
    const writer = new WavWriter(path)
    await writer.open()
    await writer.write(Buffer.alloc(16000 * 2)) // 1 s silence
    await writer.write(source.subarray(0, 16000 * 2)) // 1 s tone
    await writer.close()
    const profile = writer.energyProfile
    check('one RMS bucket per 100 ms', profile.length === 20, `${profile.length}`)
    check('the silent second reads zero', profile.slice(0, 10).every((value) => value === 0))
    check('the loud second carries energy', profile.slice(10).every((value) => value > 0.1))
  }

  section('voicedWindow: locating the real utterance')
  {
    // One character = one 100 ms bucket. 1 = speech, 0 = silence.
    const build = (pattern) => pattern.split('').map((c) => (c === '1' ? 0.5 : 0))

    check(
      'snaps onto the speech, ignoring surrounding silence',
      JSON.stringify(voicedWindow(build('0000111111110000'), 0, 1600, 0.006)) ===
        JSON.stringify({ from: 400, to: 1200, buckets: 8 })
    )
    check('returns null for a silent range', voicedWindow(build('00000000'), 0, 800, 0.006) === null)

    // Regression: whisper segments often trail the tail of the speaker's own
    // previous utterance. Anchoring there merged two turns into one and lost a
    // turn entirely, so the longest run must win.
    const leaked = voicedWindow(build(`11${'0'.repeat(40)}${'1'.repeat(30)}`), 0, 7200, 0.006)
    check(
      'ignores a short leading tail behind a long silence',
      leaked.from === 4200 && leaked.buckets === 30,
      JSON.stringify(leaked)
    )

    // Regression: a 400 ms pause between sentences is not a turn boundary.
    const bridged = voicedWindow(build(`${'1'.repeat(10)}0000${'1'.repeat(10)}`), 0, 2400, 0.006)
    check(
      'bridges a 400 ms pause inside one utterance',
      bridged.from === 0 && bridged.to === 2400,
      JSON.stringify(bridged)
    )

    const later = voicedWindow(build(`11111${'0'.repeat(30)}${'1'.repeat(20)}`), 0, 5500, 0.006)
    check('a 3 s gap still separates two utterances', later.from === 3500, JSON.stringify(later))
  }

  section('parseWhisperSegments: discarding invented speech')
  {
    const silent = new Array(60).fill(0)
    const dropped = parseWhisperSegments(
      { transcription: [{ offsets: { from: 0, to: 6000 }, text: ' Grazie per aver guardato il video.' }] },
      'them',
      silent,
      0.4
    )
    check('a segment over pure silence is discarded', dropped.length === 0, `${dropped.length}`)

    const voiced = new Array(60).fill(0)
    for (let i = 10; i < 40; i += 1) voiced[i] = 0.4
    const kept = parseWhisperSegments(
      {
        transcription: [
          { offsets: { from: 0, to: 6000 }, text: ' Contenuto reale.' },
          { offsets: { from: 0, to: 6000 }, text: '  [Musica]  ' }
        ]
      },
      'them',
      voiced,
      0.5
    )
    check('real speech survives and is re-timed', kept.length === 1 && kept[0].from === 1000, JSON.stringify(kept))
    check('bracketed non-speech markers are dropped', !kept.some((segment) => segment.text.includes('Musica')))
  }

  section('buildDialogue: interleaving and joining turns')
  {
    const dialogue = buildDialogue([
      { from: 5000, to: 6000, speaker: 'me', text: 'Secondo pezzo.' },
      { from: 0, to: 2000, speaker: 'them', text: 'Domanda?' },
      { from: 3000, to: 4500, speaker: 'me', text: 'Primo pezzo.' },
      { from: 9000, to: 10000, speaker: 'them', text: 'Chiusura.' }
    ])
    check('sorted by time', dialogue.map((turn) => turn.from).join(',') === '0,3000,9000')
    check('same speaker within 1.2 s becomes one turn', dialogue.length === 3, `${dialogue.length}`)
    check('joined text keeps its order', dialogue[1].text === 'Primo pezzo. Secondo pezzo.', dialogue[1].text)
    check('the joined turn ends at the later bound', dialogue[1].to === 6000, `${dialogue[1].to}`)
    check('different speakers are never joined', dialogue[0].speaker === 'them' && dialogue[2].speaker === 'them')

    // Same channel, different people: joining them would put one person's words
    // in another's mouth.
    const twoVoices = buildDialogue([
      { from: 0, to: 2000, speaker: 'them', voice: 0, text: 'Parla Laura.' },
      { from: 2500, to: 4000, speaker: 'them', voice: 1, text: 'Parla Marco.' }
    ])
    check('two remote voices stay separate turns', twoVoices.length === 2, `${twoVoices.length}`)
    const sameVoice = buildDialogue([
      { from: 0, to: 2000, speaker: 'them', voice: 0, text: 'Prima parte.' },
      { from: 2500, to: 4000, speaker: 'them', voice: 0, text: 'Seconda parte.' }
    ])
    check('the same voice still joins', sameVoice.length === 1, `${sameVoice.length}`)
  }

  section('mixToMono: one playable file from the two speakers')
  {
    // Each speaker talks for one second while the other is silent, which is
    // how the recorder lays the channels out.
    const second = 16000 * 2
    const tone = source.subarray(0, second)
    const quiet = Buffer.alloc(second)

    const write = async (name, blocks) => {
      const writer = new WavWriter(join(dir, name))
      await writer.open()
      for (const block of blocks) await writer.write(block)
      await writer.close()
      return writer.path
    }

    const me = await write('mix-me.wav', [tone, quiet])
    const them = await write('mix-them.wav', [quiet, tone])
    const out = join(dir, 'mix.wav')
    const ok = await mixToMono([me, them], out)
    check('reports success', ok === true)

    const file = await readFile(out)
    check('keeps the full duration', file.readUInt32LE(40) === second * 2, `${file.readUInt32LE(40)}`)

    const energyOf = (fromSample, toSample) => {
      let peak = 0
      for (let i = fromSample; i < toSample; i += 1) {
        const value = Math.abs(file.readInt16LE(44 + i * 2))
        if (value > peak) peak = value
      }
      return peak
    }
    check('the first speaker survives the mix', energyOf(0, 16000) > 15000, `${energyOf(0, 16000)}`)
    check('the second speaker survives the mix', energyOf(16000, 32000) > 15000, `${energyOf(16000, 32000)}`)

    // Both talking at once must clamp, never wrap around to the opposite sign.
    const loudA = await write('loud-a.wav', [tone])
    const loudB = await write('loud-b.wav', [tone])
    const overlap = join(dir, 'overlap.wav')
    await mixToMono([loudA, loudB], overlap)
    const clamped = await readFile(overlap)
    let wrapped = false
    for (let i = 0; i < 16000; i += 1) {
      const mixedSample = clamped.readInt16LE(44 + i * 2)
      const original = source.readInt16LE(i * 2)
      // Same sign as the input, or clamped to the rail — never inverted.
      if (original > 1000 && mixedSample < 0) wrapped = true
      if (original < -1000 && mixedSample > 0) wrapped = true
    }
    check('simultaneous speech clamps instead of wrapping', !wrapped)

    check('an empty input list is reported, not crashed', (await mixToMono([], join(dir, 'none.wav'))) === false)
  }

  section('assignVoices: matching turns to the voice that spoke them')
  {
    const turns = [
      { from: 0, to: 4000, speaker: 'them', text: 'A parla' },
      { from: 4500, to: 9000, speaker: 'me', text: 'Rispondo io' },
      { from: 9500, to: 14000, speaker: 'them', text: 'B parla' },
      { from: 15000, to: 19000, speaker: 'them', text: 'A di nuovo' }
    ]
    // Clustering hands back arbitrary ids; 3 and 7 here.
    const spans = [
      { start: 0, end: 4, voice: 3 },
      { start: 9.5, end: 14, voice: 7 },
      { start: 15, end: 19, voice: 3 }
    ]
    const voiced = assignVoices(turns, spans)
    check('your own channel is never given a voice', voiced[1].voice === undefined)
    check('voices are renumbered from zero in order of appearance', voiced[0].voice === 0 && voiced[2].voice === 1, JSON.stringify(voiced.map((t) => t.voice)))
    check('the same voice recurs with the same number', voiced[3].voice === 0, `${voiced[3].voice}`)
    check('voicesIn lists them in order', voicesIn(voiced).join(',') === '0,1', voicesIn(voiced).join(','))

    // The first turn straddles two voices: 3 s of voice 0 and 7 s of voice 1.
    // Taking the larger share means it must NOT share a number with the second
    // turn, which is voice 0 outright.
    const overlapping = assignVoices(
      [
        { from: 0, to: 10000, speaker: 'them', text: 'a cavallo di due voci' },
        { from: 12000, to: 16000, speaker: 'them', text: 'solo la prima voce' }
      ],
      [
        { start: 0, end: 3, voice: 0 },
        { start: 3, end: 10, voice: 1 },
        { start: 12, end: 16, voice: 0 }
      ]
    )
    check(
      'a turn takes the voice it overlaps most, not the one it starts in',
      overlapping[0].voice !== overlapping[1].voice,
      JSON.stringify(overlapping.map((t) => t.voice))
    )
    check('both voices are labelled', overlapping.every((t) => t.voice !== undefined))

    const unmatched = assignVoices(
      [{ from: 50000, to: 52000, speaker: 'them', text: 'fuori da ogni intervallo' }],
      [{ start: 0, end: 3, voice: 0 }, { start: 5, end: 9, voice: 1 }]
    )
    check('a turn matching nothing stays unlabelled', unmatched[0].voice === undefined)

    const single = assignVoices(
      [{ from: 0, to: 4000, speaker: 'them', text: 'solo uno' }],
      [{ start: 0, end: 4, voice: 2 }]
    )
    check('one voice alone is not numbered', single[0].voice === undefined)
    check('no diarization leaves turns untouched', assignVoices(turns, [])[0].voice === undefined)

    // Real clustering throws off splinters: on an actual meeting four voices
    // held 96% of the talking and eight fragments shared the rest.
    const noisy = assignVoices(
      [
        { from: 0, to: 60000, speaker: 'them', text: 'voce principale' },
        { from: 60000, to: 110000, speaker: 'them', text: 'seconda voce' },
        { from: 110000, to: 111000, speaker: 'them', text: 'frammento spurio' }
      ],
      [
        { start: 0, end: 60, voice: 0 },
        { start: 60, end: 110, voice: 1 },
        { start: 110, end: 111, voice: 9 }
      ]
    )
    check('negligible clusters are dropped', new Set(noisy.map((t) => t.voice).filter((v) => v !== undefined)).size === 2, JSON.stringify(noisy.map((t) => t.voice)))
    check('the turn they covered stays unlabelled', noisy[2].voice === undefined)
    check('the real voices survive', noisy[0].voice === 0 && noisy[1].voice === 1)

    // Many equally short clusters are all legitimate: nothing should vanish.
    const even = assignVoices(
      [
        { from: 0, to: 10000, speaker: 'them', text: 'a' },
        { from: 10000, to: 20000, speaker: 'them', text: 'b' }
      ],
      [{ start: 0, end: 10, voice: 0 }, { start: 10, end: 20, voice: 1 }]
    )
    check('evenly shared voices are all kept', even[0].voice === 0 && even[1].voice === 1)
  }

  section('speakerName: how each turn is labelled')
  {
    const labels = { me: 'Io', them: 'Interlocutore' }
    check('your own turns', speakerName({ speaker: 'me' }, labels) === 'Io')
    check('a single unknown speaker', speakerName({ speaker: 'them' }, labels) === 'Interlocutore')
    check('a numbered voice counts from one', speakerName({ speaker: 'them', voice: 1 }, labels) === 'Interlocutore 2')
    check('a named voice wins', speakerName({ speaker: 'them', voice: 1 }, labels, { 1: 'Laura' }) === 'Laura')
    check('a blank name falls back to the number', speakerName({ speaker: 'them', voice: 0 }, labels, { 0: '  ' }) === 'Interlocutore 1')
  }

  section('parseRange: byte ranges for seeking in the recording')
  {
    const size = 1000
    const eq = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

    check('a plain range', eq(parseRange('bytes=0-499', size), { start: 0, end: 499 }))
    check('an open-ended range runs to the last byte', eq(parseRange('bytes=500-', size), { start: 500, end: 999 }))
    check('a suffix range takes the tail', eq(parseRange('bytes=-100', size), { start: 900, end: 999 }))
    check('an end past the file is clamped', eq(parseRange('bytes=900-5000', size), { start: 900, end: 999 }))
    check('a suffix longer than the file starts at zero', eq(parseRange('bytes=-5000', size), { start: 0, end: 999 }))
    check('the whole file', eq(parseRange('bytes=0-', size), { start: 0, end: 999 }))
    check('a single byte', eq(parseRange('bytes=10-10', size), { start: 10, end: 10 }))

    check('no header means no range', parseRange(null, size) === null)
    check('a start past the end is refused', parseRange('bytes=1000-1100', size) === null)
    check('a reversed range is refused', parseRange('bytes=500-100', size) === null)
    check('multi-range is refused', parseRange('bytes=0-10,20-30', size) === null)
    check('a non-byte unit is refused', parseRange('items=0-10', size) === null)
    check('an empty file has no ranges', parseRange('bytes=0-10', 0) === null)
  }

  section('wavToWebm: shrinking a saved recording')
  {
    const wav = join(dir, 'tocompress.wav')
    const webm = join(dir, 'tocompress.webm')
    const writer = new WavWriter(wav)
    await writer.open()
    for (let i = 0; i < 5; i += 1) await writer.write(source) // 15 s di tono
    await writer.close()

    const before = (await readFile(wav)).length
    const result = await wavToWebm(wav, webm)
    const encoded = await readFile(webm)

    check('reports the sizes it moved', result.beforeBytes === before && result.afterBytes === encoded.length)
    check('at least five times smaller', before / encoded.length > 5, `${(before / encoded.length).toFixed(1)}x`)
    check(
      'writes a real WebM container',
      encoded[0] === 0x1a && encoded[1] === 0x45 && encoded[2] === 0xdf && encoded[3] === 0xa3
    )
    check('removes the uncompressed original', !existsSync(wav))
    check('leaves no partial file behind', !existsSync(`${webm}.part`))

    const tooShort = join(dir, 'tiny.wav')
    const tiny = new WavWriter(tooShort)
    await tiny.open()
    await tiny.write(Buffer.alloc(100))
    await tiny.close()
    let refused = false
    await wavToWebm(tooShort, join(dir, 'tiny.webm')).catch(() => { refused = true })
    check('refuses a recording too short to encode', refused)
    check('and leaves that original untouched', existsSync(tooShort))
  }

  section('pulse: Linux system audio through parec')
  {
    const args = pulse.parecArgs('')
    check('defaults to the monitor of the default output', args.includes('--device=@DEFAULT_MONITOR@'))
    check(
      'asks for the PCM the recorder writes',
      ['--format=s16le', '--rate=16000', '--channels=1', '--raw'].every((arg) => args.includes(arg))
    )
    check(
      'records the chosen output when one is set',
      pulse.parecArgs('alsa_output.usb.monitor').includes('--device=alsa_output.usb.monitor')
    )

    // Shape of `pactl --format=json list sources` on PipeWire 1.x.
    const json = JSON.stringify([
      { name: 'alsa_output.hdmi.monitor', description: 'Monitor of HDMI', monitor_source: 'alsa_output.hdmi' },
      { name: 'alsa_input.usb-mic.mono-fallback', description: 'USB Mic', monitor_source: '' },
      { name: 'alsa_output.analog.monitor', description: '' }
    ])
    const monitors = pulse.parseMonitorsJson(json)
    check('keeps only monitor sources', monitors.length === 2, JSON.stringify(monitors))
    check('uses the description as label', monitors[0]?.description === 'Monitor of HDMI')
    check('falls back to the name without one', monitors[1]?.description === 'alsa_output.analog.monitor')
    check('survives output that is not JSON', pulse.parseMonitorsJson('Failure: no JSON').length === 0)

    const short = [
      '62\talsa_output.hdmi.monitor\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED',
      '63\talsa_input.usb-mic.mono-fallback\tPipeWire\ts16le 1ch 48000Hz\tSUSPENDED',
      ''
    ].join('\n')
    const fromShort = pulse.parseMonitorsShort(short)
    check(
      'reads the short listing of older pactl',
      fromShort.length === 1 && fromShort[0].name === 'alsa_output.hdmi.monitor'
    )
  }

  section('chunker: cutting a live channel on pauses')
  {
    // ms of tone or silence, as the PCM the recorder receives.
    const pcm = (ms, loud) => {
      const samples = (ms * 16000) / 1000
      const out = Buffer.alloc(samples * 2)
      if (loud) for (let i = 0; i < samples; i += 1) out.writeInt16LE(Math.round(Math.sin(i / 3) * 12000), i * 2)
      return out
    }

    const waiting = new chunker.ChannelChunker(0)
    waiting.push(pcm(3000, true))
    check('waits while there is too little audio', waiting.take() === null)

    const paused = new chunker.ChannelChunker(1000)
    paused.push(pcm(5000, true))
    paused.push(pcm(600, false))
    paused.push(pcm(2000, true))
    const first = paused.take()
    check('cuts inside the pause', first !== null && first.pcm.length / 32 >= 5000 && first.pcm.length / 32 <= 5600, String(first && first.pcm.length / 32))
    check('places the piece on the channel timeline', first?.startMs === 1000)
    check('keeps the rest for later', paused.take() === null && paused.bufferedMs > 2000)
    const rest = paused.take(true)
    check('flush hands over the remainder', rest !== null && rest.startMs === 1000 + first.pcm.length / 32)
    check('and leaves nothing behind', paused.bufferedMs === 0)

    const monologue = new chunker.ChannelChunker(0)
    monologue.push(pcm(11000, true))
    const forced = monologue.take()
    check('cuts a monologue at the hard limit', forced !== null && forced.pcm.length / 32 === 10000)

    const silent = new chunker.ChannelChunker(0)
    silent.push(pcm(5000, false))
    const quiet = silent.take(true)
    check('reports the peak so silence can be skipped', quiet !== null && quiet.peak === 0)
    check('computes the 100 ms energy profile', quiet?.energyProfile.length === 50)

    const odd = new chunker.ChannelChunker(0)
    odd.push(Buffer.alloc(16001))
    const even = odd.take(true)
    check('never splits a sample in two', even !== null && even.pcm.length % 2 === 0)

    const wav = chunker.wavFile(pcm(1000, true))
    check('wraps pieces in a 16 kHz mono WAV', wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt32LE(24) === 16000 && wav.readUInt16LE(22) === 1)

    const json = chunker.serverToWhisperJson(
      {
        segments: [
          { start: 0.5, end: 2.25, text: ' Ciao a tutti', no_speech_prob: 0.02 },
          { start: 2.5, end: 4, text: ' Grazie per la visione.', no_speech_prob: 0.9 }
        ]
      },
      4000
    )
    check('converts seconds to milliseconds', json.transcription[0]?.offsets.from === 500 && json.transcription[0]?.offsets.to === 2250)
    check('drops what whisper itself calls non-speech', json.transcription.length === 1)
    const plain = chunker.serverToWhisperJson({ text: 'solo testo' }, 3000)
    check('accepts the plain json format too', plain.transcription[0]?.offsets.to === 3000)
  }

  section('naming: folder names for saved notes')
  {
    const title = 'Riunione con Marco: budget 2027'
    check('keeps a readable title', naming.noteFolderName(title, 'title') === 'Riunione con Marco budget 2027')
    check('turns it into snake_case', naming.noteFolderName(title, 'snake') === 'riunione_con_marco_budget_2027')
    check('drops accents in snake_case', naming.noteFolderName('Perché è così?', 'snake') === 'perche_e_cosi')
    check('keeps accents in a normal title', naming.noteFolderName('Perché è così?', 'title') === 'Perché è così')
    check('removes path separators', !naming.noteFolderName('a/b\\c', 'title').match(/[\/\\]/))
    check('never yields an empty name', naming.noteFolderName('???', 'title') === 'Senza titolo' && naming.noteFolderName('***', 'snake') === 'senza_titolo')
    check('avoids names Windows reserves', naming.noteFolderName('CON', 'title') === 'Senza titolo')
    const long = naming.noteFolderName('parola '.repeat(30), 'title')
    check('clips long titles on a word', long.length <= 80 && !long.endsWith(' ') && long.endsWith('parola'))
    const taken = new Set(['Riunione', 'Riunione (2)', 'riunione'])
    check('numbers duplicates', naming.uniqueName('Riunione', 'title', (name) => taken.has(name)) === 'Riunione (3)')
    check('numbers duplicates in snake_case', naming.uniqueName('riunione', 'snake', (name) => taken.has(name)) === 'riunione_2')
  }

  await rm(dir, { recursive: true, force: true })
  return takeFailures()
}
