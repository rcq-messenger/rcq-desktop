// Per-row contact action sheet. Renders as a modal-overlay
// dropdown anchored to the row — same affordances iOS exposes
// via long-press (Favorite / Mute / Archive / Block / Remove).
//
// Three local-only states (Favorite / Mute / Archive) write to
// localStorage; Block + Remove hit the backend.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Api, type Contact } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import {
  useArchive,
  useFavorites,
  useMutedPeers,
} from '../lib/local-store'

interface Props {
  contact: Contact
  onClose: () => void
  onChanged: () => void
}

export function ContactActionsMenu({ contact, onClose, onChanged }: Props) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const favorites = useFavorites()
  const archive = useArchive()
  const muted = useMutedPeers()
  const ref = useRef<HTMLDivElement | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Click-outside closes — same affordance the StatusPicker uses.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [onClose])

  async function toggleBlock() {
    if (!identity || busy) return
    setBusy(true)
    setError(null)
    try {
      await Api.blockContact(identity, contact.uin, !contact.blocked)
      onChanged()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!identity || busy) return
    setBusy(true)
    setError(null)
    try {
      await Api.removeContact(identity, contact.uin)
      // Drop client-side flags too — no point keeping favorite /
      // archive / mute pointers to a contact you no longer have.
      favorites.remove(contact.uin)
      archive.remove(contact.uin)
      muted.remove(contact.uin)
      onChanged()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  const isFav = favorites.has(contact.uin)
  const isMuted = muted.has(contact.uin)
  const isArchived = archive.has(contact.uin)

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 w-56 bg-surface border border-line rounded-lg shadow-lg py-1 z-30 text-sm"
      onClick={(e) => e.stopPropagation()}
    >
      <Row
        icon={<StarIcon filled={isFav} />}
        label={isFav ? t('contact_actions.unfavorite') : t('contact_actions.favorite')}
        onClick={() => {
          favorites.toggle(contact.uin)
          onClose()
        }}
      />
      <Row
        icon={<BellIcon off={isMuted} />}
        label={isMuted ? t('contact_actions.unmute') : t('contact_actions.mute')}
        onClick={() => {
          muted.toggle(contact.uin)
          onClose()
        }}
      />
      <Row
        icon={<ArchiveIcon />}
        label={isArchived ? t('contact_actions.unarchive') : t('contact_actions.archive')}
        onClick={() => {
          archive.toggle(contact.uin)
          onClose()
        }}
      />
      <Divider />
      <Row
        icon={<BanIcon />}
        label={contact.blocked ? t('contact_actions.unblock') : t('contact_actions.block')}
        destructive
        onClick={() => void toggleBlock()}
        busy={busy}
      />
      {!confirmRemove ? (
        <Row
          icon={<TrashIcon />}
          label={t('contact_actions.remove')}
          destructive
          onClick={() => setConfirmRemove(true)}
        />
      ) : (
        <div className="px-3 py-2 space-y-1">
          <p className="text-xs text-fg-secondary">{t('contact_actions.remove_confirm')}</p>
          <div className="flex gap-1">
            <button
              onClick={() => setConfirmRemove(false)}
              className="flex-1 h-8 rounded border border-line text-xs"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => void remove()}
              disabled={busy}
              className="flex-1 h-8 rounded bg-red-600 hover:bg-red-700 text-white text-xs font-semibold disabled:opacity-40"
            >
              {busy ? '…' : t('contact_actions.remove_short')}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="px-3 py-1 text-xs text-red-600">{error}</div>
      )}
    </div>
  )
}

function Row({
  icon,
  label,
  onClick,
  destructive,
  busy,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  destructive?: boolean
  busy?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={
        'w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-surface-dim transition-colors disabled:opacity-40 ' +
        (destructive ? 'text-red-600' : 'text-fg-primary')
      }
    >
      <span className="w-4 h-4 flex-shrink-0 inline-flex items-center justify-center">{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  )
}

function Divider() {
  return <div className="h-px bg-line my-1" />
}

// Inline SVG icons — Lucide-style 16px, 1.5 stroke. Inline rather
// than depending on lucide-react keeps the bundle a few KB lighter
// for what is a tiny set of glyphs.
function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

function BellIcon({ off }: { off: boolean }) {
  if (off) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
        <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
        <path d="M18 8a6 6 0 0 0-9.33-5" />
        <line x1="2" y1="2" x2="22" y2="22" />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function ArchiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  )
}

function BanIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  )
}
