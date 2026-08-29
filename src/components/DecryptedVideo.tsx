// Inline chat video (#15). Renders the base64 JPEG poster with a play overlay
// + duration badge; the full video isn't fetched until the user hits play. On
// play we decrypt-to-blob (lib/media) into an object URL and swap in a native
// <video controls autoPlay> element. A download button pulls the same bytes to
// disk. The object URL is revoked on unmount so a decrypted video doesn't leak.

import { useEffect, useRef, useState } from 'react'
import { useIdentity } from '../lib/identity-context'
import { loadEncryptedVideo, downloadEncryptedFile } from '../lib/media'
import { useI18n } from '../lib/i18n-context'
import { MediaLightbox } from './MediaLightbox'

interface Props {
  mediaId: string
  mediaKey: string
  thumbnailB64?: string
  durationSec?: number
  /// Cross-island groups: fetch from the GROUP's island. Defaults to ours.
  apiBase?: string
}

function fmtDuration(sec?: number): string | null {
  if (sec == null || !isFinite(sec) || sec <= 0) return null
  const s = Math.round(sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

export function DecryptedVideo({ mediaId, mediaKey, thumbnailB64, durationSec, apiBase }: Props) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const urlRef = useRef<string | null>(null)

  // Revoke the decrypted object URL when the bubble unmounts.
  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  async function play() {
    if (!identity || loading || url) return
    setLoading(true)
    setFailed(false)
    const u = await loadEncryptedVideo(apiBase ?? identity.apiBase, mediaId, mediaKey)
    setLoading(false)
    if (u) {
      urlRef.current = u
      setUrl(u)
      setOpen(true)
    } else {
      setFailed(true)
    }
  }

  async function download() {
    if (!identity) return
    const ok = await downloadEncryptedFile(apiBase ?? identity.apiBase, mediaId, mediaKey, 'video.mp4', 'video/mp4')
    if (!ok) setFailed(true)
  }

  const poster = thumbnailB64 ? `data:image/jpeg;base64,${thumbnailB64}` : null
  const dur = fmtDuration(durationSec)

  // Playing happens over the app, centred on a dark backdrop, the same as a
  // photo: a video squeezed into the width of a bubble is unwatchable, and the
  // rest of the thread scrolling behind it is a distraction. Closing keeps the
  // decrypted URL, so re-opening is instant.
  if (url) {
    return (
      <>
        <div className="relative overflow-hidden rounded-lg bg-surface-dim">
          {poster ? (
            <img src={poster} alt="" className="max-h-64 max-w-[16rem] w-auto object-cover" draggable={false} />
          ) : (
            <div className="flex h-40 w-56 max-w-full items-center justify-center text-2xl">🎬</div>
          )}
          <button
            onClick={() => setOpen(true)}
            className="absolute inset-0 flex items-center justify-center bg-ink-black/20 hover:bg-ink-black/30 transition-colors"
            aria-label={t('chat.media.kind.video')}
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ink-black/55 text-white">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          </button>
        </div>
        <MediaLightbox open={open} onClose={() => setOpen(false)}>
          <div className="flex flex-col items-center gap-2">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={url}
              controls
              autoPlay
              className="max-h-[85vh] max-w-[90vw] w-auto rounded-lg bg-black"
            />
            <button onClick={() => void download()} className="text-xs text-white/70 hover:text-white">
              ↓ {t('chat.media.download')}
            </button>
          </div>
        </MediaLightbox>
      </>
    )
  }

  return (
    <div className="relative overflow-hidden rounded-lg bg-surface-dim">
      {poster ? (
        <img src={poster} alt="" className="max-h-64 max-w-[16rem] w-auto object-cover" draggable={false} />
      ) : (
        <div className="flex h-40 w-56 max-w-full items-center justify-center text-2xl">🎬</div>
      )}
      {/* Play overlay */}
      <button
        onClick={() => void play()}
        className="absolute inset-0 flex items-center justify-center bg-ink-black/20 hover:bg-ink-black/30 transition-colors"
        title={t('chat.media.kind.video')}
        aria-label={t('chat.media.kind.video')}
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ink-black/55 text-white">
          {loading ? (
            <span className="text-sm">…</span>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </span>
      </button>
      {dur && (
        <span className="absolute bottom-1.5 right-1.5 rounded bg-ink-black/70 px-1.5 py-0.5 text-[0.625rem] text-white">
          {dur}
        </span>
      )}
      {failed && (
        <span className="absolute bottom-1.5 left-1.5 rounded bg-red-600/85 px-1.5 py-0.5 text-[0.625rem] text-white">
          {t('chat.media.unavailable')}
        </span>
      )}
    </div>
  )
}
