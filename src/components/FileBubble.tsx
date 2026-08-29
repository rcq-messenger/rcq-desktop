// Inline chat document (#16). A compact chip with a file glyph, the original
// name + a human-readable size. A press opens the message menu (the caller
// passes `onPress`), where "download" decrypts the blob (lib/media) and saves
// it with the original file name + MIME; without `onPress` the click downloads
// directly, as it always did. `busy` mirrors the caller-driven download so the
// chip still shows its spinner while the menu's action runs. `disabledNote`
// renders the chip inert — the group's owner turned files off.

import { useState } from 'react'
import { useIdentity } from '../lib/identity-context'
import { downloadEncryptedFile } from '../lib/media'
import { useI18n } from '../lib/i18n-context'
import { VoiceBubble } from './VoiceBubble'

interface Props {
  mediaId: string
  mediaKey: string
  fileName?: string
  mime?: string
  size?: number
  /// Cross-island groups: fetch from the GROUP's island. Defaults to ours.
  apiBase?: string
  /// Open the message menu at this element instead of downloading. The
  /// download then lives in the menu — a file press must never trigger a
  /// save by itself (same rule links follow now).
  onPress?: (anchor: HTMLElement) => void
  /// The caller is downloading this file right now (menu action) — show
  /// the spinner even though the press didn't start it here.
  busy?: boolean
  /// Files are switched off in this group: render inert with this note.
  disabledNote?: string
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

export function FileBubble({ mediaId, mediaKey, fileName, mime, size, apiBase, onPress, busy: busyOutside, disabledNote }: Props) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [selfBusy, setSelfBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  // An audio FILE plays inline (megalist B2, "в целом аудио файлы"): the same
  // lazy player the voice bubble uses, with the name + download chip beneath
  // it so saving stays one press away.
  if (!disabledNote && mime && mime.startsWith('audio/')) {
    return (
      <div className="rounded-lg bg-field px-3 py-2 max-w-[18rem] space-y-1">
        <VoiceBubble apiBase={apiBase} mediaId={mediaId} mediaKey={mediaKey} />
        <button
          onClick={(e) => {
            if (onPress) return onPress(e.currentTarget)
            if (!identity || selfBusy) return
            setSelfBusy(true)
            void downloadEncryptedFile(apiBase ?? identity.apiBase, mediaId, mediaKey, fileName || 'audio', mime)
              .then((ok) => { if (!ok) setFailed(true) })
              .finally(() => setSelfBusy(false))
          }}
          className="block w-full truncate text-left text-[0.6875rem] text-fg-dim hover:text-fg-primary"
        >
          {failed ? t('chat.media.unavailable') : `${fileName || 'audio'}${fmtSize(size) ? ` · ${fmtSize(size)}` : ''}`}
        </button>
      </div>
    )
  }

  const name = fileName || 'file'
  const sizeLabel = fmtSize(size)
  const busy = busyOutside || selfBusy
  const disabled = disabledNote != null

  async function download() {
    if (!identity || busy) return
    setSelfBusy(true)
    setFailed(false)
    const ok = await downloadEncryptedFile(apiBase ?? identity.apiBase, mediaId, mediaKey, name, mime)
    setSelfBusy(false)
    if (!ok) setFailed(true)
  }

  const subLabel = disabledNote
    ? disabledNote
    : failed
      ? t('chat.media.unavailable')
      : sizeLabel
        ? `${sizeLabel} · ${t('chat.media.download')}`
        : t('chat.media.download')

  return (
    <button
      onClick={(e) => {
        if (disabled) return
        if (onPress) return onPress(e.currentTarget)
        void download()
      }}
      // No onContextMenu here on purpose: the chat wraps every file row in a
      // right-click/long-press handler of its own, and a second one on the
      // chip toggled the menu twice — open and instantly shut. And no HTML
      // `disabled` for the files-off state: a disabled control swallows the
      // wrapper's right-click/long-press too, which took report/reply/menu
      // with it. Inert is a no-op click, not a dead element.
      aria-disabled={disabled || undefined}
      className={`flex items-center gap-3 rounded-lg bg-field px-3 py-2.5 text-left transition-colors max-w-[18rem] ${
        disabled ? 'opacity-60 cursor-default' : 'hover:bg-line/40'
      }`}
      title={disabledNote ?? t('chat.media.download')}
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
        <span className="block text-[0.6875rem] text-fg-dim">{subLabel}</span>
      </span>
    </button>
  )
}
