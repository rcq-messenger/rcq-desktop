// Group profile / settings — members list with status, owner badge,
// rename (owner only), leave / delete actions.

import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { PersonAvatar } from '../components/PersonAvatar'
import { GroupSettingsModal } from '../components/GroupSettingsModal'
import { GroupAvatar } from '../components/GroupAvatar'
import { Api, type RCQGroup } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { groupApiCtx } from '../lib/visited-islands'

export function GroupInfo() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()
  const params = useParams<{ groupId: string }>()
  const groupId = Number(params.groupId)

  const [group, setGroup] = useState<RCQGroup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [confirmDestroy, setConfirmDestroy] = useState(false)
  const [membersExpanded, setMembersExpanded] = useState(false)

  // Cross-island group: a negative route id is the local alias — resolve the
  // guest identity + server-side id for every call (local groups pass through).
  const gctx = identity ? groupApiCtx(identity, groupId) : null

  async function refresh() {
    if (!identity || !gctx) return
    try {
      setGroup(await Api.groupInfo(gctx.ident, gctx.gid))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.uin, groupId])

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  // Foreign group: WE are our guest uin on that island.
  const myUinThere = gctx?.host ? gctx.ident.uin : identity.uin
  const isOwner = group?.owner_uin === myUinThere
  // The backend's own two gates: `info` edits name/description/picture/pin,
  // `members` removes people. The owner has both implicitly.
  const myRow = group?.members.find((m) => m.uin === myUinThere)
  const canEditInfo = isOwner || !!myRow?.permissions?.includes('info')
  const canManageMembers = isOwner || !!myRow?.permissions?.includes('members')
  // The owner first, then everyone else. The island's roster query has no
  // ORDER BY and the initial rows are inserted from a Python set, so "who owns
  // this group" arrived in whatever order Postgres felt like — the founder was
  // not shown at the top of his own group because nothing had ever put him
  // there. The phones sort; now so does this.
  const roster = group
    ? [...group.members].sort((a, b) => {
        const ao = a.uin === group.owner_uin ? 0 : 1
        const bo = b.uin === group.owner_uin ? 0 : 1
        if (ao !== bo) return ao - bo
        return (a.nickname || `#${a.uin}`).localeCompare(b.nickname || `#${b.uin}`)
      })
    : []

  async function removeMember(uin: number) {
    if (!group || !gctx) return
    setBusy(true)
    try {
      await Api.removeGroupMember(gctx.ident, gctx.gid, uin)
      setGroup({ ...group, members: group.members.filter((m) => m.uin !== uin) })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  async function leaveOrDelete() {
    if (!group) return
    setBusy(true)
    try {
      if (isOwner) {
        await Api.deleteGroup(gctx!.ident, gctx!.gid)
      } else {
        await Api.removeGroupMember(gctx!.ident, gctx!.gid, myUinThere)
      }
      navigate('/contacts', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-dim">
      {showSettings && group && gctx && (
        <GroupSettingsModal
          group={group}
          ident={gctx.ident}
          gid={gctx.gid}
          isOwner={isOwner}
          onSaved={(g) => setGroup({ ...g, id: group.id, host: group.host })}
          onClose={() => setShowSettings(false)}
        />
      )}
      <header className="rcq-header sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/contacts" className="text-fg-secondary hover:text-fg-primary px-2">
            ←
          </Link>
          <div className="font-semibold">{t('group.info.title')}</div>
          {group && (
            <div className="ml-auto flex items-center gap-1">
              {canEditInfo && (
                <button
                  type="button"
                  onClick={() => setShowSettings(true)}
                  aria-label={t('group.settings.title')}
                  title={t('group.settings.title')}
                  className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-field"
                >
                  <GearIcon />
                </button>
              )}
              <Link to={`/chat/g/${group.id}`} className="text-sm text-accent font-semibold px-2">
                {t('contacts.open_chat')}
              </Link>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {!group && !error && (
          <div className="text-center text-sm text-fg-secondary py-12">
            {t('contacts.loading')}
          </div>
        )}

        {group && (
          <>
            <section className="bg-surface rounded-lg p-4 space-y-1 flex items-center gap-3">
              <GroupAvatar size={48} mediaId={group.avatar_media_id} mediaKey={group.avatar_media_key} />
              <div className="flex-1 min-w-0">
                <div className="font-bold text-lg truncate">{group.name}</div>
                <div className="text-xs text-fg-dim">
                  {t('section.groups.members', { n: group.members.length })}
                </div>
              </div>
            </section>

            <section className="bg-surface rounded-lg">
              {group.members_hidden && !isOwner ? (
                <div className="px-4 py-3 text-sm text-fg-secondary">
                  {t('group.info.members_hidden')}
                </div>
              ) : (
              <>
              <button
                onClick={() => setMembersExpanded((v) => !v)}
                className="w-full flex items-center justify-between px-4 py-2 text-xs font-semibold text-fg-secondary uppercase tracking-wide hover:bg-field"
              >
                <span>{t('group.info.members_section')} · {group.members.length}</span>
                <span className="text-fg-dim">{membersExpanded ? '▾' : '▸'}</span>
              </button>
              {membersExpanded && (
              <ul>
                {roster.map((m) => (
                  <li key={m.uin} className="relative">
                    <Link
                      to={m.uin === identity.uin ? '/profile' : `/profile/${m.uin}`}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-field"
                    >
                      {/* A member's picture rides with the roster, gated by
                          membership; without one this is the plain status icon,
                          so the screen is unchanged for everyone who never set
                          one. Presence stays on it as the badge — this is a
                          list of people, which is exactly where it means
                          something. */}
                      <PersonAvatar
                        status={m.status}
                        size={18}
                        mediaId={m.avatar_media_id}
                        mediaKey={m.avatar_media_key}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">
                          {m.nickname || `#${m.uin}`}
                          {m.uin === identity.uin && (
                            <span className="text-fg-dim font-normal ml-1">
                              ({t('group.info.you')})
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[0.625rem] text-fg-dim">#{m.uin}</div>
                      </div>
                      {m.uin === group.owner_uin && (
                        <span className="text-[0.625rem] font-bold text-accent uppercase tracking-wider">
                          {t('group.info.owner')}
                        </span>
                      )}
                    </Link>
                    {canManageMembers && m.uin !== group.owner_uin && m.uin !== myUinThere && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void removeMember(m.uin)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 h-6 px-2 rounded-md bg-field text-[0.6875rem] font-medium text-fg-secondary hover:bg-line/60 disabled:opacity-40"
                      >
                        {t('group.settings.remove_member')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              )}
              </>
              )}
            </section>

            <section className="bg-surface rounded-lg p-2">
              {!confirmDestroy ? (
                <button
                  onClick={() => setConfirmDestroy(true)}
                  className="w-full h-11 rounded-md flex items-center justify-center gap-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
                >
                  <LeaveIcon />
                  {isOwner ? t('group.info.delete') : t('group.info.leave')}
                </button>
              ) : (
                <div className="p-2 space-y-3">
                  <p className="text-xs text-fg-secondary">
                    {isOwner ? t('group.info.delete_warn') : t('group.info.leave_warn')}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmDestroy(false)}
                      disabled={busy}
                      className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/50 transition-colors"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      onClick={() => void leaveOrDelete()}
                      disabled={busy}
                      className="flex-1 h-9 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-semibold disabled:opacity-40 transition-colors"
                    >
                      {busy ? '…' : isOwner ? t('group.info.delete') : t('group.info.leave')}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  )
}

function LeaveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
