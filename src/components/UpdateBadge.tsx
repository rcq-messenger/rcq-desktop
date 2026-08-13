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
import { getPendingUpdate, installPendingUpdate, isTauri, subscribeUpdate } from '../lib/desktop'
import { useI18n } from '../lib/i18n-context'
import { useToast } from '../lib/toast'

export function UpdateBadge({ className = '' }: { className?: string }) {
  const { t } = useI18n()
  const { toast } = useToast()
  const [pending, setPending] = useState(getPendingUpdate())
  const [busy, setBusy] = useState(false)

  useEffect(() => subscribeUpdate(() => setPending(getPendingUpdate())), [])

  if (!isTauri() || !pending) return null

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void installPendingUpdate().then((r) => {
          // On success the process is replaced and nothing below runs.
          setBusy(false)
          if (r.kind === 'install_failed') toast(t('desktop.update.failed'), 'error')
        })
      }}
      title={t('desktop.update.body', { version: pending.version })}
      className={`h-7 px-2 rounded-md bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 transition-colors disabled:opacity-50 ${className}`}
    >
      {busy ? t('desktop.update.installing') : t('desktop.update.badge', { version: pending.version })}
    </button>
  )
}
