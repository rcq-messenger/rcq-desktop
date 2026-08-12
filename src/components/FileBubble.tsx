// Inline chat document (#16). A compact chip with a file glyph, the original
// name + a human-readable size. Clicking decrypts the blob (lib/media) and
// triggers a browser download with the original file name + MIME. Shows a
// spinner while decrypting and an error label if the blob can't be fetched.

import { useState } from 'react'
import { useIdentity } from '../lib/identity-context'
import { downloadEncryptedFile } from '../lib/media'
import { useI18n } from '../lib/i18n-context'

interface Props {
  mediaId: string
  mediaKey: string
  fileName?: string
  mime?: string
  size?: number
  /// Cross-island groups: fetch from the GROUP's island. Defaults to ours.
  apiBase?: string
}

/// Human-readable byte size (1 KB = 1024 B).
function fmtSize(bytes?: number): string | null {
  if (bytes == null || bytes <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

export function FileBubble({ mediaId, mediaKey, fileName, mime, size, apiBase }: Props) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const name = fileName || 'file'
  const sizeLabel = fmtSize(size)

  async function download() {
    if (!identity || busy) return
    setBusy(true)
    setFailed(false)
    const ok = await downloadEncryptedFile(apiBase ?? identity.apiBase, mediaId, mediaKey, name, mime)
    setBusy(false)
    if (!ok) setFailed(true)
  }

  return (
    <button
      onClick={() => void download()}
      className="flex items-center gap-3 rounded-lg bg-field px-3 py-2.5 text-left hover:bg-line/40 transition-colors max-w-[18rem]"
      title={t('chat.media.download')}
    >
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-md bg-accent/15 text-accent">
        {busy ? (
          <span className="text-xs">…</span>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <polyline points="14 3 14 9 20 9" />
          </svg>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block text-[0.6875rem] text-fg-dim">
          {failed ? t('chat.media.unavailable') : sizeLabel ? `${sizeLabel} · ${t('chat.media.download')}` : t('chat.media.download')}
        </span>
      </span>
    </button>
  )
}
