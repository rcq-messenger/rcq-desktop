import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Api, type GroupPreview } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { GroupAvatar } from './GroupAvatar'
import { BadgeMark } from './BadgeMark'

/// Open rooms, biggest first, each joinable in one click. Drawn only when the
/// island answered with something: no heading over an empty strip. Every new
/// account used to be dropped into one beta room; this is the replacement,
/// and joining is the person's own click (founder, 05.09).
export function DiscoverGroupsStrip() {
  const { t } = useI18n()
  const { identity } = useIdentity()
  const navigate = useNavigate()
  const [rooms, setRooms] = useState<GroupPreview[]>([])
  const [joining, setJoining] = useState<number | null>(null)

  useEffect(() => {
    if (!identity) return
    let alive = true
    Api.discoverGroups(identity)
      .then((rows: GroupPreview[]) => { if (alive) setRooms(rows) })
      .catch(() => { /* an island that cannot answer draws nothing */ })
    return () => { alive = false }
  }, [identity])

  if (rooms.length === 0 || !identity) return null

  const join = async (room: GroupPreview) => {
    if (joining !== null) return
    setJoining(room.id)
    try {
      const g = await Api.joinGroup(identity, room.id)
      navigate(`/chat/g/${g.id}`)
    } catch {
      // Refused since (closed, blocked): the card goes, the strip stays.
      setRooms((r) => r.filter((x) => x.id !== room.id))
    } finally {
      setJoining(null)
    }
  }

  return (
    <div className="px-4 pt-6 pb-2 space-y-2">
      <div className="text-xs uppercase tracking-wide text-fg-dim">{t('contacts.discover.title')}</div>
      <div className="flex gap-2.5 overflow-x-auto pb-1 -mx-4 px-4">
        {rooms.map((room) => (
          <div key={room.id} className="shrink-0 w-[132px] rounded-2xl bg-field p-3 flex flex-col items-center gap-2">
            <GroupAvatar size={48} mediaId={room.avatar_media_id ?? undefined} mediaKey={room.avatar_media_key ?? undefined} />
            <div className="flex items-center gap-1 max-w-full">
              <div className="text-sm font-semibold text-fg-primary truncate">{room.name}</div>
              <BadgeMark kind={room.badge} className="h-3 w-3 shrink-0" />
            </div>
            <div className="text-[0.6875rem] text-fg-dim">{t('section.groups.members', { n: room.member_count })}</div>
            <button
              type="button"
              disabled={joining !== null}
              onClick={() => void join(room)}
              className={`text-sm font-medium px-3 py-1 rounded-full transition-colors ${joining === room.id ? 'text-fg-dim' : 'text-accent hover:bg-accent/10'}`}
            >
              {t('contacts.discover.join')}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
