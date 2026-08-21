// Inline chat photo. Fetches the encrypted blob and AES-256-GCM
// decrypts it (lib/media.ts) into an object URL; renders a small
// rounded thumbnail that opens full-size in a lightbox over the app.
// Shows a skeleton while loading and a placeholder on failure so a
// photo never collapses into a broken-image icon.

import { useEffect, useState } from 'react'
import { useIdentity } from '../lib/identity-context'
import { downloadEncryptedFile, loadEncryptedImage } from '../lib/media'
import { useI18n } from '../lib/i18n-context'
import { MediaLightbox } from './MediaLightbox'

interface Props {
  mediaId: string
  mediaKey: string
  /// Override the island the blob is fetched from (cross-island groups: media
  /// lives on the GROUP's island, not ours). Defaults to our own island.
  apiBase?: string
}

export function DecryptedImage({ mediaId, mediaKey, apiBase }: Props) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [zoomed, setZoomed] = useState(false)

  const base = apiBase ?? identity?.apiBase

  useEffect(() => {
    setUrl(null)
    setFailed(false)
    if (!base) return
    let alive = true
    void loadEncryptedImage(base, mediaId, mediaKey).then((u) => {
      if (!alive) return
      if (u) setUrl(u)
      else setFailed(true)
    })
    return () => {
      alive = false
    }
  }, [base, mediaId, mediaKey])

  /// Save the picture to disk. It goes through the shared helper rather than
  /// the object URL already in hand, because the desktop build has to route a
  /// save into Tauri's own dialog: an `<a download>` pointed at a `blob:` URL
  /// does nothing at all inside that webview (the same trap the lightbox itself
  /// was built to get out of).
  async function save() {
    if (!url || !base) return
    // The blob was created with the MIME sniffed from the real bytes
    // (lib/media), so the extension follows what was actually sent instead of
    // assuming everybody sends JPEG.
    const mime = await fetch(url).then((r) => r.blob()).then((b) => b.type).catch(() => '')
    const ext = mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : 'jpg'
    await downloadEncryptedFile(base, mediaId, mediaKey, `photo.${ext}`, mime || 'image/jpeg')
  }

  if (failed) {
    return (
      <div className="flex h-40 w-56 max-w-full items-center justify-center rounded-lg bg-surface-dim text-xs text-fg-dim">
        {t('chat.media.unavailable')}
      </div>
    )
  }
  if (!url) {
    return <div className="h-40 w-56 max-w-full animate-pulse rounded-lg bg-surface-dim" />
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setZoomed(true)}
        className="block overflow-hidden rounded-lg"
        title={t('chat.media.open')}
      >
        <img
          src={url}
          alt=""
          className="max-h-64 max-w-[16rem] w-auto object-cover"
          draggable={false}
        />
      </button>
      <MediaLightbox open={zoomed} onClose={() => setZoomed(false)}>
        {/* Saving the picture belongs where the picture is. A video already
            offered this under its player and a photo did not, so the one place
            the eye is actually on the content had nothing to do there but
            close. */}
        <div className="flex flex-col items-center gap-2">
          <img
            src={url}
            alt=""
            className="max-h-[85vh] max-w-[90vw] w-auto rounded-lg object-contain"
            draggable={false}
          />
          <button onClick={() => void save()} className="text-xs text-white/70 hover:text-white">
            ↓ {t('chat.media.download')}
          </button>
        </div>
      </MediaLightbox>
    </>
  )
}
