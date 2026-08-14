/// The audio-rooms corridor, and the room itself.
///
/// One page for both states because they are one place: the list is the
/// corridor, and entering a room replaces it with who is inside. The mesh and
/// all the signalling live in `lib/rooms.tsx`; this file is only what you see.
///
/// The room reads as a call, not as a settings page: round tiles with faces,
/// a green ring on whoever is talking, and three round buttons at the bottom.
/// Anything that is a form (create, rename) is a sheet, the way the rest of
/// the app has drawn forms since 0.117.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../lib/i18n-context'
import { useRooms, type RoomMember, type RoomSummary } from '../lib/rooms'
import { useIdentity } from '../lib/identity-context'
import { PersonAvatar } from '../components/PersonAvatar'
import {
  CameraIcon,
  CameraOffIcon,
  HangUpIcon,
  MicIcon,
  MicOffIcon,
  RoundButton,
} from '../components/RoundButton'

export default function AudioRooms() {
  const { t } = useI18n()
  const { identity } = useIdentity()
  const rooms = useRooms()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [sheet, setSheet] = useState<null | { mode: 'create' } | { mode: 'rename'; room: RoomSummary }>(null)

  const active = rooms.rooms.find((r) => r.id === rooms.activeRoomId) ?? null

  if (active) return <InRoom room={active} />

  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="rcq-header sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/contacts" className="text-fg-secondary hover:text-fg-primary p-2 -ml-2 rounded-md">
            ←
          </Link>
          <h1 className="text-lg font-semibold text-fg-primary">{t('rooms.title')}</h1>
          <button
            className="ml-auto h-9 px-3 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold transition-colors"
            onClick={() => setSheet({ mode: 'create' })}
          >
            {t('rooms.create')}
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        <section className="bg-surface rounded-lg p-4 space-y-3">
          <label className="text-xs font-semibold text-fg-secondary uppercase tracking-wide block">
            {t('rooms.joinTitle')}
          </label>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault()
              if (!key.trim() || busy) return
              setBusy(true)
              await rooms.joinByKey(key)
              setKey('')
              setBusy(false)
            }}
          >
            <input
              value={key}
              // Keys are upper-case, but the placeholder is a sentence: only
              // what the person types gets shouted.
              onChange={(e) => setKey(e.target.value.slice(0, 16).toUpperCase())}
              placeholder={t('rooms.joinKey')}
              className="flex-1 h-10 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm font-mono"
              autoCapitalize="characters"
            />
            <button
              type="submit"
              className="px-4 h-10 rounded-md bg-field hover:bg-line/50 text-fg-primary text-sm font-semibold transition-colors disabled:opacity-50"
              disabled={busy || key.trim().length < 4}
            >
              {t('rooms.join')}
            </button>
          </form>
          {rooms.error && <p className="text-sm text-red-600">{t(errorKey(rooms.error))}</p>}
        </section>

        {rooms.rooms.length === 0 ? (
          <p className="text-sm text-fg-secondary py-8 text-center">{t('rooms.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {rooms.rooms.map((r) => {
              const mine = identity != null && r.owner_uin === identity.uin
              return (
                <li key={r.id} className="bg-surface rounded-lg p-3 flex items-center gap-3">
                  <button className="flex-1 text-left min-w-0" onClick={() => void rooms.enter(r)}>
                    <div className="font-medium text-fg-primary truncate">{r.name}</div>
                    <div className="text-xs text-fg-secondary truncate">
                      {r.active_count > 0
                        ? t('rooms.inRoom', { n: r.active_count, cap: r.capacity }) + ' · '
                        : ''}
                      <span className="font-mono">{t('rooms.key', { key: r.join_key })}</span>
                    </div>
                  </button>
                  <IconButton
                    label={t('rooms.copyKey')}
                    onClick={() => void navigator.clipboard?.writeText(r.join_key)}
                  >
                    <CopyIcon />
                  </IconButton>
                  {mine && (
                    <IconButton label={t('rooms.rename')} onClick={() => setSheet({ mode: 'rename', room: r })}>
                      <PencilIcon />
                    </IconButton>
                  )}
                  {mine ? (
                    <IconButton label={t('rooms.delete')} danger onClick={() => void rooms.remove(r.id)}>
                      <TrashIcon />
                    </IconButton>
                  ) : (
                    <IconButton label={t('rooms.forget')} onClick={() => void rooms.forget(r.id)}>
                      <MinusIcon />
                    </IconButton>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </main>

      {sheet && (
        <NameSheet
          title={sheet.mode === 'create' ? t('rooms.create') : t('rooms.rename')}
          initial={sheet.mode === 'rename' ? sheet.room.name : ''}
          confirm={sheet.mode === 'create' ? t('rooms.create') : t('common.save')}
          onClose={() => setSheet(null)}
          onSubmit={async (name) => {
            if (sheet.mode === 'create') await rooms.create(name)
            else await rooms.rename(sheet.room.id, name)
            setSheet(null)
          }}
        />
      )}
    </div>
  )
}

/// Every reason the island can refuse a room, so a bounce is never silent.
function errorKey(error: string): string {
  switch (error) {
    case 'badkey':
      return 'rooms.badKey'
    case 'mic':
      return 'rooms.micDenied'
    case 'cam':
      return 'rooms.camDenied'
    case 'busy':
      return 'rooms.busy'
    case 'full':
      return 'rooms.full'
    case 'not_member':
      return 'rooms.notMember'
    case 'no_such_room':
      return 'rooms.noSuchRoom'
    default:
      return 'rooms.rejected'
  }
}

function IconButton({
  children,
  label,
  onClick,
  danger,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`w-9 h-9 rounded-md grid place-items-center transition-colors hover:bg-field ${
        danger ? 'text-red-600' : 'text-fg-secondary hover:text-fg-primary'
      }`}
    >
      {children}
    </button>
  )
}

/// Create and rename are the same one-field form, so they are one sheet.
function NameSheet({
  title,
  initial,
  confirm,
  onClose,
  onSubmit,
}: {
  title: string
  initial: string
  confirm: string
  onClose: () => void
  onSubmit: (name: string) => Promise<void>
}) {
  const { t } = useI18n()
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface w-full sm:max-w-md sm:rounded-lg rounded-t-2xl shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-4">
          <div className="font-semibold">{title}</div>
          <button onClick={onClose} className="text-fg-secondary hover:text-fg-primary px-2" aria-label={t('common.close')}>
            ✕
          </button>
        </header>
        <form
          className="p-4 pt-0 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!name.trim() || busy) return
            setBusy(true)
            await onSubmit(name)
            setBusy(false)
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 64))}
            placeholder={t('rooms.namePlaceholder')}
            className="w-full h-10 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
          />
          <button
            type="submit"
            className="w-full h-10 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold transition-colors disabled:opacity-50"
            disabled={busy || !name.trim()}
          >
            {confirm}
          </button>
        </form>
      </div>
    </div>
  )
}

function InRoom({ room }: { room: RoomSummary }) {
  const { t } = useI18n()
  const { identity } = useIdentity()
  const rooms = useRooms()

  return (
    <div className="min-h-screen bg-surface-dim flex flex-col">
      <header className="rcq-header sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <button
            className="text-fg-secondary hover:text-fg-primary p-2 -ml-2 rounded-md"
            onClick={() => rooms.leave()}
            aria-label={t('rooms.leave')}
          >
            ←
          </button>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-fg-primary truncate leading-tight">{room.name}</h1>
            <p className="text-xs text-fg-secondary truncate">
              {rooms.joining
                ? t('rooms.joining')
                : t('rooms.inRoom', { n: rooms.roster.length, cap: room.capacity })}
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-6">
        <div className="grid gap-4 justify-center" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(6.5rem, 1fr))' }}>
          {rooms.roster.map((m) => (
            <Tile
              key={m.uin}
              member={m}
              isSelf={identity != null && m.uin === identity.uin}
              stream={rooms.videos.get(m.uin) ?? null}
              selfLabel={t('rooms.you')}
            />
          ))}
        </div>
        {rooms.error === 'cam' && (
          <p className="text-sm text-red-600 text-center mt-6">{t('rooms.camDenied')}</p>
        )}
      </main>

      <div className="sticky bottom-0 bg-surface-dim/80 backdrop-blur-sm px-4 py-5">
        <div className="max-w-2xl mx-auto flex items-center justify-center gap-6">
          <RoundButton
            tone={rooms.micMuted ? 'on' : 'neutral'}
            label={rooms.micMuted ? t('rooms.unmute') : t('rooms.mute')}
            onClick={() => rooms.setMicMuted(!rooms.micMuted)}
          >
            {rooms.micMuted ? <MicOffIcon /> : <MicIcon />}
          </RoundButton>
          <RoundButton
            tone={rooms.cameraOn ? 'on' : 'neutral'}
            label={rooms.cameraOn ? t('rooms.cameraOff') : t('rooms.cameraOn')}
            onClick={() => void rooms.setCameraEnabled(!rooms.cameraOn)}
          >
            {rooms.cameraOn ? <CameraIcon /> : <CameraOffIcon />}
          </RoundButton>
          <RoundButton tone="danger" label={t('rooms.leave')} onClick={() => rooms.leave()}>
            <HangUpIcon />
          </RoundButton>
        </div>
      </div>
    </div>
  )
}

/// One participant: video if their camera is on, their picture if not, and
/// their initial underneath both. The letter is always drawn and never
/// replaced — a picture that is still loading must not leave a hole.
function Tile({
  member,
  isSelf,
  stream,
  selfLabel,
}: {
  member: RoomMember
  isSelf: boolean
  stream: MediaStream | null
  selfLabel: string
}) {
  const video = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream
  }, [stream])

  return (
    <div className="flex flex-col items-center gap-2 min-w-0">
      <div
        className={`relative rounded-full ring-2 transition-colors ${
          member.speaking ? 'ring-accent' : 'ring-transparent'
        }`}
        style={{ width: '5.25rem', height: '5.25rem' }}
      >
        <div className="absolute inset-0 rounded-full overflow-hidden bg-field grid place-items-center">
          <span className="text-2xl font-semibold text-fg-primary select-none">
            {(member.nickname || '#').charAt(0).toUpperCase()}
          </span>
          <PersonAvatar
            status="offline"
            showStatus={false}
            size={84}
            className="absolute inset-0"
            mediaId={member.avatarMediaId}
            mediaKey={member.avatarMediaKey}
          />
          {stream && (
            <video
              ref={video}
              autoPlay
              playsInline
              muted
              className={`absolute inset-0 w-full h-full object-cover ${isSelf ? '[transform:scaleX(-1)]' : ''}`}
            />
          )}
        </div>
        {member.mutedByOwner && (
          <span className="absolute -bottom-0.5 -right-0.5 w-6 h-6 rounded-full bg-surface grid place-items-center text-red-600">
            <MutedBadge />
          </span>
        )}
      </div>
      <span className="text-xs text-fg-secondary truncate max-w-full">
        {isSelf ? selfLabel : member.nickname}
      </span>
    </div>
  )
}

// ── glyphs ────────────────────────────────────────────────────────────────

function CopyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  )
}

function MinusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
    </svg>
  )
}

function MutedBadge() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 9v1a3 3 0 0 0 4.6 2.5M15 10V5a3 3 0 0 0-5.9-.7" />
      <path d="M5 10a7 7 0 0 0 10.7 6M19 10a7 7 0 0 1-.6 2.8M12 17v5M3 3l18 18" />
    </svg>
  )
}
