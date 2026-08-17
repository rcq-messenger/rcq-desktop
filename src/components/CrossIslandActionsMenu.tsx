// Per-row actions for a contact who lives on ANOTHER island.
//
// These rows had no menu at all: you could open the chat and nothing else. No
// way to give them your own name, no way to stop them writing to you, no way to
// take the row out of the list — and unlike a local contact there is no server
// to ask, because a cross-island contact exists only on this device.
//
// ⚠ Deliberately NOT the same menu as a local contact. Favourite, mute and
// archive are all keyed by the bare uin in `local-store`, and a uin is
// per-island: favouriting `1234@is2` would favourite the local #1234 as well.
// The three actions here are the ones whose stores are keyed by (uin, host) and
// therefore mean what they say.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../lib/i18n-context'
import { useContactAliases } from '../lib/local-store'
import { removeCrossIsland, type CrossIslandContact } from '../lib/crossisland-store'
import { blockRequest, isBlocked, unblockRequest } from '../lib/crossisland-requests'

interface Props {
  contact: CrossIslandContact
  onClose: () => void
  onChanged: () => void
}

export function CrossIslandActionsMenu({ contact, onClose, onChanged }: Props) {
  const { t } = useI18n()
  const { aliasFor, setAlias } = useContactAliases()
  const ref = useRef<HTMLDivElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(() => aliasFor(contact.uin, contact.host) ?? '')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const blocked = isBlocked(contact.uin, contact.host)

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="rcq-menu absolute right-3 top-full z-30 mt-1 w-60 rounded-lg shadow-lg overflow-hidden"
    >
      {renaming ? (
        <div className="p-3 space-y-2">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('ci.actions.rename')}
          </div>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={48}
            placeholder={contact.nickname || `${contact.uin}@${contact.host}`}
            className="w-full h-9 px-2 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              setAlias(contact.uin, name || null, contact.host)
              onChanged()
              onClose()
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
              onClick={() => {
                setAlias(contact.uin, name || null, contact.host)
                onChanged()
                onClose()
              }}
              className="flex-1 h-8 rounded-md bg-accent hover:bg-accent-dim text-white text-xs font-semibold"
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      ) : confirmRemove ? (
        <div className="p-3 space-y-2">
          {/* The warning is not boilerplate. A cross-island contact lives on
              this device only: their keys were pinned here when you added them
              and there is no server row to fetch back. */}
          <p className="text-xs text-fg-secondary leading-relaxed">{t('ci.actions.remove.warn')}</p>
          <div className="flex gap-2">
            <button
              onClick={() => setConfirmRemove(false)}
              className="flex-1 h-8 rounded-md bg-field text-xs font-medium hover:bg-line/50"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => {
                removeCrossIsland(contact.uin, contact.host)
                onChanged()
                onClose()
              }}
              className="flex-1 h-8 rounded-md bg-red-600 hover:bg-red-700 text-white text-xs font-semibold"
            >
              {t('ci.actions.remove')}
            </button>
          </div>
        </div>
      ) : (
        <ul className="py-1">
          <Row icon={<PencilIcon />} label={t('ci.actions.rename')} onClick={() => setRenaming(true)} />
          <Row
            icon={<BanIcon />}
            label={blocked ? t('ci.actions.unblock') : t('ci.actions.block')}
            onClick={() => {
              if (blocked) unblockRequest(contact.uin, contact.host)
              else blockRequest(contact.uin, contact.host)
              onChanged()
              onClose()
            }}
          />
          <Row icon={<TrashIcon />} danger label={t('ci.actions.remove')} onClick={() => setConfirmRemove(true)} />
        </ul>
      )}
    </div>
  )
}

/// Same shape as the local contact menu's row, icon and all. It had none, so
/// the two menus read as different kinds of thing when the only difference
/// between them is which island the person is on.
function Row({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <li>
      <button
        onClick={onClick}
        className={
          'w-full px-4 py-2 flex items-center gap-2.5 text-left text-sm transition-colors hover:bg-field ' +
          (danger ? 'text-red-600' : 'text-fg-primary')
        }
      >
        <span className="w-4 h-4 flex-shrink-0 inline-flex items-center justify-center">{icon}</span>
        <span className="flex-1">{label}</span>
      </button>
    </li>
  )
}

// Inline SVG, 14px / 1.8 stroke — the same set and the same weights as
// `ContactActionsMenu`, copied rather than shared for the same reason that file
// gives: a handful of glyphs is cheaper inline than a dependency.
function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
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
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}
