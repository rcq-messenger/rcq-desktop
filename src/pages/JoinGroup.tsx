// Standalone group-join page for the `/g/:id` deep link — someone
// opening a shared `chat.rcq.app/g/<id>` link directly in the browser.
// Cross-island groups (federation §5c): the segment may carry the
// group's host island as `<id>@<host>` — GroupJoinCard handles the
// guest-registration join. (Links shared from iOS/Android point at
// `rcq.app/g/<id>` today; the landing would need a redirect to
// chat.rcq.app to feed this route. In-chat invite links are handled
// inline by GroupJoinCard.)

import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { putRoomKey } from '../lib/group-state'
import { GroupJoinCard } from '../components/GroupJoinCard'
import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'

export function JoinGroup() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()
  const params = useParams<{ groupId?: string }>()
  // `123` or `123@is2.rcq.app`
  const raw = params.groupId ?? ''
  const at = raw.indexOf('@')
  const groupId = Number(at >= 0 ? raw.slice(0, at) : raw)
  const host = at >= 0 ? raw.slice(at + 1).toLowerCase() : null

  // Stage 6 phase 2: an unlisted room's invite carries its state key in the
  // URL FRAGMENT (#k=<ver>.<key>) - the browser never sent it to any server.
  // Stored before anything else so the sealed name renders the moment the
  // roster arrives; harmless for a link without one. Monotonic in the store,
  // so a stale link can never roll a rotated room back.
  useEffect(() => {
    const m = /[#&]k=(\d+)\.([^&]+)/.exec(window.location.hash)
    if (m && Number.isFinite(groupId) && groupId > 0) {
      putRoomKey(groupId, Number(m[1]), decodeURIComponent(m[2]))
    }
  }, [groupId])

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  if (!Number.isFinite(groupId) || groupId <= 0) {
    navigate('/contacts', { replace: true })
    return null
  }

  return (
    <div className="min-h-screen flex flex-col bg-surface-dim">
      <header className="rcq-header sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/contacts" className="text-fg-secondary hover:text-fg-primary px-2">
            ←
          </Link>
          <div className="font-medium">{t('group_join.title')}</div>
        </div>
      </header>
      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <GroupJoinCard groupId={groupId} host={host} />
      </main>
    </div>
  )
}
