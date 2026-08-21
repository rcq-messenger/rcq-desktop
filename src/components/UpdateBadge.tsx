/// "There is a new version" as a thing you can see, rather than a thing that
/// interrupts you.
///
/// The desktop app used to announce a release exactly once, in an OS-modal
/// dialog at launch — so a window left open for a week (this one hides to the
/// tray rather than quitting) never heard about anything, and the only other
/// route was a button buried in Settings. The poll in MessageToasts now keeps
/// `getPendingUpdate()` current; this is where that fact shows up: a small
/// pill in the header that stays put, says which version, and installs on a
/// tap.
///
/// Nothing here on the web — there is no installer to run, and the browser
/// picks up a new bundle on its own with the next reload.

import { useEffect, useState } from 'react'
import {
  getPendingUpdate,
  installPendingUpdate,
  isInstallingUpdate,
  isTauri,
  subscribeUpdate,
} from '../lib/desktop'
import { useI18n } from '../lib/i18n-context'
import { useToast } from '../lib/toast'

/// The square-mode glyph: an update is a download, so the arrow lands in a tray.
function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

export function UpdateBadge({ className = '' }: { className?: string }) {
  const { t } = useI18n()
  const { toast } = useToast()
  const [pending, setPending] = useState(getPendingUpdate())
  // Fed by lib/desktop, not by this button alone: the OS update dialog is a
  // second door into the same install, and accepting there used to leave this
  // badge active as if nothing were happening (founder, 21.08).
  const [installing, setInstalling] = useState(isInstallingUpdate())

  useEffect(
    () =>
      subscribeUpdate(() => {
        setPending(getPendingUpdate())
        setInstalling(isInstallingUpdate())
      }),
    [],
  )

  if (!isTauri() || !pending) return null

  return (
    <button
      type="button"
      disabled={installing}
      onClick={() => {
        void installPendingUpdate().then((r) => {
          // On success the process is replaced and nothing below runs.
          if (r.kind === 'install_failed') toast(t('desktop.update.failed'), 'error')
        })
      }}
      title={t('desktop.update.body', { version: pending.version })}
      // In a narrow window the pill becomes a square icon (founder, 21.08) —
      // the version string is what did not fit, not the fact of the update.
      className={`h-7 px-2 max-[519px]:w-7 max-[519px]:px-0 inline-flex items-center justify-center rounded-md bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 transition-colors disabled:opacity-70 ${className}`}
    >
      {installing ? (
        // A working spinner, not an ellipsis: "Installing…" as text reads like
        // a label that forgot to change, while movement says a download is
        // actually running (founder, 21.08).
        <span
          role="status"
          aria-label={t('desktop.update.installing')}
          className="block h-3.5 w-3.5 rounded-full border-2 border-accent/30 border-t-accent animate-spin"
        />
      ) : (
        <>
          <span className="max-[519px]:hidden">{t('desktop.update.badge', { version: pending.version })}</span>
          <span className="hidden max-[519px]:inline-flex" aria-hidden>
            <DownloadIcon />
          </span>
        </>
      )}
    </button>
  )
}
