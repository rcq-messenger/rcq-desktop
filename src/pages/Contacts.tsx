// Contact list — sectioned by role (Favorites / Groups / Online /
// Offline / Archive). Each section is collapsible; the user's
// preference persists in localStorage. Per-row trailing has two
// buttons: open chat + open the action menu (favorite / mute /
// archive / block / remove). Live presence + contact-graph deltas
// arrive via WS; favorites/archive/mute live entirely in
// localStorage on this device.

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { BypassShield } from '../components/BypassShield'
import { ContactActionsMenu } from '../components/ContactActionsMenu'
import { GroupActionsMenu } from '../components/GroupActionsMenu'
import { CreateGroupSheet } from '../components/CreateGroupSheet'
import { GroupAvatar } from '../components/GroupAvatar'
import { UpdateBadge } from '../components/UpdateBadge'
import { RequestsModal } from '../components/RequestsModal'
import { AddContactModal } from '../components/AddContactModal'
import { NewsButton } from '../components/NewsPopover'
import { PersonAvatar } from '../components/PersonAvatar'
import { StatusPickerButton } from '../components/StatusPicker'
import { ThemeToggle } from '../components/ThemeToggle'
import {
  Api,
  type Contact,
  type PendingRequest,
  type RCQGroup,
  type UserInfo,
  type UserStatus,
} from '../lib/api'
import { contactsCache, persistSnapshot, restoreSnapshot } from '../lib/contacts-cache'
import { memberCount } from '../lib/group-roster'
import { usePeerUnread, useGroupUnread, useTotalUnread, peerUnreadCount, groupUnreadCount } from '../lib/incoming-store'
import { useHasMention } from '../lib/mentions'
import { useI18n } from '../lib/i18n-context'
import { lockNow } from '../lib/pin-gate'
import { vaultState, vaultSupported } from '../lib/desktop-vault'
import { useIdentity } from '../lib/identity-context'
import {
  useArchive,
  useArchiveGroups,
  useCollapsedSections,
  useContactAliases,
  useFavorites,
  useFavoriteGroups,
  useMutedGroups,
  useMutedPeers,
} from '../lib/local-store'
import { isPresenceSoundEnabled, playSound } from '../lib/sounds'
import { useWS } from '../lib/ws'
import { listCrossIsland, type CrossIslandContact } from '../lib/crossisland-store'
import {
  ensureRequestsLoaded,
  isBlocked,
  onRequestsChanged,
  requestCount,
} from '../lib/crossisland-requests'
import { CrossIslandActionsMenu } from '../components/CrossIslandActionsMenu'
import { aliasFor, guestIdentityFor, listVisitedIslands, refreshGuestAuth } from '../lib/visited-islands'

/// Cross-island groups (§5c): groups we joined on OTHER islands, fetched with
/// the per-island guest credentials. Ids are rewritten to the local alias at
/// this boundary so every downstream consumer (unread, routes, stores) keeps
/// working on plain numbers. Per-island failures degrade to "no groups from
/// that island" — never block the primary list. A 401 means the guest jwt
/// expired: re-prove the key (recover) once and retry.
async function fetchForeignGroups(identity: Parameters<typeof Api.groups>[0]): Promise<RCQGroup[]> {
  const islands = listVisitedIslands()
  if (islands.length === 0) return []
  const per = await Promise.all(
    islands.map(async (v) => {
      try {
        let guest = guestIdentityFor(identity, v.host)
        if (!guest) return []
        let gs: RCQGroup[]
        try {
          gs = await Api.groups(guest)
        } catch (e) {
          if (!(e instanceof Error && 'status' in e && (e as { status: number }).status === 401)) throw e
          if (!(await refreshGuestAuth(identity, v.host))) return []
          guest = guestIdentityFor(identity, v.host)
          if (!guest) return []
          gs = await Api.groups(guest)
        }
        return gs.map((g) => ({ ...g, id: aliasFor(v.host, g.id), host: v.host }))
      } catch {
        return []
      }
    }),
  )
  return per.flat()
}

// Module-level cache of the contact-list data, keyed by UIN. The route
// component remounts on every navigation back to /contacts; without this it
// re-showed a loading spinner + re-fetched 4 endpoints each time. With it, a
// return paints the last-known list INSTANTLY and refreshes silently in the
// background.
export {
  lookupContactName,
  lookupContactStatus,
  lookupContactAvatar,
  lookupGroupName,
  lookupGroupAvatar,
} from '../lib/contacts-cache'

export function Contacts() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const ws = useWS()
  const navigate = useNavigate()

  // Lazy-init from the module cache so RETURNING to the list paints the
  // last-known contacts on the FIRST render — no "Загружаем" spinner flash
  // between the initial (empty) render and the effect that reads the cache.
  // A silent background refresh still runs to pick up changes in place.
  if (identity) restoreSnapshot(identity.uin)
  const _cachedAtMount = identity ? contactsCache.get(identity.uin) : undefined
  const [contacts, setContacts] = useState<Contact[]>(() => _cachedAtMount?.contacts ?? [])
  const [groups, setGroups] = useState<RCQGroup[]>(() => _cachedAtMount?.groups ?? [])
  const [pending, setPending] = useState<PendingRequest[]>(() => _cachedAtMount?.pending ?? [])
  const [me, setMe] = useState<UserInfo | null>(() => _cachedAtMount?.me ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => !_cachedAtMount)
  // Cross-island requests are sealed at rest, so the store opens asynchronously
  // and the count has to be watched rather than read during a render.
  const [ciCount, setCiCount] = useState(() => requestCount())
  useEffect(() => {
    const off = onRequestsChanged(() => setCiCount(requestCount()))
    void ensureRequestsLoaded().then(() => setCiCount(requestCount()))
    return off
  }, [])
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [showRequests, setShowRequests] = useState(false)
  const [showAdd, setShowAdd] = useState(false)

  const favorites = useFavorites()
  const archive = useArchive()
  const muted = useMutedPeers()
  const favoriteGroups = useFavoriteGroups()
  const archiveGroups = useArchiveGroups()
  const collapsed = useCollapsedSections()
  // My own names for people. Read up here with the other hooks — the cross-
  // island section that uses it sits below an early return, and a hook called
  // there would be a hook called conditionally. Renamed on import because
  // `aliasFor` at module scope is the visited-islands GROUP alias, a different
  // thing entirely.
  const { aliasFor: ciAliasFor } = useContactAliases()
  // Subscribe to unread changes so the list re-sorts (unread-first) + the
  // section counts update when a message arrives. (Value itself unused here.)
  useTotalUnread()

  async function refresh(background = false) {
    if (!identity) return
    setError(null)
    if (!background) setLoading(true)
    try {
      const [list, pendingList, myInfo, groupList, foreignGroups] = await Promise.all([
        Api.contacts(identity),
        Api.pendingRequests(identity),
        Api.myInfo(identity),
        // Without the roster: a chat-list row wants a name, a picture and a
        // count, and the roster is the expensive half — every member with two
        // base64 keys, which on the beta group is a couple of hundred
        // kilobytes on the boot path, on every poll. Whoever needs the real
        // roster (the chat, the group screen, a forward) fetches it per group.
        Api.groups(identity, false),
        // Foreign islands keep answering with their rosters: a cross-island
        // group's members come from its own island and nothing here can ask
        // for them by the local alias id.
        fetchForeignGroups(identity),
      ])
      const allGroups = [...groupList, ...foreignGroups]
      setContacts(list)
      setPending(pendingList)
      setMe(myInfo)
      setGroups(allGroups)
      persistSnapshot(identity.uin, { contacts: list, groups: allGroups, pending: pendingList, me: myInfo })
    } catch (e) {
      // On a background refresh keep the cached view; only surface errors on a cold load.
      if (!background) setError(e instanceof Error ? e.message : t('contacts.error'))
    } finally {
      if (!background) setLoading(false)
    }
  }

  useEffect(() => {
    if (!identity) return
    const cached = contactsCache.get(identity.uin)
    if (cached) {
      // Instant paint from cache, then refresh silently.
      setContacts(cached.contacts)
      setGroups(cached.groups)
      setPending(cached.pending)
      setMe(cached.me)
      setLoading(false)
      void refresh(true)
    } else {
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.uin])

  useEffect(() => {
    const offPresence = ws.on('presence', (ev) => {
      const u = ev.uin as number | undefined
      const s = ev.status as UserStatus | undefined
      if (typeof u !== 'number' || typeof s !== 'string') return
      setContacts((prev) => {
        const before = prev.find((c) => c.uin === u)
        if (before && !muted.has(u) && isPresenceSoundEnabled()) {
          // Treat away/dnd as "around" so an offline→away transition still
          // chimes like a come-online (matches the section bucketing).
          const around = (st: UserStatus) => st === 'online' || st === 'away' || st === 'dnd'
          const wasAround = around(before.status)
          const isAround = around(s)
          if (!wasAround && isAround) playSound('contact_online')
          else if (wasAround && !isAround) playSound('contact_offline')
        }
        return prev.map((c) =>
          c.uin === u
            ? { ...c, status: s, status_message: (ev.status_message as string | undefined) ?? c.status_message }
            : c,
        )
      })
    })
    const offResponse = ws.on('contact_response', () => void refresh(true))
    const offRequest = ws.on('contact_request', () => {
      if (!identity) return
      Api.pendingRequests(identity).then(setPending).catch(() => {})
    })
    return () => {
      offPresence()
      offResponse()
      offRequest()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.uin, muted])

  // Reflect our OWN status as online once the socket is up. The backend
  // heals a default "offline" → "online" in `_on_connect`, but a fresh
  // login fetches /myInfo BEFORE that connect runs, so the picker showed
  // the stale offline state until a reload. Flip it locally on connect
  // (only when it's the unset "offline" default — a user-chosen
  // away/dnd/invisible is left alone). Also keep the cache in step.
  useEffect(() => {
    if (!ws.connected || !identity) return
    setMe((prev) => {
      if (!prev || prev.status !== 'offline') return prev
      const updated = { ...prev, status: 'online' as UserStatus }
      const cached = contactsCache.get(identity.uin)
      if (cached) persistSnapshot(identity.uin, { ...cached, me: updated })
      return updated
    })
    // If the user added their OWN UIN as a contact, that row never gets a
    // presence event (you don't watch yourself) so it sat at offline. Heal
    // it to online on connect, mirroring the server's own heal.
    setContacts((prev) =>
      prev.some((c) => c.uin === identity.uin && c.status !== 'online')
        ? prev.map((c) => (c.uin === identity.uin ? { ...c, status: 'online' as UserStatus } : c))
        : prev,
    )
  }, [ws.connected, identity?.uin])

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  // Bucket contacts. A contact lives in exactly one bucket at a
  // time; archive wins over favorite which wins over status. iOS
  // does the same — sees the user's most-recent intent.
  const archived: Contact[] = []
  const fav: Contact[] = []
  const online: Contact[] = []
  const offline: Contact[] = []
  // Any "present" status counts as around → online section. Previously
  // only 'online' did, so away/dnd users wrongly fell into Offline.
  // (invisible already reports as offline from the server.)
  const isAround = (s: UserStatus) => s === 'online' || s === 'away' || s === 'dnd'
  for (const c of contacts) {
    if (archive.has(c.uin)) archived.push(c)
    else if (favorites.has(c.uin)) fav.push(c)
    else if (isAround(c.status)) online.push(c)
    else offline.push(c)
  }
  // Bucket groups the same way (separate fav/archive sets so a group id can't
  // collide with a contact UIN): archived groups leave the Groups list and join
  // the bottom Archive section; favorited groups float to the top Favorites.
  const favGroups: RCQGroup[] = []
  const archivedGroups: RCQGroup[] = []
  const normalGroups: RCQGroup[] = []
  for (const g of groups) {
    if (archiveGroups.has(g.id)) archivedGroups.push(g)
    else if (favoriteGroups.has(g.id)) favGroups.push(g)
    else normalGroups.push(g)
  }
  const sortByNick = (a: Contact, b: Contact) => a.nickname.localeCompare(b.nickname)
  // Unread-first: a contact who messaged you floats to the top of its section
  // (so the offline contact who wrote while away is right at the top — founder
  // ask), then alphabetical. Same for groups by name.
  const byUnreadThenNick = (a: Contact, b: Contact) =>
    (peerUnreadCount(b.uin) > 0 ? 1 : 0) - (peerUnreadCount(a.uin) > 0 ? 1 : 0) || sortByNick(a, b)
  const groupByUnreadThenName = (a: RCQGroup, b: RCQGroup) =>
    (groupUnreadCount(b.id) > 0 ? 1 : 0) - (groupUnreadCount(a.id) > 0 ? 1 : 0) ||
    a.name.localeCompare(b.name)
  fav.sort(byUnreadThenNick)
  online.sort(byUnreadThenNick)
  offline.sort(byUnreadThenNick)
  archived.sort(sortByNick)
  favGroups.sort(groupByUnreadThenName)
  normalGroups.sort(groupByUnreadThenName)
  // Sum unread per section so the section header can show "N unread".
  const sectionUnread = (cs: Contact[]) => cs.reduce((n, c) => n + (peerUnreadCount(c.uin) > 0 ? 1 : 0), 0)
  const groupSectionUnread = (gs: RCQGroup[]) => gs.reduce((n, g) => n + (groupUnreadCount(g.id) > 0 ? 1 : 0), 0)
  // Federation (F2): cross-island contacts (peers on other islands, stored
  // locally) — recomputed on each remount (navigating back here re-reads them).
  const crossIsland = listCrossIsland()

  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="rcq-header sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-3 h-14 flex items-center gap-2">
          {me && (
            <>
              <StatusPickerButton
                current={me.status}
                onChange={(s) => setMe({ ...me, status: s })}
                avatarMediaId={me.avatar_media_id}
                avatarMediaKey={me.avatar_media_key}
              />
              <Link
                to="/profile"
                className="flex flex-col leading-tight min-w-0 hover:opacity-80 transition-opacity"
              >
                <span className="font-semibold text-sm truncate">
                  {me.nickname || `#${me.uin}`}
                </span>
                <span className="font-mono text-[0.625rem] text-fg-dim">#{me.uin}</span>
              </Link>
              {/* Desktop only, and only while a relay is actually carrying us. */}
              <BypassShield />
            </>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            {/* Desktop only, and only while there IS one: an update the app
                has already found, waiting for a moment that suits you. It sits
                first so that the icons keep their places when it appears —
                inserted mid-row it used to shove half of them sideways. */}
            <UpdateBadge className="mr-1" />
            {/* Windows, not detours. Both of these used to be full-page routes
                that took the whole desktop window away from the list you were
                reading and had to be navigated back out of. The routes stay
                alive for deep links and for a phone-sized screen. */}
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-field"
              title={t('contacts.add')}
              aria-label={t('contacts.add')}
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              onClick={() => setShowRequests(true)}
              className="relative text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface-dim"
              title={t('pending.title')}
              aria-label={t('pending.title')}
            >
              <BellIcon />
              {pending.length + ciCount > 0 && (
                <span className="absolute top-0.5 right-0.5 min-w-[1rem] h-[1rem] px-1 rounded-full bg-red-500 text-white text-[0.625rem] font-bold flex items-center justify-center">
                  {pending.length + ciCount}
                </span>
              )}
            </button>
            {/* The market moved out of the header: it is already a row in
                Settings, so this was the same door twice, and the header had no
                door at all to the one thing that is genuinely new — the
                operator's announcements. */}
            {/* Audio rooms: the phones have had them since 0.9x and the web
                had no door at all, which made a room half a product. */}
            <Link
              to="/rooms"
              className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface-dim"
              title={t('rooms.title')}
              aria-label={t('rooms.title')}
            >
              <MicIcon />
            </Link>
            <NewsButton className="relative text-fg-secondary hover:text-fg-primary p-2 rounded-md" />
            <LockNowButton />
            <ThemeToggle className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface-dim transition-colors" />
            <Link
              to="/settings"
              className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface-dim"
              title={t('contacts.settings')}
              aria-label={t('contacts.settings')}
            >
              <CogIcon />
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        {loading && contacts.length === 0 && (
          <div className="text-center text-sm text-fg-secondary py-12">{t('contacts.loading')}</div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-600 mb-4">
            {error}
            <button onClick={() => void refresh()} className="ml-3 underline">{t('common.retry')}</button>
          </div>
        )}

        {!loading && contacts.length === 0 && !error && (
          <div className="text-center text-sm text-fg-secondary py-12 space-y-2">
            <div>{t('contacts.empty')}</div>
            <Link
              to="/add"
              className="inline-block mt-3 px-4 h-10 leading-10 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold transition-colors"
            >
              {t('contacts.add')}
            </Link>
          </div>
        )}

        {/* Saved Messages («Заметки») — your own UIN as a notes-to-self thread.
            Always on top, like the native apps. The server never lists your
            own UIN in /contacts, so this is the only entry point. */}
        {me && (
          <ul className="bg-surface rounded-lg [&_li:first-child>*]:rounded-t-lg [&_li:last-child>*]:rounded-b-lg">
            <li>
              <Link
                to={`/chat/${me.uin}`}
                className="flex items-center gap-3 px-4 py-3 lg:py-2 hover:bg-field transition-colors"
              >
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-accent/15 text-accent">
                  <BookmarkGlyph />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{t('contacts.saved')}</div>
                  <div className="text-xs text-fg-dim truncate">{t('contacts.saved.subtitle')}</div>
                </div>
              </Link>
            </li>
          </ul>
        )}

        {fav.length + favGroups.length > 0 && (
          <Section
            id="fav"
            title={t('section.favorites')}
            count={fav.length + favGroups.length}
            collapsed={collapsed}
          >
            {favGroups.map((g) => (
              <GroupRow key={`g${g.id}`} group={g} onChanged={refresh} />
            ))}
            {fav.map((c) => (
              <ContactRow
                key={c.uin}
                contact={c}
                muted={muted.has(c.uin)}
                favorite
                onChanged={refresh}
              />
            ))}
          </Section>
        )}

        {crossIsland.length > 0 && (
          <Section id="crossisland" title="Cross-island" count={crossIsland.length} collapsed={collapsed}>
            {crossIsland.map((ci) => (
              <CrossIslandRow key={`${ci.uin}@${ci.host}`} ci={ci} aliasFor={ciAliasFor} onChanged={() => refresh(true)} />
            ))}
          </Section>
        )}

        <Section
          id="groups"
          title={t('section.groups')}
          count={normalGroups.length}
          unread={groupSectionUnread(normalGroups)}
          collapsed={collapsed}
          rightAction={
            <button
              onClick={() => setShowCreateGroup(true)}
              className="text-xs text-accent hover:text-accent-dim font-semibold px-2 py-1"
            >
              {t('section.groups.create')}
            </button>
          }
        >
          {normalGroups.length === 0 ? (
            <li className="px-4 py-3 lg:py-2 text-xs text-fg-dim">{t('section.groups.empty')}</li>
          ) : (
            normalGroups.map((g) => <GroupRow key={g.id} group={g} onChanged={refresh} />)
          )}
        </Section>

        {online.length > 0 && (
          <Section
            id="online"
            title={t('section.online')}
            count={online.length}
            unread={sectionUnread(online)}
            collapsed={collapsed}
          >
            {online.map((c) => (
              <ContactRow
                key={c.uin}
                contact={c}
                muted={muted.has(c.uin)}
                onChanged={refresh}
              />
            ))}
          </Section>
        )}

        {offline.length > 0 && (
          <Section
            id="offline"
            title={t('section.offline')}
            count={offline.length}
            unread={sectionUnread(offline)}
            collapsed={collapsed}
          >
            {offline.map((c) => (
              <ContactRow
                key={c.uin}
                contact={c}
                muted={muted.has(c.uin)}
                onChanged={refresh}
              />
            ))}
          </Section>
        )}

        {archived.length + archivedGroups.length > 0 && (
          <Section
            id="archive"
            title={t('section.archive')}
            count={archived.length + archivedGroups.length}
            collapsed={collapsed}
            collapsedByDefault
          >
            {archivedGroups.map((g) => (
              <GroupRow key={`g${g.id}`} group={g} onChanged={refresh} />
            ))}
            {archived.map((c) => (
              <ContactRow
                key={c.uin}
                contact={c}
                muted={muted.has(c.uin)}
                archived
                onChanged={refresh}
              />
            ))}
          </Section>
        )}
      </main>

      {showRequests && (
        <RequestsModal
          incomingCount={pending.length + ciCount}
          onClose={() => {
            setShowRequests(false)
            void refresh()
          }}
        />
      )}
      {showAdd && <AddContactModal onClose={() => setShowAdd(false)} />}
      {showCreateGroup && (
        <CreateGroupSheet
          contacts={contacts}
          onClose={() => setShowCreateGroup(false)}
          onCreated={() => {
            setShowCreateGroup(false)
            void refresh()
          }}
        />
      )}
    </div>
  )
}

// -----------------------------------------------------------
// Section wrapper with collapsible header
// -----------------------------------------------------------

function Section({
  id,
  title,
  count,
  unread = 0,
  children,
  collapsed,
  collapsedByDefault,
  rightAction,
}: {
  id: string
  title: string
  count: number
  unread?: number
  children: React.ReactNode
  collapsed: { has: (id: string) => boolean; toggle: (id: string) => void }
  collapsedByDefault?: boolean
  rightAction?: React.ReactNode
}) {
  // The collapsed-set tracks user-toggled state; for sections that
  // start collapsed (Archive), we invert: the absence of the id
  // in the set means "use default" → render collapsed.
  const userToggled = collapsed.has(id)
  const isCollapsed = collapsedByDefault ? !userToggled : userToggled

  return (
    <section>
      <div className="flex items-center justify-between mb-1.5 px-2">
        <button
          onClick={() => collapsed.toggle(id)}
          className="flex items-center gap-1.5 text-xs font-bold text-fg-secondary uppercase tracking-wider hover:text-fg-primary"
        >
          <span className="text-fg-dim">{isCollapsed ? '▸' : '▾'}</span>
          {title}
          <span className="text-fg-dim font-mono">·{count}</span>
          {unread > 0 && (
            <span className="ml-1 inline-flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full bg-red-500 text-white text-[0.625rem] font-bold tracking-normal">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
        {rightAction}
      </div>
      {/* NOT overflow-hidden — that clipped the absolutely-positioned contact
          action menu (the three-dots dropdown). So round the element that
          PAINTS the hover instead. It used to say `li:first-child a`, and a
          contact row paints its hover on a wrapper div with the anchor inside,
          so the corner was rounded on a child of the square that was covering
          it: hovering the first or last row visibly cut the list's corner.
          `> *` takes whatever the row leads with, div or anchor. */}
      {!isCollapsed && (
        <ul className="bg-surface rounded-lg [&_li:first-child>*]:rounded-t-lg [&_li:last-child>*]:rounded-b-lg">
          {children}
        </ul>
      )}
    </section>
  )
}

// -----------------------------------------------------------
// Contact row — status icon + name + status message + chat /
// "more" trailing buttons. Action menu pops up under the more
// button on tap.
// -----------------------------------------------------------

function ContactRow({
  contact,
  muted,
  favorite,
  archived,
  onChanged,
}: {
  contact: Contact
  muted: boolean
  favorite?: boolean
  archived?: boolean
  onChanged: () => void
}) {
  const { t } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const unread = usePeerUnread(contact.uin)
  // My own name for this person wins over the nickname they chose. Device-only
  // (see useContactAliases).
  const { aliasFor } = useContactAliases()
  const alias = aliasFor(contact.uin)
  return (
    <li className="relative">
      <div className={'flex items-center gap-3 px-4 py-3 lg:py-2 ' + (archived ? 'opacity-60' : '')}>
        {/* Tapping the card opens the CHAT (the primary action). The
            profile is a dedicated button below. */}
        <Link
          to={`/chat/${contact.uin}`}
          className="flex items-center gap-3 flex-1 min-w-0"
          aria-label={t('contacts.open_chat')}
        >
          <PersonAvatar
            status={contact.status}
            size={28}
            mediaId={contact.avatar_media_id}
            mediaKey={contact.avatar_media_key}
            crossIsland={!!contact.host}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={'truncate ' + (unread > 0 ? 'font-bold' : 'font-medium')}>
                {alias || contact.nickname || `#${contact.uin}`}
              </span>
              <GenderIcon gender={contact.gender} />
              {favorite && <span className="text-yellow-500 text-xs flex-none">★</span>}
              {muted && <MuteGlyph />}
              {contact.blocked && <BlockedIcon />}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-fg-dim min-w-0">
              <span className="font-mono flex-none">#{contact.uin}</span>
              {contact.status_message && (
                <span className="truncate">· {contact.status_message}</span>
              )}
            </div>
          </div>
        </Link>
        {unread > 0 && <UnreadBadge n={unread} />}
        <Link
          to={`/profile/${contact.uin}`}
          className="text-fg-secondary hover:text-accent p-2 rounded-md hover:bg-surface"
          title={t('contacts.open_profile')}
          aria-label={t('contacts.open_profile')}
        >
          <PersonIcon />
        </Link>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface"
          aria-label={t('contacts.more')}
          title={t('contacts.more')}
        >
          <MoreIcon />
        </button>
      </div>
      {menuOpen && (
        <ContactActionsMenu
          contact={contact}
          onClose={() => setMenuOpen(false)}
          onChanged={onChanged}
        />
      )}
    </li>
  )
}

/// A contact who lives on another island. Its own component because it now has
/// a menu, and because the actions it can offer are NOT the local set — see
/// CrossIslandActionsMenu for why favourite/mute/archive are missing.
function CrossIslandRow({
  ci,
  aliasFor,
  onChanged,
}: {
  ci: CrossIslandContact
  aliasFor: (uin: number, host?: string | null) => string | undefined
  onChanged: () => void
}) {
  const { t } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const blocked = isBlocked(ci.uin, ci.host)
  return (
    <li className="relative">
      <div className={'flex items-center gap-3 px-4 py-3 lg:py-2 hover:bg-field transition-colors ' + (blocked ? 'opacity-60' : '')}>
        <Link to={`/chat/${ci.uin}?i=${encodeURIComponent(ci.host)}`} className="flex items-center gap-3 flex-1 min-w-0">
          {/* The same greyed flower every other cross-island row uses
              (StatusIcon's `crossIsland`), not a globe emoji: presence
              does not cross islands, so the icon says "person, status
              unknown" exactly like it does further down the list.
              §5e gives these rows a picture when the peer has deposited
              one — the flower stays gray behind it. */}
          <PersonAvatar
            status="offline"
            size={20}
            crossIsland
            mediaId={ci.avatarMediaId}
            mediaKey={ci.avatarMediaKey}
          />
          <div className="flex-1 min-w-0">
            {/* My own name for them beats the one they push. §5e is a
                self-asserted name; an alias is a decision the user made
                on this device, and it has to survive their next rename. */}
            <div className="truncate font-medium">
              {aliasFor(ci.uin, ci.host) || ci.nickname || `${ci.uin}@${ci.host}`}
            </div>
            <div className="text-xs text-fg-dim font-mono truncate">
              #{ci.uin} · {ci.host}
            </div>
          </div>
        </Link>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface"
          title={t('contacts.more')}
          aria-label={t('contacts.more')}
        >
          <MoreIcon />
        </button>
      </div>
      {menuOpen && (
        <CrossIslandActionsMenu
          contact={ci}
          onClose={() => setMenuOpen(false)}
          onChanged={onChanged}
        />
      )}
    </li>
  )
}

function GroupRow({ group, onChanged }: { group: RCQGroup; onChanged: () => void }) {
  const { t } = useI18n()
  const unread = useGroupUnread(group.id)
  // Someone called your name here while you were elsewhere. Separate from the
  // unread count on purpose: forty unread messages in a busy group is noise,
  // one of them addressed to you is not, and only the @ tells them apart.
  const mentioned = useHasMention(group.id)
  const muted = useMutedGroups()
  const favorites = useFavoriteGroups()
  const archive = useArchiveGroups()
  const [menuOpen, setMenuOpen] = useState(false)
  const isMuted = muted.has(group.id)
  const isFav = favorites.has(group.id)
  const isArchived = archive.has(group.id)
  // The card opens the chat; the ⋮ opens an actions MENU (not a page
  // navigation — the founder read navigating to the group page as "the group
  // opens"). Mirrors ContactRow. Links are siblings, never nested <a>.
  return (
    <li className="relative">
      <div className={'flex items-center gap-3 px-4 py-3 lg:py-2 hover:bg-field transition-colors ' + (isArchived ? 'opacity-60' : '')}>
        <Link to={`/chat/g/${group.id}`} className="flex items-center gap-3 flex-1 min-w-0">
          <GroupAvatar size={28} mediaId={group.avatar_media_id} mediaKey={group.avatar_media_key} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={'truncate ' + (unread > 0 ? 'font-bold' : 'font-medium')}>{group.name}</span>
              {isFav && <span className="text-yellow-500 text-xs flex-none">★</span>}
              {isMuted && <MuteGlyph />}
            </div>
            <div className="text-xs text-fg-dim">
              {t('section.groups.members', { n: memberCount(group) })}
              {group.host && <span className="font-mono"> · {group.host}</span>}
            </div>
          </div>
        </Link>
        {mentioned && (
          <span
            title={t('contacts.mentioned_you')}
            aria-label={t('contacts.mentioned_you')}
            className="flex-none text-accent font-semibold text-sm leading-none"
          >
            @
          </span>
        )}
        {unread > 0 && <UnreadBadge n={unread} />}
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface"
          title={t('contacts.more')}
          aria-label={t('contacts.more')}
        >
          <MoreIcon />
        </button>
      </div>
      {menuOpen && (
        <GroupActionsMenu group={group} onClose={() => setMenuOpen(false)} onChanged={onChanged} />
      )}
    </li>
  )
}

// SVG icons -------------------------------------------------------

// Muted indicator next to a contact/group name — a proper bell-with-slash
// glyph, not an emoji (founder: "должна быть не эмодзи, а обычные иконки").
function MuteGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-fg-dim flex-none" aria-hidden>
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
      <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
      <path d="M18 8a6 6 0 0 0-9.33-5" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M10 4v12M4 10h12" />
    </svg>
  )
}

/// Bookmark glyph for the Saved Messages («Заметки») row.
function BookmarkGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
    </svg>
  )
}

// UIN market — a price tag. Neutral commerce glyph (no gamey ornament).
function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 8a5 5 0 1 1 10 0v3l1.5 2.5h-13L5 11V8z" />
      <path d="M8 16a2 2 0 0 0 4 0" />
    </svg>
  )
}
/// Lock the app right now. Desktop only, and only once a PIN exists — there is
/// nothing to lock otherwise, and a padlock that does nothing is worse than no
/// padlock.
///
/// Until this button the only ways to lock were the row buried in Settings and
/// waiting out the auto-lock timer, which is not a timer everybody sets. The
/// moment someone needs it is the moment they are walking away from the screen,
/// and that is not a moment to go looking through Settings (founder).
function LockNowButton() {
  const { t } = useI18n()
  const [hasVault, setHasVault] = useState(false)
  useEffect(() => {
    if (!vaultSupported()) return
    let alive = true
    void vaultState().then((s) => {
      if (alive) setHasVault(s.exists)
    })
    return () => {
      alive = false
    }
  }, [])
  if (!hasVault) return null
  return (
    <button
      onClick={() => void lockNow()}
      className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface-dim transition-colors"
      title={t('pin.lock_now')}
      aria-label={t('pin.lock_now')}
    >
      <PadlockIcon />
    </button>
  )
}

function PadlockIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

function CogIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.6 3.5a2 2 0 0 1 4.8 0l.2.7a8 8 0 0 1 1.4.6l.7-.3a2 2 0 0 1 2.7 2.7l-.3.7a8 8 0 0 1 .6 1.4l.7.2a2 2 0 0 1 0 4.8l-.7.2a8 8 0 0 1-.6 1.4l.3.7a2 2 0 0 1-2.7 2.7l-.7-.3a8 8 0 0 1-1.4.6l-.2.7a2 2 0 0 1-4.8 0l-.2-.7a8 8 0 0 1-1.4-.6l-.7.3a2 2 0 0 1-2.7-2.7l.3-.7a8 8 0 0 1-.6-1.4l-.7-.2a2 2 0 0 1 0-4.8l.7-.2a8 8 0 0 1 .6-1.4l-.3-.7a2 2 0 0 1 2.7-2.7l.7.3a8 8 0 0 1 1.4-.6l.2-.7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
function PersonIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" />
    </svg>
  )
}
/// Gender glyph next to a contact's name (iOS/Android parity). Male = blue ♂,
/// female = pink ♀; anything else renders nothing.
function GenderIcon({ gender }: { gender?: string | null }) {
  const g = (gender || '').toLowerCase()
  if (g === 'm' || g === 'male') return <span className="text-xs flex-none" style={{ color: '#4A90D9' }}>♂</span>
  if (g === 'f' || g === 'female') return <span className="text-xs flex-none" style={{ color: '#D96BA6' }}>♀</span>
  return null
}
/// Blocked marker — a red crossed circle (⊘), replaces the old "BLOCKED"
/// text tag.
function BlockedIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      className="text-red-500 flex-none"
      aria-label="blocked"
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" />
    </svg>
  )
}
/// Unread-count pill, accent-filled. Caps the display at 99+.
function UnreadBadge({ n }: { n: number }) {
  return (
    <span className="flex-none min-w-[1.25rem] h-5 px-1.5 rounded-full bg-accent text-white text-[0.6875rem] font-bold flex items-center justify-center">
      {n > 99 ? '99+' : n}
    </span>
  )
}
function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <circle cx="4" cy="10" r="1.5" />
      <circle cx="10" cy="10" r="1.5" />
      <circle cx="16" cy="10" r="1.5" />
    </svg>
  )
}

/// Microphone, the door to the audio rooms. Inline like the other header
/// glyphs in this file rather than an icon dependency for one shape.
function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  )
}
