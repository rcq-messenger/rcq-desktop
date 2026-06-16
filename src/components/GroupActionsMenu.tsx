// Per-row group action dropdown — the group-list equivalent of
// ContactActionsMenu. Tapping the ⋮ on a group used to navigate straight to
// the group page (founder read that as "the group opens"); now it opens a
// small menu (Group info / Mute / Leave), mirroring the contact affordance.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Api, type RCQGroup } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { useArchiveGroups, useFavoriteGroups, useMutedGroups } from '../lib/local-store'

interface Props {
  group: RCQGroup
  onClose: () => void
  onChanged: () => void
}

export function GroupActionsMenu({ group, onClose, onChanged }: Props) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()
  const muted = useMutedGroups()
  const favorites = useFavoriteGroups()
  const archive = useArchiveGroups()
  const ref = useRef<HTMLDivElement | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [onClose])

  async function leave() {
    if (!identity || busy) return
    setBusy(true)
    setError(null)
    try {
      // Leaving a group is removing yourself from its roster.
      await Api.removeGroupMember(identity, group.id, identity.uin)
      muted.remove(group.id)
      favorites.remove(group.id)
      archive.remove(group.id)
      onChanged()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  const isMuted = muted.has(group.id)
  const isFav = favorites.has(group.id)
  const isArchived = archive.has(group.id)

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 w-56 bg-surface border border-line rounded-lg shadow-lg py-1 z-30 text-sm"
      onClick={(e) => e.stopPropagation()}
    >
      <Row
        icon={<InfoIcon />}
        label={t('group_actions.info')}
        onClick={() => {
          onClose()
          navigate(`/groups/${group.id}`)
        }}
      />
      <Row
        icon={<StarIcon filled={isFav} />}
        label={isFav ? t('contact_actions.unfavorite') : t('contact_actions.favorite')}
        onClick={() => {
          favorites.toggle(group.id)
          onClose()
        }}
      />
      <Row
        icon={<BellIcon off={isMuted} />}
        label={isMuted ? t('contact_actions.unmute') : t('contact_actions.mute')}
        onClick={() => {
          muted.toggle(group.id)
          onClose()
        }}
      />
      <Row
        icon={<ArchiveIcon />}
        label={isArchived ? t('contact_actions.unarchive') : t('contact_actions.archive')}
        onClick={() => {
          archive.toggle(group.id)
          onClose()
        }}
      />
      <Divider />
      {!confirmLeave ? (
        <Row
          icon={<LeaveIcon />}
          label={t('group_actions.leave')}
          destructive
          onClick={() => setConfirmLeave(true)}
        />
      ) : (
        <div className="px-3 py-2 space-y-1">
          <p className="text-xs text-fg-secondary">{t('group_actions.leave_confirm')}</p>
          <div className="flex gap-1">
            <button
              onClick={() => setConfirmLeave(false)}
              className="flex-1 h-8 rounded border border-line text-xs"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => void leave()}
              disabled={busy}
              className="flex-1 h-8 rounded bg-red-600 hover:bg-red-700 text-white text-xs font-semibold disabled:opacity-40"
            >
              {busy ? '…' : t('group_actions.leave_short')}
            </button>
          </div>
        </div>
      )}
      {error && <div className="px-3 py-1 text-xs text-red-600">{error}</div>}
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

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
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

function ArchiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
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

function LeaveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  )
}
