import { useCallback, useEffect, useRef, useState } from 'react'

export interface AudioPlayer {
  ref: React.RefObject<HTMLAudioElement | null>
  src: string | null
  playing: boolean
  /** Seconds. */
  currentTime: number
  duration: number
  rate: number
  error: string | null
  toggle: () => void
  seek: (seconds: number) => void
  skip: (delta: number) => void
  setRate: (rate: number) => void
}

/**
 * Drives one <audio> element and keeps its position in React state, so the
 * transcript can both scrub the audio and follow it.
 */
export function useAudioPlayer(src: string | null): AudioPlayer {
  const ref = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRateState] = useState(1)
  const [error, setError] = useState<string | null>(null)

  // A new recording starts from the beginning, stopped.
  useEffect(() => {
    setPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    setError(null)
  }, [src])

  useEffect(() => {
    const element = ref.current
    if (!element) return undefined

    const onTime = (): void => setCurrentTime(element.currentTime)
    const onDuration = (): void => {
      // A WAV written with a patched header can report Infinity until seekable.
      if (Number.isFinite(element.duration)) setDuration(element.duration)
    }
    const onPlay = (): void => setPlaying(true)
    const onPause = (): void => setPlaying(false)
    const onEnded = (): void => setPlaying(false)
    const onError = (): void => setError('Impossibile riprodurre la registrazione.')

    element.addEventListener('timeupdate', onTime)
    element.addEventListener('loadedmetadata', onDuration)
    element.addEventListener('durationchange', onDuration)
    element.addEventListener('play', onPlay)
    element.addEventListener('pause', onPause)
    element.addEventListener('ended', onEnded)
    element.addEventListener('error', onError)

    return () => {
      element.removeEventListener('timeupdate', onTime)
      element.removeEventListener('loadedmetadata', onDuration)
      element.removeEventListener('durationchange', onDuration)
      element.removeEventListener('play', onPlay)
      element.removeEventListener('pause', onPause)
      element.removeEventListener('ended', onEnded)
      element.removeEventListener('error', onError)
    }
  }, [src])

  const seek = useCallback((seconds: number) => {
    const element = ref.current
    if (!element) return
    const target = Math.max(0, seconds)
    element.currentTime = target
    setCurrentTime(target)
  }, [])

  const toggle = useCallback(() => {
    const element = ref.current
    if (!element) return
    if (element.paused) void element.play().catch(() => setError('Riproduzione non riuscita.'))
    else element.pause()
  }, [])

  const skip = useCallback(
    (delta: number) => {
      const element = ref.current
      if (!element) return
      seek(Math.min(element.duration || Infinity, element.currentTime + delta))
    },
    [seek]
  )

  const setRate = useCallback((value: number) => {
    const element = ref.current
    if (element) element.playbackRate = value
    setRateState(value)
  }, [])

  return { ref, src, playing, currentTime, duration, rate, error, toggle, seek, skip, setRate }
}
