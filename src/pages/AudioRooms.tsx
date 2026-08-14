/// The audio-rooms corridor, and the room itself.
///
/// One page for both states because they are one place: the list is the
/// corridor, and entering a room replaces it with who is inside. The mesh and
/// all the signalling live in `lib/rooms.tsx`; this file is only what you see.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../lib/i18n-context'
import { useRooms, type RoomSummary } from '../lib/rooms'
import { useIdentity } from '../lib/identity-context'

export default function AudioRooms() {
  const { t } = useI18n()
  const { identity } = useIdentity()
  const rooms = useRooms()
  const [newName, setNewName] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)

  const active = rooms.rooms.find((r) => r.id === rooms.activeRoomId) ?? null

  if (active) return <InRoom room={active} />

  return (
    <div className="min-h-screen bg-surface">
      <header className="rcq-header sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/contacts" className="text-fg-secondary hover:text-fg-primary p-2 -ml-2 rounded-md">
            ←
          </Link>
          <h1 className="text-lg font-semibold text-fg-primary">{t('rooms.title')}</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4">
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
            onChange={(e) => setKey(e.target.value.slice(0, 16))}
            placeholder={t('rooms.joinKey')}
            className="flex-1 h-11 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
            autoCapitalize="characters"
          />
          <button type="submit" className="px-4 h-11 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold transition-colors disabled:opacity-50" disabled={busy || key.trim().length < 4}>
            {t('rooms.join')}
          </button>
        </form>

        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!newName.trim() || busy) return
            setBusy(true)
            await rooms.create(newName)
            setNewName('')
            setBusy(false)
          }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value.slice(0, 64))}
            placeholder={t('rooms.namePlaceholder')}
            className="flex-1 h-11 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
          />
          <button type="submit" className="px-4 h-11 rounded-md bg-surface-dim hover:bg-field text-fg-primary text-sm font-semibold transition-colors disabled:opacity-50" disabled={busy || !newName.trim()}>
            {t('rooms.create')}
          </button>
        </form>

        {rooms.error === 'badkey' && <p className="text-sm text-red-600">{t('rooms.badKey')}</p>}
        {rooms.error === 'mic' && <p className="text-sm text-red-600">{t('rooms.micDenied')}</p>}

        {rooms.rooms.length === 0 ? (
          <p className="text-sm text-fg-secondary py-8 text-center">{t('rooms.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {rooms.rooms.map((r) => (
              <li key={r.id} className="bg-surface-dim rounded-lg p-3 flex items-center gap-3">
                <button className="flex-1 text-left" onClick={() => void rooms.enter(r)}>
                  <div className="font-medium text-fg-primary">{r.name}</div>
                  <div className="text-xs text-fg-secondary">
                    {r.active_count > 0
                      ? t('rooms.inRoom', { n: r.active_count, cap: r.capacity }) + ' · '
                      : ''}
                    {t('rooms.key', { key: r.join_key })}
                  </div>
                </button>
                <button
                  className="text-xs text-fg-secondary hover:text-fg-primary px-2 py-1"
                  onClick={() => void navigator.clipboard?.writeText(r.join_key)}
                  title={t('rooms.copyKey')}
                >
                  ⧉
                </button>
                {identity && r.owner_uin === identity.uin ? (
                  <button
                    className="text-xs text-red-600 px-2 py-1"
                    onClick={() => void rooms.remove(r.id)}
                    title={t('rooms.delete')}
                  >
                    ✕
                  </button>
                ) : (
                  <button
                    className="text-xs text-fg-secondary hover:text-fg-primary px-2 py-1"
                    onClick={() => void rooms.forget(r.id)}
                    title={t('rooms.forget')}
                  >
                    –
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

function InRoom({ room }: { room: RoomSummary }) {
  const { t } = useI18n()
  const rooms = useRooms()

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <div className="flex-1 max-w-2xl w-full mx-auto px-4 py-8 space-y-6">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-fg-primary">{room.name}</h1>
          <p className="text-sm text-fg-secondary mt-1">
            {rooms.joining
              ? t('rooms.joining')
              : t('rooms.inRoom', { n: rooms.roster.length, cap: room.capacity })}
          </p>
        </div>

        <ul className="space-y-2">
          {rooms.roster.map((m) => (
            <li key={m.uin} className="flex items-center gap-3">
              {/* The ring is the only thing that moves while people talk, so it
                  is the whole speaking indicator. */}
              <span
                className={`w-9 h-9 rounded-full grid place-items-center text-sm font-semibold bg-surface-dim text-fg-primary ring-2 ${
                  m.speaking ? 'ring-accent' : 'ring-transparent'
                }`}
              >
                {(m.nickname || '#').charAt(0).toUpperCase()}
              </span>
              <span className="text-fg-primary">{m.nickname}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="sticky bottom-0 border-t border-line bg-surface px-4 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-center gap-4">
          <button
            className={`px-5 h-11 rounded-md bg-surface-dim hover:bg-field text-sm font-semibold ${rooms.micMuted ? 'text-red-600' : 'text-fg-primary'}`}
            onClick={() => rooms.setMicMuted(!rooms.micMuted)}
          >
            {rooms.micMuted ? t('rooms.unmute') : t('rooms.mute')}
          </button>
          <button className="px-5 h-11 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-semibold" onClick={() => rooms.leave()}>
            {t('rooms.leave')}
          </button>
        </div>
      </div>
    </div>
  )
}
