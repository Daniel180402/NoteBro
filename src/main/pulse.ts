/**
 * Linux system audio through PulseAudio — or PipeWire's pulse server, which is
 * what nearly every current desktop runs. Every sink has a "monitor" source
 * that carries whatever the sink is playing, so recording it is recording the
 * far side of the call. Dependency-free so the test runner can bundle it.
 */
import { SAMPLE_RATE, type MonitorSource } from '@shared/types'

/** Resolved by the server to the monitor of whatever the default output is. */
export const DEFAULT_MONITOR = '@DEFAULT_MONITOR@'

/** Raw 16-bit mono PCM at the recorder's rate: the same stream the macOS helper emits. */
export function parecArgs(device: string): string[] {
  return [
    `--device=${device || DEFAULT_MONITOR}`,
    '--format=s16le',
    `--rate=${SAMPLE_RATE}`,
    '--channels=1',
    '--raw',
    // Without it the server may buffer seconds of audio before the first chunk.
    '--latency-msec=100',
    '--client-name=NoteBro',
    '--stream-name=Audio di sistema'
  ]
}

interface PactlSource {
  name?: unknown
  description?: unknown
  monitor_source?: unknown
  monitor_of_sink?: unknown
}

function isMonitor(source: PactlSource): boolean {
  if (typeof source.name !== 'string') return false
  if (source.name.endsWith('.monitor')) return true
  // pactl's JSON names the monitored sink in a field whose name varies by version.
  for (const field of [source.monitor_source, source.monitor_of_sink]) {
    if (typeof field === 'string' && field.length > 0) return true
  }
  return false
}

/** Parses `pactl --format=json list sources`. */
export function parseMonitorsJson(raw: string): MonitorSource[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return (parsed as PactlSource[]).filter(isMonitor).map((source) => ({
    name: source.name as string,
    description:
      typeof source.description === 'string' && source.description
        ? source.description
        : (source.name as string)
  }))
}

/** Parses `pactl list short sources`, for pactl builds without JSON output. */
export function parseMonitorsShort(raw: string): MonitorSource[] {
  return raw
    .split('\n')
    .map((line) => line.split('\t')[1]?.trim() ?? '')
    .filter((name) => name.endsWith('.monitor'))
    .map((name) => ({ name, description: name }))
}
