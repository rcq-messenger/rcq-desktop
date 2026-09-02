// Group profile / settings: members list with status, owner badge,
// rename (owner only), leave / delete actions.
//
// Moderator rights are handed out from here (founder item 23). The island has
// exactly one grant mechanism, `POST /groups/{id}/members/{uin}/permissions`
// (owner-only, subset of delete|members|info), and until now nothing on
// web/desktop called it: `Api.setMemberPermissions` shipped with zero callers
// while both phones had the screen. There is no settable `admin` role on the
// island (the column exists, nothing ever writes it), so this grants
// capabilities rather than a rank.
//
// Ownership itself IS handed over from here now, through
// `POST /groups/{id}/transfer-owner` (founder item 23, second half). It used to
// be impossible, which made an owner who wanted out choose between deleting the
// room and abandoning it; the migration the founder described is handing it
// over and then leaving, so those two are offered as one flow.

import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { PersonAvatar } from '../components/PersonAvatar'
import { AddMemberSheet } from '../components/AddMemberSheet'
import { GroupSettingsModal } from '../components/GroupSettingsModal'
import { GroupAvatar } from '../components/GroupAvatar'
import { CenteredLoader } from '../components/Spinner'
import { Api, ApiError, parseErrorCode, parseRetryAfter, type GroupMember, type RCQGroup } from '../lib/api'
import { groupShareLink } from '../lib/group-invite'
import { roomKey, rotateRoomKey } from '../lib/group-state'
import { useGroupChanged } from '../lib/group-events'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { groupApiCtx } from '../lib/visited-islands'
import { compactCount } from '../lib/format-count'

/// The island's three granular moderator capabilities, in the order it
/// canonicalises them (`_GROUP_PERMS` in groups.py). Anything outside this set
/// is rejected with 400.
const GROUP_PERMS = ['delete', 'members', 'info'] as const

/// The island's refusals for a handover, mapped to what we say. Every one of
/// them is a fact about the TARGET or about us, never a network hiccup, so each
/// gets its own sentence instead of a shared "could not".
const TRANSFER_ERRORS: Record<string, string> = {
  owner_only: 'group.transfer.err.owner_only',
  already_owner: 'group.transfer.err.already_owner',
  not_a_member: 'group.transfer.err.not_a_member',
  no_such_user: 'group.transfer.err.no_such_user',
  target_suspended: 'group.transfer.err.target_suspended',
}

/// Where a member sits in the roster: 0 the owner, 1 a moderator, 2 someone
/// who is around, 3 the rest. A moderator is the `admin` role or any granted
/// capability, the same set the composer exempts from the room rules. Around
/// is the contact list's definition: away and do-not-disturb count, invisible
/// and offline do not, and neither does a member the island reports no
/// presence for.
function rosterTier(m: GroupMember, ownerUin: number): number {
  if (m.uin === ownerUin) return 0
  if (m.role === 'admin' || (m.permissions?.length ?? 0) > 0) return 1
  if (m.status === 'online' || m.status === 'away' || m.status === 'dnd') return 2
  return 3
}

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
  const [showAdd, setShowAdd] = useState(false)
  const [confirmDestroy, setConfirmDestroy] = useState(false)
  const [membersExpanded, setMembersExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  /// Which member's rights panel is open (uin), or null. Inline rather than a
  /// modal on purpose: the settings sheet carries a backdrop-filter, and a
  /// second overlay opened from inside one is the trap this repo has hit twice.
  const [rightsFor, setRightsFor] = useState<number | null>(null)
  /// Which member the "hand the group over" confirmation is open for, or null.
  const [transferFor, setTransferFor] = useState<number | null>(null)
  /// Who we just handed the group to, once the island has confirmed it. Kept
  /// separately from `group.owner_uin` because this drives the follow-up offer
  /// ("you can leave now"), which only makes sense to the person who just did
  /// it, not to everyone who reloads the screen afterwards.
  const [handedTo, setHandedTo] = useState<{ uin: number; name: string } | null>(null)
  const [transferError, setTransferError] = useState<string | null>(null)

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

  // ⚠ A roster carries PRESENCE, and presence is a snapshot of the moment it
  // was fetched: a screen left open put whoever came online afterwards at the
  // bottom under "everyone else", and someone who left stayed near the top
  // (#859, and the founder on iOS the same day). So it is asked again when the
  // window comes back, and on a timer for rooms small enough that the roster is
  // cheap - the flagship's two thousand members are hundreds of kilobytes, and
  // that one is not polled.
  useEffect(() => {
    if (!identity || !gctx) return
    const small = (group?.members.length ?? 0) <= 200
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onFocus)
    const timer = small ? window.setInterval(() => { void refresh() }, 45_000) : undefined
    return () => {
      document.removeEventListener('visibilitychange', onFocus)
      if (timer) window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.uin, groupId, group?.members.length])

  // This screen is the one that is entirely gated on ownership: the rights
  // buttons, the remove buttons, the settings gear, "delete" versus "leave".
  // So a handover performed from another device, or by the previous owner
  // while this page is open, has to land here live. Above 100 members the
  // island sends only the id and the new owner; that half re-gates everything
  // above immediately and the roster follows from the refetch behind it.
  useGroupChanged(
    { enabled: gctx != null && !gctx.host, ident: gctx?.ident ?? null, gid: gctx?.gid ?? null },
    (patch) => {
      setGroup((prev) => {
        if (!prev) return prev
        // ⚠ Keep the LOCAL alias id and host: the island's answer carries its
        // own ids, and this route was opened with ours.
        return patch.kind === 'snapshot'
          ? { ...patch.group, id: prev.id, host: prev.host }
          : { ...prev, owner_uin: patch.ownerUin }
      })
    },
  )

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
  // Inviting is NOT the `members` capability. That one is about taking people
  // out; the island lets any current member pull someone in ("admin gate would
  // make tiny groups feel locked in", groups.py), which is exactly what both
  // phones do and what the web was missing entirely.
  const isMember = isOwner || myRow != null
  // The owner, then the moderators, then whoever is around, then everyone
  // else, by name inside a tier (founder, 02.09: the same order on every
  // client). The island's roster query has no ORDER BY and the initial rows
  // are inserted from a Python set, so "who owns this group" arrived in
  // whatever order Postgres felt like — the founder was not shown at the top
  // of his own group because nothing had ever put him there.
  const roster = group
    ? [...group.members].sort((a, b) => {
        const ta = rosterTier(a, group.owner_uin)
        const tb = rosterTier(b, group.owner_uin)
        if (ta !== tb) return ta - tb
        const byName = (a.nickname || `${a.uin}`).localeCompare(b.nickname || `${b.uin}`, undefined, {
          sensitivity: 'accent',
        })
        // Two equal names would otherwise keep the roster's arrival order,
        // which is random, so the same group would shuffle between openings.
        return byName || a.uin - b.uin
      })
    : []

  /// Put the group's invite link on the clipboard. The route id is local to
  /// this device, so the link is built from the (island id, host) pair the rest
  /// of the world uses.
  async function copyShareLink() {
    // Stage 6 phase 2: an unlisted room's link carries the room state key in
    // the FRAGMENT - browsers never send it to any server, ours included.
    // The joiner reads the sealed name and the pinned rules before any
    // handshake completes, which is what the plaintext pin existed for.

    if (!identity) return
    try {
      let link = groupShareLink(identity, groupId)
      const k = group && !group.in_catalog ? roomKey(groupId) : null
      if (k) link += `#k=${k.v}.${encodeURIComponent(k.k)}`
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard denied — nothing was copied, so say nothing */
    }
  }

  async function removeMember(uin: number) {
    if (!group || !gctx) return
    setBusy(true)
    try {
      await Api.removeGroupMember(gctx.ident, gctx.gid, uin)
      const remaining = group.members.filter((m) => m.uin !== uin)
      setGroup({ ...group, members: remaining })
      // Stage 6 phase 2: a kicked member must not keep reading what the room
      // BECOMES - new key, re-sealed blob, fanned to whoever is left. Only
      // for rooms that carry a sealed identity at all.
      if (!group.in_catalog && roomKey(gctx.gid)) {
        void rotateRoomKey(gctx.ident, { ...group, members: remaining }, remaining).catch(() => undefined)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  /// Grant / revoke a member's moderator capabilities. Owner-only on the
  /// island too, so the gate below is a courtesy rather than the enforcement.
  /// The response is the whole group, roster included, and it carries the
  /// ISLAND's ids: keep the local alias id + host the route was opened with.
  async function setMemberRights(uin: number, permissions: string[]) {
    if (!group || !gctx) return
    setBusy(true)
    setError(null)
    try {
      const updated = await Api.setMemberPermissions(gctx.ident, gctx.gid, uin, permissions)
      setGroup({ ...updated, id: group.id, host: group.host })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  /// Hand the group over. Owner only, and irreversible from here: the island
  /// answers with the group as it now stands, and the moment that lands we are
  /// a plain member of it.
  ///
  /// ⚠ The response replaces the WHOLE local group, not just `owner_uin`. The
  /// roles moved with it (their row became the owner's, ours stopped being) and
  /// every gate on this screen reads both, so patching the single field would
  /// leave our own row still drawn with the rights it no longer has.
  async function transferOwner(uin: number, name: string) {
    if (!group || !gctx || busy) return
    setBusy(true)
    setTransferError(null)
    try {
      const updated = await Api.transferGroupOwner(gctx.ident, gctx.gid, uin)
      setGroup({ ...updated, id: group.id, host: group.host })
      setTransferFor(null)
      // Any panel of ours that belonged to the owner closes with the rights we
      // just gave away.
      setRightsFor(null)
      setHandedTo({ uin, name })
    } catch (e) {
      setTransferError(transferErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  /// One sentence for each way the island can refuse a handover, and the wait
  /// in seconds when it is a rate limit that carries one.
  function transferErrorText(e: unknown): string {
    if (e instanceof ApiError) {
      const code = parseErrorCode(e.body)
      if (code && TRANSFER_ERRORS[code]) return t(TRANSFER_ERRORS[code])
      if (e.status === 429 || code === 'rate_limited') {
        const wait = parseRetryAfter(e.body)
        return wait != null
          ? t('group.transfer.err.rate_limited_in', { s: String(wait) })
          : t('group.transfer.err.rate_limited')
      }
    }
    return t('group.transfer.err.failed')
  }

  /// Walk out of the group. Always a removal of MYSELF and never the owner's
  /// delete. The handover flow below leans on that: its "leave" button sits
  /// where "delete group" used to be for the same person seconds earlier, and
  /// one of those two destroys the room for everyone.
  async function leaveNow() {
    if (!gctx) return
    setBusy(true)
    try {
      await Api.removeGroupMember(gctx.ident, gctx.gid, myUinThere)
      navigate('/contacts', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  async function leaveOrDelete() {
    if (!group || !gctx) return
    if (!isOwner) {
      await leaveNow()
      return
    }
    setBusy(true)
    try {
      await Api.deleteGroup(gctx.ident, gctx.gid)
      navigate('/contacts', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-dim">
      {showAdd && group && gctx && (
        <AddMemberSheet
          group={group}
          ident={gctx.ident}
          gid={gctx.gid}
          host={gctx.host}
          onAdded={(g) => setGroup({ ...g, id: group.id, host: group.host })}
          onClose={() => setShowAdd(false)}
        />
      )}
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
              {/* The owner always came HERE from the chat, so a link back is
                  noise next to their gear (megalist B11). Members keep it. */}
              {!isOwner && (
                <Link to={`/chat/g/${group.id}`} className="text-sm text-accent font-semibold px-2">
                  {t('contacts.open_chat')}
                </Link>
              )}
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

        {!group && !error && <CenteredLoader label={t('contacts.loading')} />}

        {group && (
          <>
            <section className="bg-surface rounded-lg p-4 space-y-1 flex items-center gap-3">
              <GroupAvatar size={48} mediaId={group.avatar_media_id} mediaKey={group.avatar_media_key} />
              <div className="flex-1 min-w-0">
                <div className="font-bold text-lg truncate">{group.name}</div>
                <div className="text-xs text-fg-dim">
                  {t('section.groups.members', { n: compactCount(group.members.length) })}
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
                {roster.map((m) => {
                  const perms = m.permissions ?? []
                  const isTheOwner = m.uin === group.owner_uin
                  const isMe = m.uin === myUinThere
                  // The island refuses this call from anyone but the owner, and
                  // refuses the owner as a TARGET (400 "the owner already has
                  // every permission"), so both cases are hidden rather than
                  // offered and then rejected.
                  const canSetRights = isOwner && !isTheOwner && !isMe
                  const canRemove = canManageMembers && !isTheOwner && !isMe
                  const memberName = m.nickname || `${m.uin}`
                  return (
                  <li key={m.uin}>
                    <div className="relative">
                    <Link
                      to={m.uin === identity.uin ? '/profile' : `/profile/${m.uin}`}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-field"
                    >
                      {/* A member's picture rides with the roster, gated by
                          membership; without one this is the plain status icon,
                          so the screen is unchanged for everyone who never set
                          one. Presence stays on it as the badge, this being a
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
                          {m.nickname || `${m.uin}`}
                          {m.uin === identity.uin && (
                            <span className="text-fg-dim font-normal ml-1">
                              ({t('group.info.you')})
                            </span>
                          )}
                        </div>
                        {/* The moderator mark rides UNDER the nickname, not at
                            the right edge: the action buttons are absolutely
                            positioned over that edge and would sit on top of
                            it. The owner keeps the right-edge badge because the
                            owner row never carries buttons. */}
                        <div className="flex items-center gap-1.5">
                          <span className="text-[0.625rem] text-fg-dim">{m.uin}</span>
                          {!isTheOwner && perms.length > 0 && (
                            <span className="text-[0.625rem] font-semibold text-fg-secondary uppercase tracking-wider">
                              {t('group.info.moderator')}
                            </span>
                          )}
                        </div>
                      </div>
                      {isTheOwner && (
                        <span className="text-[0.625rem] font-bold text-accent uppercase tracking-wider">
                          {t('group.info.owner')}
                        </span>
                      )}
                    </Link>
                    {(canSetRights || canRemove) && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                        {canSetRights && (
                          <button
                            type="button"
                            disabled={busy}
                            aria-expanded={rightsFor === m.uin}
                            onClick={() => setRightsFor((v) => (v === m.uin ? null : m.uin))}
                            className="h-6 px-2 rounded-md bg-field text-[0.6875rem] font-medium text-fg-secondary hover:bg-line/60 disabled:opacity-40"
                          >
                            {t('group.rights.title')}
                          </button>
                        )}
                        {canRemove && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void removeMember(m.uin)}
                            className="h-6 px-2 rounded-md bg-field text-[0.6875rem] font-medium text-fg-secondary hover:bg-line/60 disabled:opacity-40"
                          >
                            {t('group.settings.remove_member')}
                          </button>
                        )}
                      </div>
                    )}
                    </div>
                    {canSetRights && rightsFor === m.uin && (
                      <div className="px-4 pb-3 pt-1 space-y-2 bg-field/40">
                        <p className="text-xs text-fg-secondary">{t('group.rights.hint')}</p>
                        <div className="space-y-1">
                          {GROUP_PERMS.map((perm) => (
                            <label key={perm} className="flex items-center gap-2 text-sm cursor-pointer">
                              <input
                                type="checkbox"
                                checked={perms.includes(perm)}
                                disabled={busy}
                                onChange={(e) =>
                                  void setMemberRights(
                                    m.uin,
                                    e.target.checked
                                      ? [...perms, perm]
                                      : perms.filter((x) => x !== perm),
                                  )
                                }
                                className="accent-accent"
                              />
                              <span>{t(`group.rights.${perm}`)}</span>
                            </label>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={busy || perms.length === GROUP_PERMS.length}
                            onClick={() => void setMemberRights(m.uin, [...GROUP_PERMS])}
                            className="flex-1 h-8 rounded-md bg-field text-xs font-medium hover:bg-line/50 disabled:opacity-40 transition-colors"
                          >
                            {t('group.rights.grant_all')}
                          </button>
                          <button
                            type="button"
                            disabled={busy || perms.length === 0}
                            onClick={() => void setMemberRights(m.uin, [])}
                            className="flex-1 h-8 rounded-md bg-field text-xs font-medium hover:bg-line/50 disabled:opacity-40 transition-colors"
                          >
                            {t('group.rights.revoke_all')}
                          </button>
                        </div>
                        <p className="text-xs text-fg-dim">{t('group.rights.owner_note')}</p>
                        {/* Handing the group over lives at the bottom of the
                            rights panel: it is the last and largest thing an
                            owner can give this person, and it belongs with the
                            rest of what they may do rather than as a third
                            button crowding the row. */}
                        <div className="pt-2 border-t border-line/60">
                          {transferFor !== m.uin ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setTransferError(null)
                                setTransferFor(m.uin)
                              }}
                              className="w-full h-8 rounded-md text-xs font-semibold text-red-600 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                            >
                              {t('group.transfer.title')}
                            </button>
                          ) : (
                            <div className="space-y-2 pt-1">
                              <p className="text-xs text-fg-secondary">
                                {t('group.transfer.confirm', { name: memberName })}
                              </p>
                              {transferError && (
                                <p className="text-xs text-red-600">{transferError}</p>
                              )}
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    setTransferFor(null)
                                    setTransferError(null)
                                  }}
                                  className="flex-1 h-8 rounded-md bg-field text-xs font-medium hover:bg-line/50 disabled:opacity-40 transition-colors"
                                >
                                  {t('common.cancel')}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void transferOwner(m.uin, memberName)}
                                  className="flex-1 h-8 rounded-md bg-red-600 hover:bg-red-700 text-white text-xs font-semibold disabled:opacity-40 transition-colors"
                                >
                                  {busy ? '…' : t('group.transfer.cta')}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                  )
                })}
              </ul>
              )}
              </>
              )}
            </section>

            {isMember && (
              <section className="bg-surface rounded-lg p-2">
                <button
                  onClick={() => setShowAdd(true)}
                  className="w-full h-11 rounded-md flex items-center justify-center gap-2 text-sm font-medium text-accent hover:bg-field transition-colors"
                >
                  <AddPersonIcon />
                  {t('group.add.title')}
                </button>
                {/* "Поделиться группой" (#578). It was reachable only from
                    inside the add-member sheet, which is the last place someone
                    looks for it: on the phones sharing a group is its own
                    action. The link is the phones' canonical one, host and all
                    — see groupShareLink. */}
                <button
                  onClick={() => void copyShareLink()}
                  className="w-full h-11 rounded-md flex items-center justify-center gap-2 text-sm font-medium text-accent hover:bg-field transition-colors"
                >
                  <LinkIcon />
                  {copied ? t('group.share.copied') : t('group.share.title')}
                </button>
                <p className="px-3 pb-1 pt-0.5 text-center text-xs text-fg-dim">
                  {t('group.share.hint')}
                </p>
              </section>
            )}

            {/* The second half of the handover, and deliberately NOT inside
                the rights panel it was started from: that panel is gated on
                being the owner, and on `members_hidden` the entire roster is
                gated on it too, so both unmount the instant the island answers.
                Handing the group over and then walking out is the migration
                this was built for, so the offer has to outlive the handover to be
                made at all. It sits right above leave/delete because that is
                where it leads. */}
            {handedTo && (
              <section className="bg-surface rounded-lg p-3 space-y-2">
                <p className="text-sm text-fg-secondary">
                  {t('group.transfer.done', { name: handedTo.name })}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setHandedTo(null)}
                    className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/50 disabled:opacity-40 transition-colors"
                  >
                    {t('group.transfer.stay')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void leaveNow()}
                    className="flex-1 h-9 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-semibold disabled:opacity-40 transition-colors"
                  >
                    {busy ? '…' : t('group.info.leave')}
                  </button>
                </div>
              </section>
            )}

            <section className="bg-surface rounded-lg p-2">
              {!confirmDestroy ? (
                <button
                  onClick={() => setConfirmDestroy(true)}
                  // Founder-picked reference: the "wipe everything" button on
                  // the storage screen — red text, translucent red hover, no
                  // solid pill in either theme.
                  className="w-full h-11 rounded-md flex items-center justify-center gap-2 text-sm font-semibold text-red-600 hover:bg-red-500/10 transition-colors"
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

function AddPersonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="22" y1="11" x2="16" y2="11" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
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
