// In-chat (and standalone) card for a group-invite link. Instead of a
// dead `https://rcq.app/g/<id>` URL in a bubble, we fetch the group
// preview and render name + member count + a Join/Open button that
// uses the in-app join flow (no round-trip to the landing page).
//
// Cross-island groups (federation §5c): a link can carry the group's
// HOST island (`/g/<id>@<host>`). Privacy rule: merely SEEING such a
// link must not touch the foreign island (auto-registering on every
// island whose link lands in a chat would let a sender map you across
// islands), so for an unvisited island we render a minimal "group on
// island X" card and only guest-register when the user taps Join.
//
// Used by Chat.tsx (an invite link in a message → this card) and by
// the JoinGroup page (the /g/:id route — someone opening the link
// directly on chat.rcq.app).

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Api, ApiError, parseErrorCode, type GroupPreview } from '../lib/api'
import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'
import { hostOfApiBase } from '../lib/multihome'
import { aliasFor, ensureGuestAuth, ensureGuestOn } from '../lib/visited-islands'
import { GroupAvatar } from './GroupAvatar'
import { compactCount } from '../lib/format-count'

// Per-account cache of "which groups am I in", so the card can show
// Open vs Join without a fetch per render. Keyed by the identity uin
// for local groups and by `uin@host` for foreign islands. Populated
// lazily on first card mount; a stale entry here only ever mislabels
// the button (the join call itself is idempotent).
const _myGroupIds = new Map<string, Set<number>>()

async function loadMyGroupIds(
  identity: Parameters<typeof Api.groups>[0],
  cacheKey: string,
): Promise<Set<number>> {
  const cached = _myGroupIds.get(cacheKey)
  if (cached) return cached
  // Ids only — no reason to pay for every roster to answer "am I in it".
  const groups = await Api.groups(identity, false)
  const ids = new Set(groups.map((g) => g.id))
  _myGroupIds.set(cacheKey, ids)
  return ids
}

interface Props {
  groupId: number
  /// The group's host island from the invite link; null/undefined or own
  /// island = a local group (legacy links).
  host?: string | null
  /// Slim one-line row instead of the card. For places that list links rather
  /// than deliver one — the group's pinned message, where three invites drawn
  /// as three 110px cards with their own Join buttons filled the screen
  /// ("отображается горизонтально и слишком крупно"). The phones use exactly
  /// this shape there. The whole row is the action: open it if you are in it,
  /// join it if you are not.
  compact?: boolean
  /// Keep the card's top-right corner clear: in a chat thread the bubble's
  /// ⋯ handle is pinned there, and the group name is `truncate`, so without
  /// the gap the handle would land on the tail of the name.
  menuSpace?: boolean
}

export function GroupJoinCard({ groupId, host, compact = false, menuSpace = false }: Props) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()

  // Foreign = the link names an island that isn't ours.
  const foreignHost = identity && host && host !== hostOfApiBase(identity.apiBase) ? host : null

  const [preview, setPreview] = useState<GroupPreview | null>(null)
  const [isMember, setIsMember] = useState(false)
  const [loading, setLoading] = useState(true)
  // Foreign island we have never visited: no preview available (we refuse to
  // touch the island before the user taps Join) — render the minimal card.
  const [unvisited, setUnvisited] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!identity) return
    let alive = true
    setLoading(true)
    setLoadError(null)
    setUnvisited(false)
    void (async () => {
      try {
        const ident = foreignHost ? await ensureGuestAuth(identity, foreignHost) : identity
        if (!ident) {
          // Never visited this island — minimal card, no network.
          if (alive) setUnvisited(true)
          return
        }
        const cacheKey = foreignHost ? `${identity.uin}@${foreignHost}` : `${identity.uin}`
        const [p, ids] = await Promise.all([
          Api.groupPreview(ident, groupId),
          loadMyGroupIds(ident, cacheKey).catch(() => new Set<number>()),
        ])
        if (!alive) return
        setPreview(p)
        setIsMember(ids.has(groupId))
      } catch (e) {
        if (!alive) return
        setLoadError(
          e instanceof ApiError && e.status === 404
            ? t('group_join.gone')
            : t('group_join.error.generic'),
        )
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.uin, groupId, foreignHost])

  function chatPath(): string {
    return foreignHost ? `/chat/g/${aliasFor(foreignHost, groupId)}` : `/chat/g/${groupId}`
  }

  async function join() {
    if (!identity || joining) return
    setJoining(true)
    setActionError(null)
    try {
      let ident = identity
      if (foreignHost) {
        // First touch of the island happens HERE, on the explicit Join tap:
        // recover-first guest registration with our own keys.
        await ensureGuestOn(identity, foreignHost)
        const guest = await ensureGuestAuth(identity, foreignHost)
        if (!guest) throw new Error('guest registration failed')
        ident = guest
      }
      await Api.joinGroup(ident, groupId)
      const cacheKey = foreignHost ? `${identity.uin}@${foreignHost}` : `${identity.uin}`
      _myGroupIds.get(cacheKey)?.add(groupId)
      navigate(chatPath())
    } catch (e) {
      let msg = t('group_join.error.generic')
      if (e instanceof ApiError) {
        const code = parseErrorCode(e.body)
        if (code === 'group_closed') msg = t('group_join.closed_hint')
        else if (code === 'blocked') msg = t('group_join.error.blocked')
        else if (e.status === 404) msg = t('group_join.gone')
      }
      setActionError(msg)
    } finally {
      setJoining(false)
    }
  }

  // ---- render -------------------------------------------------------

  // Unvisited foreign island: name + members unknown by design. Offer Join;
  // everything resolves after the guest registration.
  if (unvisited && foreignHost) {
    return (
      <div className="w-64 max-w-full rounded-xl bg-surface p-3">
        <div className="flex items-center gap-3">
          <GroupAvatar size={40} />
          <div className={`min-w-0 flex-1${menuSpace ? ' pr-7' : ''}`}>
            <div className="truncate text-sm font-medium">{t('group_join.island_title')}</div>
            <div className="truncate text-[0.6875rem] text-fg-dim">{foreignHost}</div>
          </div>
        </div>
        <div className="mt-3">
          <button
            onClick={() => void join()}
            disabled={joining}
            className="w-full rounded-full bg-accent py-2 text-xs font-medium text-white hover:bg-accent-dim transition-colors disabled:opacity-50"
          >
            {joining ? t('group_join.joining') : t('group_join.button')}
          </button>
        </div>
        <div className="mt-2 text-[0.625rem] text-fg-dim">{t('group_join.island_hint')}</div>
        {actionError && <div className="mt-2 text-[0.625rem] text-red-500">{actionError}</div>}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="w-64 max-w-full rounded-xl bg-surface px-4 py-3">
        <div className="text-xs text-fg-dim">{t('group_join.loading')}</div>
      </div>
    )
  }
  if (loadError || !preview) {
    return (
      <div className="w-64 max-w-full rounded-xl bg-surface px-4 py-3">
        <div className="text-xs text-fg-dim">{loadError ?? t('group_join.error.generic')}</div>
      </div>
    )
  }

  const closedToMe = preview.is_closed && !isMember

  if (compact) {
    return (
      <>
        <button
          type="button"
          disabled={joining || closedToMe}
          onClick={() => (isMember ? navigate(chatPath()) : void join())}
          className="w-full flex items-center gap-2.5 rounded-xl bg-field px-2.5 py-2 text-left transition-colors hover:bg-line/40 disabled:opacity-60"
        >
          <GroupAvatar size={36} mediaId={preview.avatar_media_id} mediaKey={preview.avatar_media_key} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.8125rem] font-medium">{preview.name}</span>
            <span className="block truncate text-[0.6875rem] text-fg-dim">
              {closedToMe
                ? t('group_join.closed_button')
                : t('section.groups.members', { n: compactCount(preview.member_count) })}
              {foreignHost ? ` · ${foreignHost}` : ''}
            </span>
          </span>
          <span className="flex-none text-fg-dim">›</span>
        </button>
        {actionError && <div className="mt-1 text-[0.625rem] text-red-500">{actionError}</div>}
      </>
    )
  }

  return (
    <div className="w-64 max-w-full rounded-xl bg-surface p-3">
      <div className="flex items-center gap-3">
        <GroupAvatar size={40} mediaId={preview.avatar_media_id} mediaKey={preview.avatar_media_key} />
        <div className={`min-w-0 flex-1${menuSpace ? ' pr-7' : ''}`}>
          <div className="truncate text-sm font-medium">{preview.name}</div>
          <div className="truncate text-[0.6875rem] text-fg-dim">
            {t('section.groups.members', { n: compactCount(preview.member_count) })}
            {preview.owner_nickname ? ` · ${t('group_join.owner', { name: preview.owner_nickname })}` : ''}
          </div>
          {foreignHost && (
            <div className="truncate text-[0.625rem] text-fg-dim">{foreignHost}</div>
          )}
        </div>
      </div>

      <div className="mt-3">
        {isMember ? (
          <button
            onClick={() => navigate(chatPath())}
            className="w-full rounded-full bg-field py-2 text-xs font-medium hover:bg-line transition-colors"
          >
            {t('group_join.open_button')}
          </button>
        ) : closedToMe ? (
          <button
            disabled
            className="w-full rounded-full bg-field py-2 text-xs font-medium text-fg-dim cursor-not-allowed"
          >
            {t('group_join.closed_button')}
          </button>
        ) : (
          <button
            onClick={() => void join()}
            disabled={joining}
            className="w-full rounded-full bg-accent py-2 text-xs font-medium text-white hover:bg-accent-dim transition-colors disabled:opacity-50"
          >
            {joining ? t('group_join.joining') : t('group_join.button')}
          </button>
        )}
      </div>

      {closedToMe && (
        <div className="mt-2 text-[0.625rem] text-fg-dim">{t('group_join.closed_hint')}</div>
      )}
      {actionError && (
        <div className="mt-2 text-[0.625rem] text-red-500">{actionError}</div>
      )}
    </div>
  )
}
