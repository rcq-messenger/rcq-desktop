// Per-row contact action sheet. Renders as a modal-overlay
// dropdown anchored to the row — same affordances iOS exposes
// via long-press (Favorite / Mute / Archive / Block / Remove).
//
// Three local-only states (Favorite / Mute / Archive) write to
// localStorage; Block + Remove hit the backend.

import { MenuPanel } from './MenuPanel'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Api, type Contact } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import {
  useArchive,
  useContactAliases,
  useFavorites,
  useMutedPeers,
} from '../lib/local-store'
import { peerKey } from '../lib/sections'
import { forgetSectionMember } from '../lib/sections-vault'

interface Props {
  contact: Contact
  onClose: () => void
  onChanged: () => void
  onPreview?: () => void
}

export function ContactActionsMenu({ contact, onClose, onChanged, onPreview }: Props) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const favorites = useFavorites()
  const archive = useArchive()
  const muted = useMutedPeers()
  const { aliasFor, setAlias } = useContactAliases()
  const ref = useRef<HTMLDivElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  // ⚠ contact.host rides along everywhere: for a normal contact it is absent
  // and the alias keeps the bare-uin key, but if a host-bearing row ever
  // reaches this menu, a bare-key write would rename the LOCAL person wearing
  // the same digits (see aliasKey in local-store).
  const [name, setName] = useState(() => aliasFor(contact.uin, contact.host) ?? '')
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
      // ...and out of the section that held them, with a tombstone, because
      // this is a deliberate local action. That is the ONLY thing allowed to
      // prune the sections slot: a chat that merely fails to render is left
      // alone, since a roster fetch that failed once would otherwise empty
      // every device's sections.
      forgetSectionMember(identity, peerKey(contact.uin, contact.host))
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

  if (renaming) {
    const save = () => {
      setAlias(contact.uin, name || null, contact.host)
      onChanged()
      onClose()
    }
    return (
      <MenuPanel panelRef={ref} className="right-0 w-56 text-sm" onClick={(e) => e.stopPropagation()}>
        <div className="p-3 space-y-2">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('ci.actions.rename')}
          </div>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={48}
            placeholder={contact.nickname || `#${contact.uin}`}
            className="w-full h-9 px-2 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
          <div className="flex gap-2">
            <button
              onClick={() => setRenaming(false)}
              className="flex-1 h-8 rounded-md bg-field text-xs font-medium hover:bg-line/50"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={save}
              className="flex-1 h-8 rounded-md bg-accent hover:bg-accent-dim text-white text-xs font-semibold"
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      </MenuPanel>
    )
  }

  return (
    <MenuPanel panelRef={ref} className="right-0 w-56 py-1 text-sm" onClick={(e) => e.stopPropagation()}>
      {/* Same first row as the cross-island menu: my own name for them,
          device-only. It existed only there and on the profile page, so
          renaming an ordinary contact meant leaving the list — reported as
          "cannot set a name at all". */}
      {onPreview && (
        <Row
          icon={<EyeIcon />}
          label={t('contact_actions.preview')}
          onClick={() => {
            onPreview()
            onClose()
          }}
        />
      )}
      <Row icon={<PencilIcon />} label={t('ci.actions.rename')} onClick={() => setRenaming(true)} />
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
              className="flex-1 h-8 rounded bg-field text-xs"
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
    </MenuPanel>
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
        'w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-field transition-colors disabled:opacity-40 ' +
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
function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

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


function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
