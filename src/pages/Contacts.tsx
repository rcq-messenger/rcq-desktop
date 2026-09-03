// Contact list — sectioned by role (Favorites / Groups / Online /
// Offline / Archive). Each section is collapsible; the user's
// preference persists in localStorage. Per-row trailing has two
// buttons: open chat + open the action menu (favorite / mute /
// archive / block / remove). Live presence + contact-graph deltas
// arrive via WS; favorites/archive/mute live entirely in
// localStorage on this device.
//
// Since 23.08 the list also carries the user's OWN sections (founder item 1,
// docs/sections-design-2026-08-23.md). They are not a seventh hardcoded bucket:
// they live in the vault's "sections" slot, so the same list of sections, in
// the same order, is on the phone. Three rules decide what renders where, and
// all three are one line each in the bucketing loop below:
//
//   archive > user section > derived
//
// A chat filed into a user section leaves EVERY derived one (Favorites,
// Cross-island, Groups, Online, Offline), exactly the way archiving already
// takes it out of them. Favorite survives as a flag and still sorts the row to
// the top inside its section. A membership whose chat this device cannot see
// right now simply does not render: it is never pruned, because a roster fetch
// that failed once would otherwise delete the account's sections.

import { relativeLastSeen } from '../lib/last-seen'
import { AltText } from '../components/AltText'
import { applySealedStateAll, loadRoomKeys } from '../lib/group-state'
import { loadProfileKeys, myProfileKey } from '../lib/profile-key'
import { AnimatePresence } from 'framer-motion'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { BypassShield } from '../components/BypassShield'
import { ChatPreviewModal } from '../components/ChatPreviewModal'
import { GlobalSearchOverlay } from '../components/GlobalSearchOverlay'
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
import {
  Api,
  type Contact,
  type PendingRequest,
  type RCQGroup,
  type UserInfo,
  type UserStatus,
} from '../lib/api'
import { contactsCache, persistSnapshot, restoreSnapshot } from '../lib/contacts-cache'
import { mirrorContactsToVault } from '../lib/contacts-vault'
import { memberCount } from '../lib/group-roster'
import { compactCount } from '../lib/format-count'
import { usePeerUnread, useGroupUnread, useTotalUnread, peerUnreadCount, groupUnreadCount } from '../lib/incoming-store'
import { useHasMention } from '../lib/mentions'
import { useI18n } from '../lib/i18n-context'
import { lockNow } from '../lib/pin-gate'
import { vaultState, vaultSupported, vaultVerify } from '../lib/desktop-vault'
import { SectionMenu, useSectionMenuTrigger, KeyIcon, type SectionMenuTarget } from '../components/SectionMenu'
import { SectionPickerSheet, type SectionCandidate } from '../components/SectionPickerSheet'
import { useSections } from '../lib/sections-store'
import { mutateSections, sectionKeyForGroup, sectionsAvailable } from '../lib/sections-vault'
import { sweepVaultSlots } from '../lib/vault-sync'
import {
  addMembers,
  createSection,
  deleteSection,
  memberIndex,
  membersOf,
  ORDER_STEP,
  orderOf,
  orderedSections,
  peerKey,
  removeMemberFrom,
  renameSection,
  SectionsError,
  setOrder,
  setPinned,
  SYS_ARCHIVE,
  SYS_CI,
  SYS_FAV,
  SYS_GROUPS,
  SYS_OFFLINE,
  SYS_ONLINE,
  SYS_SAVED,
  userSections,
  type SectionRecord,
  type SectionsTree,
} from '../lib/sections'
import { useIdentity } from '../lib/identity-context'
import { useToast } from '../lib/toast'
import { buildContactLink } from '../lib/federation'
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
  const { toast } = useToast()

  /// Hand someone the link that adds you. The native share sheet where there
  /// is one, because on a phone the next step is a messenger the person
  /// already uses; the clipboard everywhere else.
  async function shareMyLink() {
    if (!identity) return
    const link = buildContactLink({ uin: identity.uin, host: 'api.rcq.app' })
    const text = t('contacts.invite.text', { link })
    try {
      if (navigator.share) {
        await navigator.share({ text })
        return
      }
    } catch {
      // Cancelled or unavailable: fall through to the clipboard rather than
      // leaving the tap with nothing to show for it.
    }
    try {
      await navigator.clipboard.writeText(link)
      toast(t('contacts.invite.copied'))
    } catch {
      toast(link, 'info')
    }
  }

  // Lazy-init from the module cache so RETURNING to the list paints the
  // last-known contacts on the FIRST render — no "Загружаем" spinner flash
  // between the initial (empty) render and the effect that reads the cache.
  // A silent background refresh still runs to pick up changes in place.
  if (identity) restoreSnapshot(identity.uin)
  const _cachedAtMount = identity ? contactsCache.get(identity.uin) : undefined
  const [showGlobalSearch, setShowGlobalSearch] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>(() => _cachedAtMount?.contacts ?? [])
  const [groups, setGroups] = useState<RCQGroup[]>(() => _cachedAtMount?.groups ?? [])
  const [pending, setPending] = useState<PendingRequest[]>(() => _cachedAtMount?.pending ?? [])
  const [me, setMe] = useState<UserInfo | null>(() => _cachedAtMount?.me ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => !_cachedAtMount)
  // Cross-island requests are sealed at rest, so the store opens asynchronously
  // and the count has to be watched rather than read during a render.
  const [ciCount, setCiCount] = useState(() => requestCount())
  // Stage 6 phase 2: the room-key store is per-account; load it before the
  // first overlay, and re-run the refresh when a fresh key arrives live (a
  // gskey can land seconds after the list painted the fallback name).
  useEffect(() => {
    if (identity) { loadRoomKeys(identity.uin); loadProfileKeys(identity.uin) }
  }, [identity])
  useEffect(() => {
    const nudge = () => void refresh()
    window.addEventListener('rcq-room-keys-changed', nudge)
    return () => window.removeEventListener('rcq-room-keys-changed', nudge)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])

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

  // ── The user's own sections ───────────────────────────────────────────
  //
  // Gated on `capabilities.vault`: without a vault there is nowhere to keep
  // them, and a local-only fallback would create state that syncs badly the
  // day the island upgrades. On such an island there is no menu and no
  // section, not a disabled one.
  const tree = useSections()
  /// null = not answered yet. ⚠⚠ THE THREE STATES MATTER. This was a plain
  /// `false` until the review of 23.08, and `false` is "this island has no
  /// vault, hide the whole feature": on every cold start, and for as long as
  /// `/server/info` had not answered (15 s of timeout when the island is
  /// unreachable, and the failure is not cached, so it re-fails), a PIN-gated
  /// section's members were bucketed into Online / Offline / Cross-island and
  /// drawn by name, with their unread badges, while the section's own header
  /// was dropped from the list. No PIN asked for, no key glyph, on a screen
  /// whose copy says "hides this section until you enter your PIN". Unknown
  /// therefore keeps the cached filing: a chat can only BE filed if the island
  /// had a vault when it was filed, so "not answered yet" is never a reason to
  /// spill one.
  const [sectionsOk, setSectionsOk] = useState<boolean | null>(null)
  /// A real PIN this device can check against. Desktop only: in a browser tab
  /// there is nowhere to put a secret the page itself cannot reach, so there
  /// is no PIN to ask for and none is invented (sections design §5).
  const [canPin, setCanPin] = useState(false)
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; target: SectionMenuTarget } | null>(null)
  const [reordering, setReordering] = useState(false)
  const [picker, setPicker] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  /// Sections whose PIN has been answered, for THIS mount of this screen.
  /// Never persisted, never in the collapse set: it resets when the section is
  /// collapsed, when the window goes to the background, and on every cold
  /// start. A gate that survives those is not a gate.
  const [unlocked, setUnlocked] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!identity) return
    let alive = true
    void sectionsAvailable(identity).then((ok) => {
      if (alive) setSectionsOk(ok)
    })
    // The socket sweep (ws.tsx) covers the app; this covers arriving at the
    // list before the socket is up. It carries its own floor, so walking back
    // and forth between the list and a chat is not a request each time.
    void sweepVaultSlots(identity)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.uin])

  useEffect(() => {
    if (!vaultSupported()) return
    let alive = true
    void vaultState().then((v) => {
      if (alive) setCanPin(v.exists)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') setUnlocked(new Set())
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  /// Every local edit goes through here: it patches the cached tree, repaints
  /// immediately, and pushes to the island behind the paint. `defer` coalesces
  /// a burst (dragging sections about) into one write.
  function editSections(fn: (t: SectionsTree) => SectionsTree, opts?: { defer?: boolean }) {
    try {
      mutateSections(identity, fn, opts)
    } catch (e) {
      toast(e instanceof SectionsError ? t(`sections.err.${e.code}`) : t('contacts.error'), 'error')
    }
  }

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
      const overlaid = await applySealedStateAll(allGroups)
      setGroups(overlaid)
      persistSnapshot(identity.uin, { contacts: list, groups: overlaid, pending: pendingList, me: myInfo })
      // Stage 4, mirror phase: the list the island just served is sealed into
      // the account's vault slot so a reinstall has a roster once the island
      // stops serving one. Behind the paint, never blocking, never throwing;
      // a write only happens when the slot disagrees with the list.
      void mirrorContactsToVault(identity, list)
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

  // Which user section, if any, holds a given chat. The merge guarantees one
  // section per chat, so this is a lookup and not a search. A membership
  // pointing at a section this build does not hold (deleted elsewhere, not
  // synced yet) reads as "not filed" and the chat falls back to its derived
  // section: rendering is where a stale membership is forgiven, never where it
  // is deleted.
  const memberOf = memberIndex(tree)
  const userSecs = userSections(tree)
  const userSecIds = new Set(userSecs.map((r) => r.id))
  const sectionOf = (key: string | null): string | null => {
    // ⚠ `!== false`: an unanswered capability keeps the filing (see the state
    // above). Only an island that actually said "no vault" un-files anything.
    if (!key || sectionsOk === false) return null
    const id = memberOf.get(key)
    return id && userSecIds.has(id) ? id : null
  }
  const filedContacts = new Map<string, Contact[]>()
  const filedGroups = new Map<string, RCQGroup[]>()
  const filedCross = new Map<string, CrossIslandContact[]>()
  function file<T>(m: Map<string, T[]>, id: string, v: T) {
    const cur = m.get(id)
    if (cur) cur.push(v)
    else m.set(id, [v])
  }

  // Bucket contacts. A contact lives in exactly one bucket at a
  // time; archive wins over the user's own section, which wins over favorite,
  // which wins over status. iOS does the same: it sees the user's most-recent
  // intent. ⚠ The key carries the host: `1234` here and `1234@is2.rcq.app` are
  // two different people.
  const archived: Contact[] = []
  const fav: Contact[] = []
  const online: Contact[] = []
  const offline: Contact[] = []
  // Any "present" status counts as around → online section. Previously
  // only 'online' did, so away/dnd users wrongly fell into Offline.
  // (invisible already reports as offline from the server.)
  const isAround = (s: UserStatus) => s === 'online' || s === 'away' || s === 'dnd'
  for (const c of contacts) {
    const sid = sectionOf(peerKey(c.uin, c.host))
    if (archive.has(c.uin)) archived.push(c)
    else if (sid) file(filedContacts, sid, c)
    else if (favorites.has(c.uin)) fav.push(c)
    else if (isAround(c.status)) online.push(c)
    else offline.push(c)
  }
  // Bucket groups the same way (separate fav/archive sets so a group id can't
  // collide with a contact UIN): archived groups leave the Groups list and join
  // the bottom Archive section; favorited groups float to the top Favorites.
  // A group filed into a user section leaves the Groups section for the same
  // reason a contact does.
  const favGroups: RCQGroup[] = []
  const archivedGroups: RCQGroup[] = []
  const normalGroups: RCQGroup[] = []
  for (const g of groups) {
    const sid = sectionOf(sectionKeyForGroup(g))
    if (archiveGroups.has(g.id)) archivedGroups.push(g)
    else if (sid) file(filedGroups, sid, g)
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
  const crossLoose: CrossIslandContact[] = []
  for (const ci of crossIsland) {
    const sid = sectionOf(peerKey(ci.uin, ci.host))
    if (sid) file(filedCross, sid, ci)
    else crossLoose.push(ci)
  }
  // Inside a user section: unread first, then favorite (which survives filing
  // as a flag even though it has no section of its own to render into), then
  // the sort this client already uses, which on the web is by name.
  const filedContactOrder = (a: Contact, b: Contact) =>
    (peerUnreadCount(b.uin) > 0 ? 1 : 0) - (peerUnreadCount(a.uin) > 0 ? 1 : 0) ||
    (favorites.has(b.uin) ? 1 : 0) - (favorites.has(a.uin) ? 1 : 0) ||
    sortByNick(a, b)
  const filedGroupOrder = (a: RCQGroup, b: RCQGroup) =>
    (groupUnreadCount(b.id) > 0 ? 1 : 0) - (groupUnreadCount(a.id) > 0 ? 1 : 0) ||
    (favoriteGroups.has(b.id) ? 1 : 0) - (favoriteGroups.has(a.id) ? 1 : 0) ||
    a.name.localeCompare(b.name)

  // ── Which sections render, in which order ─────────────────────────────
  //
  // `o` ascending, ties by id: one total order every device agrees on. The
  // built-ins are records in the same array as the user's own sections (that
  // is how their order syncs), so this is one list, not two.
  const ordered = orderedSections(tree)
  const titleOf = (rec: SectionRecord): string => {
    switch (rec.id) {
      case SYS_FAV:
        return t('section.favorites')
      case SYS_CI:
        return 'Cross-island'
      case SYS_GROUPS:
        return t('section.groups')
      case SYS_ONLINE:
        return t('section.online')
      case SYS_OFFLINE:
        return t('section.offline')
      case SYS_ARCHIVE:
        return t('section.archive')
      default:
        return rec.n ?? ''
    }
  }
  const rendered = ordered.filter((rec) => {
    // Saved Messages is a pinned row above the list here, not a section. Its
    // record still rides along untouched: on Android it IS a section, and
    // dropping the record would delete that client's ordering.
    if (rec.id === SYS_SAVED) return false
    if (rec.k === 'u') return sectionsOk !== false && userSecIds.has(rec.id)
    // A section behind a PIN keeps its header whether or not it holds
    // anything: a header that appears only when there is something inside
    // announces exactly what the user asked to hide.
    if (rec.p === 1) return true
    switch (rec.id) {
      case SYS_FAV:
        return fav.length + favGroups.length > 0
      case SYS_CI:
        return crossLoose.length > 0
      case SYS_GROUPS:
        return true
      case SYS_ONLINE:
        return online.length > 0
      case SYS_OFFLINE:
        return offline.length > 0
      case SYS_ARCHIVE:
        return archived.length + archivedGroups.length > 0
      default:
        // A built-in id from a newer client: keep the record, draw nothing.
        return false
    }
  })

  /// Move `id` next to `anchorId` and write the new order once.
  ///
  /// `o` moves in steps of 1024 and a drop between two neighbours takes the
  /// midpoint. When the neighbours are less than 2 apart there is no room
  /// left, so every section is renormalised to `index * 1024`: a normal
  /// last-writer-wins write, rare, and it converges.
  function placeSection(id: string, anchorId: string, side: 'before' | 'after') {
    const rest = ordered.filter((r) => r.id !== id)
    const ai = rest.findIndex((r) => r.id === anchorId)
    if (ai < 0) return
    const at = side === 'before' ? ai : ai + 1
    const before = rest[at - 1]
    const after = rest[at]
    const lo = before ? orderOf(before) : after ? orderOf(after) - 2 * ORDER_STEP : 0
    const hi = after ? orderOf(after) : before ? orderOf(before) + 2 * ORDER_STEP : ORDER_STEP
    if (hi - lo < 2) {
      const ids = [...rest.slice(0, at).map((r) => r.id), id, ...rest.slice(at).map((r) => r.id)]
      editSections((tr) => setOrder(tr, new Map(ids.map((x, i) => [x, i * ORDER_STEP]))), { defer: true })
      return
    }
    editSections((tr) => setOrder(tr, new Map([[id, Math.floor((lo + hi) / 2)]])), { defer: true })
  }
  function moveSection(id: string, dir: -1 | 1) {
    const at = rendered.findIndex((r) => r.id === id)
    const neighbour = rendered[at + dir]
    if (!neighbour) return
    placeSection(id, neighbour.id, dir === -1 ? 'before' : 'after')
  }
  function dropSection(from: string, over: string) {
    const a = rendered.findIndex((r) => r.id === from)
    const b = rendered.findIndex((r) => r.id === over)
    if (a < 0 || b < 0 || a === b) return
    placeSection(from, over, a < b ? 'after' : 'before')
  }

  const isLocked = (rec: SectionRecord) => rec.p === 1 && !unlocked.has(rec.id)
  /// Everything a section header needs that is not its title or its rows.
  function chrome(rec: SectionRecord, at: number) {
    return {
      id: rec.id,
      collapsed,
      locked: isLocked(rec),
      lockedBody: (
        <SectionLockedBody
          canVerify={canPin}
          onUnlock={() => setUnlocked((prev) => new Set(prev).add(rec.id))}
        />
      ),
      // ⚠⚠ NOT on a locked section, and this is the gate itself, not a
      // nicety. The menu carries "stop asking for a PIN" and "delete section",
      // and neither asks for the PIN: on a locked header they turned the gate
      // off in two clicks, with no verify call, no failure counter and no
      // cooldown (the whole point of `vault_verify` keeping those), and then
      // synced `p:0` to the phone, where the section stopped being gated too.
      // `rightAction` was already suppressed this way one line below; this was
      // not. Unlock first, then the menu.
      onMenu:
        sectionsOk === true && !isLocked(rec)
          ? (x: number, y: number) =>
              setMenu({
                at: { x, y },
                target: { id: rec.id, user: rec.k === 'u', title: titleOf(rec), pinned: rec.p === 1 },
              })
          : undefined,
      // Collapsing a section the user got past the PIN for puts the gate back.
      onCollapse: () =>
        setUnlocked((prev) => {
          if (!prev.has(rec.id)) return prev
          const next = new Set(prev)
          next.delete(rec.id)
          return next
        }),
      reorder: reordering
        ? {
            first: at === 0,
            last: at === rendered.length - 1,
            dragging: dragging === rec.id,
            onUp: () => moveSection(rec.id, -1),
            onDown: () => moveSection(rec.id, 1),
            onDragStart: () => setDragging(rec.id),
            onDragEnd: () => setDragging(null),
            onDropOn: (from: string | null) => {
              const src = from ?? dragging
              if (src && src !== rec.id) dropSection(src, rec.id)
              setDragging(null)
            },
          }
        : undefined,
    }
  }

  /// Contacts, cross-island peers and groups as one pick list for the plus
  /// button, keyed the way the slot keys them. A person who is both a server
  /// contact row and a local cross-island record is one candidate, not two.
  function pickCandidates(): SectionCandidate[] {
    const byKey = new Map<string, SectionCandidate>()
    for (const c of contacts) {
      byKey.set(peerKey(c.uin, c.host), {
        key: peerKey(c.uin, c.host),
        title: ciAliasFor(c.uin, c.host) || c.nickname || `${c.uin}`,
        subtitle: c.host ? `${c.uin} · ${c.host}` : `${c.uin}`,
        kind: 'peer',
        status: c.status,
        crossIsland: !!c.host,
        avatarMediaId: c.avatar_media_id,
        avatarMediaKey: c.avatar_media_key,
      })
    }
    for (const ci of crossIsland) {
      const key = peerKey(ci.uin, ci.host)
      if (byKey.has(key)) continue
      byKey.set(key, {
        key,
        title: ciAliasFor(ci.uin, ci.host) || ci.nickname || `${ci.uin}@${ci.host}`,
        subtitle: `${ci.uin} · ${ci.host}`,
        kind: 'peer',
        crossIsland: true,
        avatarMediaId: ci.avatarMediaId,
        avatarMediaKey: ci.avatarMediaKey,
      })
    }
    for (const g of groups) {
      const key = sectionKeyForGroup(g)
      if (!key || byKey.has(key)) continue
      byKey.set(key, {
        key,
        title: g.name,
        subtitle: g.host ?? t('section.groups'),
        kind: 'group',
        avatarMediaId: g.avatar_media_id,
        avatarMediaKey: g.avatar_media_key,
      })
    }
    return [...byKey.values()]
  }

  /// The picker closed: one write for the whole sheet, adds and removals
  /// together.
  ///
  /// ⚠ The sheet hands over what the USER did (ticked, unticked), not the
  /// membership it ended up showing. Diffing its list against the tree as it
  /// stands now was a silent undo of anything another device did to this
  /// section while the sheet sat open: the sheet's checkboxes are seeded once,
  /// so a chat the phone filed here in the meantime looked like a row the user
  /// had unticked, and went out with a tombstone newer than the phone's add.
  function saveMembership(id: string, added: string[], gone: string[]) {
    if (added.length === 0 && gone.length === 0) return
    editSections((tr) => {
      let out = added.length > 0 ? addMembers(tr, id, added) : tr
      for (const k of gone) out = removeMemberFrom(out, id, k)
      return out
    })
  }

  function renderSection(rec: SectionRecord, at: number) {
    const c = chrome(rec, at)
    switch (rec.id) {
      case SYS_FAV:
        return (
          <Section key={rec.id} {...c} title={titleOf(rec)} count={fav.length + favGroups.length}>
            {favGroups.map((g) => (
              <GroupRow key={`g${g.id}`} group={g} onChanged={refresh} />
            ))}
            {fav.map((ct) => (
              <ContactRow key={ct.uin} contact={ct} muted={muted.has(ct.uin)} favorite onChanged={refresh} />
            ))}
          </Section>
        )
      case SYS_CI:
        return (
          <Section key={rec.id} {...c} title={titleOf(rec)} count={crossLoose.length}>
            {crossLoose.map((ci) => (
              <CrossIslandRow
                key={`${ci.uin}@${ci.host}`}
                ci={ci}
                aliasFor={ciAliasFor}
                onChanged={() => refresh(true)}
              />
            ))}
          </Section>
        )
      case SYS_GROUPS:
        return (
          <Section
            key={rec.id}
            {...c}
            title={titleOf(rec)}
            count={normalGroups.length}
            unread={groupSectionUnread(normalGroups)}
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
        )
      case SYS_ONLINE:
      case SYS_OFFLINE: {
        const rows = rec.id === SYS_ONLINE ? online : offline
        return (
          <Section key={rec.id} {...c} title={titleOf(rec)} count={rows.length} unread={sectionUnread(rows)}>
            {rows.map((ct) => (
              <ContactRow key={ct.uin} contact={ct} muted={muted.has(ct.uin)} onChanged={refresh} />
            ))}
          </Section>
        )
      }
      case SYS_ARCHIVE:
        return (
          <Section
            key={rec.id}
            {...c}
            title={titleOf(rec)}
            count={archived.length + archivedGroups.length}
            collapsedByDefault
          >
            {archivedGroups.map((g) => (
              <GroupRow key={`g${g.id}`} group={g} onChanged={refresh} />
            ))}
            {archived.map((ct) => (
              <ContactRow key={ct.uin} contact={ct} muted={muted.has(ct.uin)} archived onChanged={refresh} />
            ))}
          </Section>
        )
      default: {
        const cs = (filedContacts.get(rec.id) ?? []).sort(filedContactOrder)
        const gs = (filedGroups.get(rec.id) ?? []).sort(filedGroupOrder)
        const cis = filedCross.get(rec.id) ?? []
        const total = cs.length + gs.length + cis.length
        return (
          <Section
            key={rec.id}
            {...c}
            title={titleOf(rec)}
            count={total}
            unread={sectionUnread(cs) + groupSectionUnread(gs)}
            rightAction={
              <button
                onClick={() => setPicker(rec.id)}
                className="text-xs text-accent hover:text-accent-dim font-semibold px-2 py-1"
                title={t('sections.add')}
                aria-label={t('sections.add')}
              >
                +
              </button>
            }
          >
            {/* An empty user section still renders: it was made on purpose.
                This differs from Archive and Favorites, which hide. */}
            {total === 0 ? (
              <li className="px-4 py-3 lg:py-2 text-xs text-fg-dim">{t('sections.empty')}</li>
            ) : (
              <>
                {gs.map((g) => (
                  <GroupRow key={`g${g.id}`} group={g} inUserSection onChanged={refresh} />
                ))}
                {cs.map((ct) => (
                  <ContactRow
                    key={ct.uin}
                    contact={ct}
                    muted={muted.has(ct.uin)}
                    favorite={favorites.has(ct.uin)}
                    inUserSection
                    onChanged={refresh}
                  />
                ))}
                {cis.map((ci) => (
                  <CrossIslandRow
                    key={`${ci.uin}@${ci.host}`}
                    ci={ci}
                    aliasFor={ciAliasFor}
                    onChanged={() => refresh(true)}
                  />
                ))}
              </>
            )}
          </Section>
        )
      }
    }
  }

  return (
    // See Settings for why the page is a pane rather than a scrolling document
    // (#839: the wheel does not move the document under WebKitGTK).
    <div className="h-screen [height:calc(100dvh-var(--rcq-titlebar-inset))] pt-[var(--rcq-top-inset)] flex flex-col bg-surface-dim overflow-hidden">
      <header className="rcq-header sticky top-0 z-10 shrink-0">
        <div className="max-w-2xl mx-auto px-3 h-14 flex items-center gap-2">
          {me && (
            <>
              <StatusPickerButton
                current={me.status}
                onChange={(s) => setMe({ ...me, status: s })}
                avatarMediaId={me.avatar_media_id}
                avatarMediaKey={me.avatar_media_key ?? myProfileKey()}
              />
              <Link
                to="/profile"
                className="flex flex-col leading-tight min-w-0 hover:opacity-80 transition-opacity"
              >
                <span className="font-semibold text-sm truncate">
                  {me.nickname || `${me.uin}`}
                </span>
                <span className="text-[0.625rem] text-fg-dim">{me.uin}</span>
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
              onClick={() => setShowGlobalSearch(true)}
              className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-field"
              title={t('home.search.title')}
              aria-label={t('home.search.title')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
            </button>
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
            {/* `.rcq` sites. A door of its own rather than a row in Settings:
                it is a place you go to, not a preference you set. */}
            <Link
              to="/sites"
              className="text-fg-secondary hover:text-fg-primary p-2 rounded-md hover:bg-surface-dim max-[519px]:hidden"
              title={t('sites.nav')}
              aria-label={t('sites.nav')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18" />
                <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
              </svg>
            </Link>
            {/* A narrow window keeps only the doors the founder named (21.08):
                lock, settings, rooms, requests, add — the update pill shrinks
                to a square icon. News goes first, being the reads-later kind
                of door rather than the reach-for kind.

                The theme switch is gone from here entirely (founder, 01.09):
                it is a row in Settings, and a header is for the things you
                reach for, not for a preference you set once. */}
            <NewsButton className="relative text-fg-secondary hover:text-fg-primary p-2 rounded-md max-[519px]:hidden" />
            <LockNowButton />
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
      {/* Global search over every chat and message (founder, 29.08). A
          portal, so its place in this tree is cosmetic; it lives here for
          the page's contacts/groups scope. */}
      {showGlobalSearch && (
        <GlobalSearchOverlay contacts={contacts} groups={groups} onClose={() => setShowGlobalSearch(false)} />
      )}

      <main className="flex-1 min-h-0 overflow-y-auto overscroll-contain w-full max-w-2xl mx-auto px-4 py-4 space-y-4">
        {loading && contacts.length === 0 && (
          <div className="text-center text-sm text-fg-secondary py-12">{t('contacts.loading')}</div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-600 mb-4">
            {error}
            <button onClick={() => void refresh()} className="ml-3 underline">{t('common.retry')}</button>
          </div>
        )}

        {/* ⚠ The most-seen screen in the product, and until 22.08 it told a web
            or desktop newcomer to "add contacts on iOS", copy left over from the
            send-only phase. The numbers say what that costs: of 549 people who
            registered in the last 30 days, 5.6% ever added a single contact and
            61% never came back after day one. Somebody who arrives with nobody
            to talk to has exactly two useful moves, and both are now here:
            add a number they already know, or bring one person with them. */}
        {!loading && contacts.length === 0 && !error && (
          <div className="text-center text-sm text-fg-secondary py-12 space-y-2">
            <div>{t('contacts.empty')}</div>
            <div className="text-xs text-fg-dim max-w-xs mx-auto">{t('contacts.empty.hint')}</div>
            <div className="flex items-center justify-center gap-2 pt-3">
              <Link
                to="/add"
                className="inline-block px-4 h-10 leading-10 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold transition-colors"
              >
                {t('contacts.add')}
              </Link>
              <button
                type="button"
                onClick={() => void shareMyLink()}
                className="inline-block px-4 h-10 leading-10 rounded-md border border-line hover:bg-field text-sm font-semibold transition-colors"
              >
                {t('contacts.invite')}
              </button>
            </div>
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

        {/* Reorder mode. The founder asked for dragging; a section header is
            also a touch target on a phone-sized window, where HTML5 drag does
            not fire at all, so the same mode carries arrows. Either way the
            write happens on drop, debounced and coalesced: never per frame. */}
        {reordering && (
          <div className="flex items-center justify-between gap-2 px-2 -mb-2">
            <span className="text-xs text-fg-secondary">{t('sections.reorder.hint')}</span>
            <button
              onClick={() => setReordering(false)}
              className="text-xs font-semibold text-accent hover:text-accent-dim px-2 py-1"
            >
              {t('sections.reorder.done')}
            </button>
          </div>
        )}

        {rendered.map((rec, at) => renderSection(rec, at))}
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
      {menu && (
        <SectionMenu
          at={menu.at}
          target={menu.target}
          canPin={canPin}
          onClose={() => setMenu(null)}
          onReorder={() => setReordering(true)}
          onTogglePin={() => editSections((tr) => setPinned(tr, menu.target.id, !menu.target.pinned))}
          onCreate={(name) => editSections((tr) => createSection(tr, name))}
          onRename={(name) => editSections((tr) => renameSection(tr, menu.target.id, name))}
          onDelete={() => editSections((tr) => deleteSection(tr, menu.target.id))}
        />
      )}
      {picker && (
        <SectionPickerSheet
          sectionName={titleOf(ordered.find((r) => r.id === picker) ?? { id: picker })}
          candidates={pickCandidates()}
          selected={membersOf(tree, picker)}
          onClose={() => setPicker(null)}
          onSave={(added, gone) => saveMembership(picker, added, gone)}
        />
      )}
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
  locked = false,
  lockedBody,
  onMenu,
  onCollapse,
  reorder,
}: {
  id: string
  title: string
  count: number
  unread?: number
  children: React.ReactNode
  collapsed: { has: (id: string) => boolean; toggle: (id: string) => void }
  collapsedByDefault?: boolean
  rightAction?: React.ReactNode
  /// This section asks for the PIN and has not been answered yet.
  locked?: boolean
  /// What to show when the header of a locked section is opened: the PIN
  /// field on the desktop, an honest one-liner in the browser.
  lockedBody?: React.ReactNode
  /// Right-click, or a half-second press with a finger, at those coordinates.
  onMenu?: (x: number, y: number) => void
  /// The header was clicked while the section was open.
  onCollapse?: () => void
  reorder?: {
    first: boolean
    last: boolean
    dragging: boolean
    onUp: () => void
    onDown: () => void
    onDragStart: () => void
    onDragEnd: () => void
    /// The id the drop carried, when the browser gave us one.
    onDropOn: (from: string | null) => void
  }
}) {
  const { t } = useI18n()
  // The collapsed-set tracks user-toggled state; for sections that
  // start collapsed (Archive), we invert: the absence of the id
  // in the set means "use default" → render collapsed.
  const userToggled = collapsed.has(id)
  const persistedCollapse = collapsedByDefault ? !userToggled : userToggled
  /// A locked section does NOT use the collapse set. Its open state is view
  /// memory that dies with this screen, so that a section left open cannot
  /// still be open after a cold start.
  const [gateOpen, setGateOpen] = useState(false)
  const isCollapsed = locked ? !gateOpen : persistedCollapse
  const trigger = useSectionMenuTrigger((x, y) => onMenu?.(x, y))

  const toggle = () => {
    // A long press ends in a click as well; without this the menu would open
    // and the section would collapse underneath it.
    if (trigger.suppressed()) return
    if (locked) {
      setGateOpen((v) => !v)
      return
    }
    if (!isCollapsed) onCollapse?.()
    collapsed.toggle(id)
  }

  return (
    <section className={reorder?.dragging ? 'opacity-50' : ''}>
      <div
        className="flex items-center justify-between mb-1.5 px-2"
        draggable={!!reorder}
        onDragStart={
          reorder
            ? (e) => {
                // ⚠ The id rides in the dataTransfer as well as in React
                // state. State alone would depend on a re-render landing
                // between dragstart and drop, which is true of a human drag
                // and not of anything faster.
                e.dataTransfer.setData('text/plain', id)
                e.dataTransfer.effectAllowed = 'move'
                reorder.onDragStart()
              }
            : undefined
        }
        onDragEnd={reorder?.onDragEnd}
        onDragOver={reorder ? (e) => e.preventDefault() : undefined}
        onDrop={
          reorder
            ? (e) => {
                e.preventDefault()
                reorder.onDropOn(e.dataTransfer.getData('text/plain') || null)
              }
            : undefined
        }
      >
        <button
          onClick={toggle}
          onContextMenu={onMenu ? trigger.handlers.onContextMenu : undefined}
          onPointerDown={onMenu ? trigger.handlers.onPointerDown : undefined}
          onPointerMove={onMenu ? trigger.handlers.onPointerMove : undefined}
          onPointerUp={onMenu ? trigger.handlers.onPointerUp : undefined}
          onPointerCancel={onMenu ? trigger.handlers.onPointerCancel : undefined}
          className="flex items-center gap-1.5 text-xs font-bold text-fg-secondary uppercase tracking-wider hover:text-fg-primary min-w-0"
        >
          {reorder && <span className="text-fg-dim cursor-grab">⠿</span>}
          <span className="text-fg-dim">{isCollapsed ? '▸' : '▾'}</span>
          <span className="truncate">{title}</span>
          {/* ⚠ A locked section shows NEITHER its count NOR its unread badge.
              A badge over a section the user hid is a leak of exactly what was
              hidden. */}
          {locked ? (
            <span className="text-fg-dim" title={t('sections.locked.title')} aria-label={t('sections.locked.title')}>
              <KeyIcon size={13} />
            </span>
          ) : (
            <>
              <span className="text-fg-dim">·{count}</span>
              {unread > 0 && (
                <span className="ml-1 inline-flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full bg-red-500 text-white text-[0.625rem] font-bold tracking-normal">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </>
          )}
        </button>
        <div className="flex items-center gap-1 flex-none">
          {reorder && (
            <>
              <button
                onClick={reorder.onUp}
                disabled={reorder.first}
                className="text-fg-secondary hover:text-fg-primary disabled:opacity-30 px-1.5 py-0.5"
                aria-label={t('sections.move_up')}
                title={t('sections.move_up')}
              >
                ▲
              </button>
              <button
                onClick={reorder.onDown}
                disabled={reorder.last}
                className="text-fg-secondary hover:text-fg-primary disabled:opacity-30 px-1.5 py-0.5"
                aria-label={t('sections.move_down')}
                title={t('sections.move_down')}
              >
                ▼
              </button>
            </>
          )}
          {!locked && rightAction}
        </div>
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
          {locked ? lockedBody : children}
        </ul>
      )}
    </section>
  )
}

/// What sits behind the header of a PIN-gated section.
///
/// Two honest answers, never a third:
///
///   * the desktop with a PIN asks for it, and checks it through the vault's
///     own verify, which counts a wrong answer exactly as the lock screen does
///     (otherwise this field is an unlimited PIN oracle that walks around the
///     lockout).
///   * everywhere else says so and offers to open the section anyway. The
///     browser has no PIN subsystem and is not getting a fake one: a hashed
///     PIN in localStorage would be a curtain over an open window, and a
///     greyed-out padlock would imply the phones offer something comparable in
///     kind rather than in degree.
///
/// Either way the chats themselves are untouched: they stay in search, in
/// notifications and in the message database. Only the row's placement in this
/// list is hidden. Anyone who wants the conversation itself gated locks the
/// chat, which already exists.
function SectionLockedBody({ canVerify, onUnlock }: { canVerify: boolean; onUnlock: () => void }) {
  const { t } = useI18n()
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canVerify) {
    return (
      <li className="px-4 py-3 space-y-2">
        <p className="text-xs text-fg-secondary leading-relaxed">
          {t(vaultSupported() ? 'sections.locked.nopin' : 'sections.locked.browser')}
        </p>
        <button
          onClick={onUnlock}
          className="h-8 px-3 rounded-md bg-field hover:bg-line/50 text-xs font-semibold transition-colors"
        >
          {t('sections.locked.open_anyway')}
        </button>
      </li>
    )
  }

  async function submit() {
    if (busy || !pin) return
    setBusy(true)
    setError(null)
    try {
      if (await vaultVerify(pin)) {
        setPin('')
        onUnlock()
      } else {
        setError(t('sections.locked.wrong'))
      }
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e)
      const wait = code.startsWith('locked_out:') ? code.slice('locked_out:'.length) : null
      setError(wait ? t('sections.locked.wait', { n: wait }) : t('sections.locked.wrong'))
    } finally {
      setBusy(false)
      setPin('')
    }
  }

  return (
    <li className="px-4 py-3 space-y-2">
      <p className="text-xs text-fg-secondary leading-relaxed">{t('sections.menu.pin.note')}</p>
      <div className="flex gap-2">
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder={t('sections.locked.enter')}
          className="flex-1 h-9 px-2 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
        <button
          onClick={() => void submit()}
          disabled={busy || !pin}
          className="h-9 px-3 rounded-md bg-accent hover:bg-accent-dim disabled:opacity-50 text-white text-xs font-semibold"
        >
          {t('sections.locked.open')}
        </button>
      </div>
      {error && <div className="text-xs text-red-500">{error}</div>}
    </li>
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
  inUserSection,
  onChanged,
}: {
  contact: Contact
  muted: boolean
  favorite?: boolean
  archived?: boolean
  /// This row is inside a section the user made themselves. Favourite and
  /// archive are hidden then - see `ContactActionsMenu`.
  inUserSection?: boolean
  onChanged: () => void
}) {
  const { t, lang } = useI18n()
  const [previewOpen, setPreviewOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const unread = usePeerUnread(contact.uin)
  // My own name for this person wins over the nickname they chose. Device-only
  // (see useContactAliases). ⚠ Keyed WITH the host when the server row carries
  // one (an F2 cross-island contact): the chat header and the row menu use the
  // composite key, and a bare lookup here made the same rename show in one
  // place and not the other.
  const { aliasFor } = useContactAliases()
  const alias = aliasFor(contact.uin, contact.host)
  return (
    <li className="relative">
      {/* The same hover the group rows and the cross-island rows have always
          had. A person was the one row type that stayed flat under the cursor,
          so the list looked half-interactive (founder, 24.08). */}
      <div
        className={
          'flex items-center gap-3 px-4 py-3 lg:py-2 hover:bg-field transition-colors ' +
          (archived ? 'opacity-60' : '')
        }
      >
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
            uinForKey={contact.uin}
            askPeer={contact}
            crossIsland={!!contact.host}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={'truncate ' + (unread > 0 ? 'font-bold' : 'font-medium')}>
                {alias || contact.nickname || `${contact.uin}`}
              </span>
              <GenderIcon gender={contact.gender} />
              {favorite && <span className="text-yellow-500 text-xs flex-none">★</span>}
              {muted && <MuteGlyph />}
              {contact.blocked && <BlockedIcon />}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-fg-dim min-w-0">
              <span className="flex-none">{contact.uin}</span>
              {/* ⚠ Order matters, and it used to be the other way round: a
                  status message won outright, so an OFFLINE contact who had
                  one never showed when they were last around. Measured on
                  prod 31.08: of 1498 contact rows that are genuinely offline,
                  455 (30%) carry a status message, so for nearly a third of
                  people the last seen was invisible everywhere - and most
                  visibly in Favourites and user sections, where there is no
                  Online/Offline heading to read it off instead. A status
                  message is text somebody left behind; when they are not here,
                  WHEN they were here is the more useful half, so it goes
                  first and the message keeps whatever room is left. */}
              {(() => {
                // Both are worth saying and the line fits one, so they take
                // turns (founder). Sharing the line was the first attempt and
                // it truncated on a phone; a status message wins outright was
                // the state before that, and it hid the last seen for 30% of
                // offline contacts.
                const seen =
                  contact.status === 'offline' && contact.last_seen
                    ? '· ' + t('contact.last_seen', { when: relativeLastSeen(contact.last_seen, t, lang) })
                    : null
                const msg = contact.status_message ? '· ' + contact.status_message : null
                if (seen && msg) return <AltText a={seen} b={msg} />
                if (seen) return <span className="truncate">{seen}</span>
                if (msg) return <span className="truncate">{msg}</span>
                return null
              })()}
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
      <AnimatePresence>
      {menuOpen && (
        <ContactActionsMenu
          contact={contact}
          inUserSection={inUserSection}
          onClose={() => setMenuOpen(false)}
          onChanged={onChanged}
          onPreview={() => setPreviewOpen(true)}
        />
      )}
    </AnimatePresence>
      {previewOpen && (
        <ChatPreviewModal
          kind="peer"
          id={contact.uin}
          title={alias || contact.nickname || `${contact.uin}`}
          status={contact.status}
          avatarMediaId={contact.avatar_media_id}
          avatarMediaKey={contact.avatar_media_key}
          onClose={() => setPreviewOpen(false)}
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
            <div className="text-xs text-fg-dim truncate">
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
      <AnimatePresence>
      {menuOpen && (
        <CrossIslandActionsMenu
          contact={ci}
          onClose={() => setMenuOpen(false)}
          onChanged={onChanged}
        />
      )}
    </AnimatePresence>
    </li>
  )
}

function GroupRow({
  group,
  inUserSection,
  onChanged,
}: {
  group: RCQGroup
  /// Inside a section the user made themselves - favourite and archive are not
  /// offered there, see `ContactActionsMenu`.
  inUserSection?: boolean
  onChanged: () => void
}) {
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
  const [previewOpen, setPreviewOpen] = useState(false)
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
              {t('section.groups.members', { n: compactCount(memberCount(group)) })}
              {group.host && <span className=""> · {group.host}</span>}
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
      <AnimatePresence>
      {menuOpen && (
        <GroupActionsMenu
          group={group}
          inUserSection={inUserSection}
          onClose={() => setMenuOpen(false)}
          onChanged={onChanged}
          onPreview={() => setPreviewOpen(true)}
        />
      )}
    </AnimatePresence>
      {previewOpen && (
        <ChatPreviewModal
          kind="group"
          id={group.id}
          title={group.name}
          avatarMediaId={group.avatar_media_id}
          avatarMediaKey={group.avatar_media_key}
          onClose={() => setPreviewOpen(false)}
        />
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
