import { useEffect, useRef, useState } from 'react'
import { loadEncryptedAudio } from '../lib/media'
import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'

function mmss(total: number): string {
  const t = Math.max(0, Math.round(total))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

/**
 * A voice note / audio clip in a bubble (megalist B2). Lazy: the sealed blob
 * is only fetched and decrypted on the first press, so a thread of voice
 * notes doesn't pull megabytes on open. Seekable — click the track. The
 * player deliberately does NOT auto-close or auto-advance when the clip ends
 * (the founder's Л2.2 complaint about iOS): it rewinds to the start and sits
 * there, replayable, exactly where it was.
 */
export function VoiceBubble({
  apiBase,
  mediaId,
  mediaKey,
  durationSec,
  accent = false,
}: {
  apiBase?: string
  mediaId: string
  mediaKey: string
  durationSec?: number
  accent?: boolean
}) {
  const { t } = useI18n()
  const { identity } = useIdentity()
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(durationSec ?? 0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  useEffect(() => () => {
    audioRef.current?.pause()
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
  }, [])

  async function ensureLoaded(): Promise<HTMLAudioElement | null> {
    if (audioRef.current) return audioRef.current
    setState('loading')
    const base = apiBase ?? identity?.apiBase
    if (!base) {
      setState('failed')
      return null
    }
    const url = await loadEncryptedAudio(base, mediaId, mediaKey)
    if (!url) {
      setState('failed')
      return null
    }
    urlRef.current = url
    const a = new Audio(url)
    a.addEventListener('timeupdate', () => setPos(a.currentTime))
    a.addEventListener('durationchange', () => {
      if (Number.isFinite(a.duration) && a.duration > 0) setDur(a.duration)
    })
    a.addEventListener('ended', () => {
      setPlaying(false)
      a.currentTime = 0
      setPos(0)
    })
    a.addEventListener('pause', () => setPlaying(false))
    a.addEventListener('play', () => setPlaying(true))
    audioRef.current = a
    setState('ready')
    return a
  }

  async function toggle() {
    const a = await ensureLoaded()
    if (!a) return
    if (a.paused) void a.play()
    else a.pause()
  }

  async function seek(e: React.MouseEvent<HTMLDivElement>) {
    const a = await ensureLoaded()
    if (!a || !dur) return
    const r = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    a.currentTime = frac * dur
    setPos(a.currentTime)
  }

  const frac = dur > 0 ? Math.min(1, pos / dur) : 0
  return (
    <div className="flex items-center gap-2.5 min-w-[190px] py-0.5" data-voice-bubble>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={state === 'loading'}
        aria-label={playing ? t('voice.pause') : t('voice.play')}
        className={`h-9 w-9 rounded-full flex-none flex items-center justify-center transition-colors ${
          accent ? 'bg-accent text-white' : 'bg-field text-fg-primary'
        } ${state === 'loading' ? 'opacity-60' : 'hover:opacity-90'}`}
      >
        {state === 'loading' ? (
          <span className="block h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
        ) : playing ? (
          <PauseGlyph />
        ) : (
          <PlayGlyph />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div
          role="slider"
          aria-valuemin={0}
          aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(pos)}
          onClick={(e) => void seek(e)}
          className="h-6 flex items-center cursor-pointer"
        >
          <div className="relative h-1.5 w-full rounded-full bg-fg-primary/15 overflow-hidden">
            <div
              className={`absolute inset-y-0 left-0 ${accent ? 'bg-accent' : 'bg-fg-secondary'}`}
              style={{ width: `${frac * 100}%` }}
            />
          </div>
        </div>
        <div className="text-[0.625rem] text-fg-dim tabular-nums">
          {state === 'failed'
            ? t('voice.failed')
            : `${mmss(playing || pos > 0 ? pos : dur)}${dur ? ` / ${mmss(dur)}` : ''}`}
        </div>
      </div>
    </div>
  )
}

function PlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function PauseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  )
}
