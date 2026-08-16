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

import { useEffect, useRef, useState } from 'react'
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
      className="absolute right-3 top-full z-30 mt-1 w-60 rounded-lg bg-surface shadow-lg overflow-hidden"
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
          <Row label={t('ci.actions.rename')} onClick={() => setRenaming(true)} />
          <Row
            label={blocked ? t('ci.actions.unblock') : t('ci.actions.block')}
            onClick={() => {
              if (blocked) unblockRequest(contact.uin, contact.host)
              else blockRequest(contact.uin, contact.host)
              onChanged()
              onClose()
            }}
          />
          <Row danger label={t('ci.actions.remove')} onClick={() => setConfirmRemove(true)} />
        </ul>
      )}
    </div>
  )
}

function Row({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <li>
      <button
        onClick={onClick}
        className={
          'w-full px-4 py-2 text-left text-sm transition-colors hover:bg-field ' +
          (danger ? 'text-red-600' : 'text-fg-primary')
        }
      >
        {label}
      </button>
    </li>
  )
}
