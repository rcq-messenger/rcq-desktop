// Status picker — small click-out dropdown rendered next to the
// header's self-strip. Picks one of the five canonical states and
// PUTs to /presence/status. The user's contact list refreshes via
// the WS `presence` push the backend fires after every status
// change.

import { AnimatePresence } from 'framer-motion'
import { MenuPanel } from './MenuPanel'
import { useEffect, useRef, useState } from 'react'
import { Api, type UserStatus } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { PersonAvatar } from './PersonAvatar'
import { StatusIcon } from './StatusIcon'

const STATES: UserStatus[] = ['online', 'away', 'dnd', 'invisible', 'offline']

interface Props {
  current: UserStatus
  /// Fired immediately with the new status so the host can update
  /// optimistically; the backend echo via WS will reconcile if the
  /// PUT actually fails.
  onChange: (s: UserStatus) => void
  /// The account's own picture, when it has one. Absent means the plain
  /// status glyph, which is what this always drew.
  avatarMediaId?: string | null
  avatarMediaKey?: string | null
}

export function StatusPickerButton({ current, onChange, avatarMediaId, avatarMediaKey }: Props) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  // Click-outside handler for the dropdown — preserves the iOS feel
  // where tapping anywhere outside a picker dismisses it.
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  async function pick(s: UserStatus) {
    if (!identity) return
    setOpen(false)
    if (s === current) return
    onChange(s)
    try {
      await Api.setStatus(identity, s)
    } catch {
      // Backend's WS will reconcile if the PUT actually failed —
      // skipping noisy UI for a transient.
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center p-1 rounded-md hover:bg-surface-dim transition-colors"
        aria-label={t('status.picker')}
        title={t(`status.${current}`)}
      >
        {/* The picture, with the status kept as the badge on its edge — the
            same shape the phones draw. Without one this falls straight back to
            the plain status glyph, so nothing changes for anyone who never set
            a picture. */}
        {avatarMediaId && avatarMediaKey ? (
          <PersonAvatar
            status={current}
            size={26}
            mediaId={avatarMediaId}
            mediaKey={avatarMediaKey}
          />
        ) : (
          <StatusIcon status={current} size={20} />
        )}
      </button>
      <AnimatePresence>
        {open && (
          <MenuPanel className="left-0 py-1 min-w-[160px]">
            {STATES.map((s) => (
              <button
                key={s}
                onClick={() => void pick(s)}
                className="w-full px-3 py-2 flex items-center gap-2 text-sm hover:bg-field text-left"
              >
                <StatusIcon status={s} size={18} />
                <span className={s === current ? 'font-semibold' : ''}>
                  {t(`status.${s}`)}
                </span>
              </button>
            ))}
          </MenuPanel>
        )}
      </AnimatePresence>
    </div>
  )
}
