// Who #396 is.
//
// Every line the CLI printed was a bare number, contacts included, and the
// group label fired its fetch WITHOUT awaiting it, so the first group row of
// every process rendered as `[группа 21]` by construction, not by bad luck
// (founder, 21.08). Both halves are the same missing piece: a directory that
// is warm BEFORE the first line rather than one started by it.
//
// The roster is the core's own persisted snapshot (contacts-cache.ts, what the
// web paints from), so it survives the process, answers synchronously and is
// still right offline. Somebody in no list at all is asked about once through
// /users/{uin}/info and remembered: "who did I just message" is the question
// the whole stranger warning turns on, and it has to be answerable BEFORE the
// message leaves.
//
// ⚠ setAccountScope is called here and nowhere else. Every core store keyed by
// scopedKey (this snapshot, the stranger allow-list, the cross-island rows)
// writes to a flat `rcq.web.<suffix>` key until it is set: one namespace for
// two accounts, which is the exact bug account-scope.ts was written to end.

import { setAccountScope } from '../../src/lib/account-scope'
import { Api, ApiError, type Contact, type PendingRequest, type RCQGroup, type UserInfo } from '../../src/lib/api'
import {
  contactsCache,
  lookupGroupName,
  persistSnapshot,
  restoreSnapshot,
} from '../../src/lib/contacts-cache'
import { getCrossIsland } from '../../src/lib/crossisland-store'
import type { WebIdentity } from '../../src/lib/crypto'
import { tr } from './i18n'
import { err } from './style'
import { humanError } from './errors'

/// Names learned from /users/{uin}/info for people in no list of ours. Kept
/// on disk beside the roster so a stranger who wrote yesterday still has a
/// name today, and capped so the state file cannot grow without bound.
/// Same-island uins only: a uin is per-island, so a name learned here would be
/// a different person's on another host.
const LEARNED_KEY = 'rcq.cli.names'
const LEARNED_CAP = 200

/// Scoped by hand rather than through scopedKey: this is the CLI's own store,
/// not one of the core's, and the shape (`rcq.cli.names.<uin>`) says so.
function learnedKey(myUin: number): string {
  return `${LEARNED_KEY}.${myUin}`
}

function loadLearned(myUin: number): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(learnedKey(myUin)) || '{}') as Record<string, string>
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function learnName(myUin: number, uin: number, name: string): void {
  const map = loadLearned(myUin)
  if (map[String(uin)] === name) return
  delete map[String(uin)] // re-inserted last, so the trim below drops the oldest
  map[String(uin)] = name
  const keys = Object.keys(map)
  for (const k of keys.slice(0, Math.max(0, keys.length - LEARNED_CAP))) delete map[k]
  try {
    localStorage.setItem(learnedKey(myUin), JSON.stringify(map))
  } catch {
    /* a name is a nicety, never a reason to fail a command */
  }
}

/// Remember a name somebody else has told us, for the lines that come after.
/// A contact request carries its sender's nickname on the frame, and that is
/// the one moment a stranger's name arrives without being asked for.
export function noteName(myUin: number, uin: number, name: string): void {
  if (name.trim()) learnName(myUin, uin, name.trim())
}

/// Scope this process to the account and warm the roster from disk. Called
/// before anything reads a store, i.e. the moment an identity is loaded.
export function initDirectory(uin: number): void {
  setAccountScope(uin)
  restoreSnapshot(uin)
}

let inflight: Promise<Contact[]> | null = null
let refreshComplained = false

async function fetchDirectory(identity: WebIdentity): Promise<Contact[]> {
  // The group list without its rosters: names, counts and the room rules are
  // all a list row needs, and the members are the expensive half of a group
  // payload (`ensureRoster` fetches one when a send actually needs it).
  const [contacts, groups, pending] = await Promise.all([
    Api.contacts(identity),
    Api.groups(identity, false).catch(() => null),
    Api.pendingRequests(identity).catch(() => null),
  ])
  const prev = contactsCache.get(identity.uin)
  persistSnapshot(identity.uin, {
    contacts,
    // A failed group fetch keeps the names we had; blanking them would put the
    // raw ids back on screen for the rest of the process.
    groups: groups ?? prev?.groups ?? [],
    pending: pending ?? prev?.pending ?? [],
    me: prev?.me ?? null,
  })
  return contacts
}

/// Pull the roster and the group names into the snapshot the labels read.
/// Shared: two callers in the same breath (the prime below and `/contacts`)
/// make one request between them.
export function refreshDirectory(identity: WebIdentity): Promise<Contact[]> {
  if (!inflight) {
    inflight = fetchDirectory(identity)
    void inflight.catch(() => {}).then(() => {
      inflight = null
    })
  }
  return inflight
}

/// Warm the directory before the first line prints, without letting a dead
/// island hold the prompt: past the deadline the caller carries on and the
/// refresh lands behind it, in time for the lines after.
export async function primeDirectory(identity: WebIdentity, waitMs = 4000): Promise<void> {
  const done = refreshDirectory(identity).then(
    () => {},
    (e: unknown) => {
      // Names quietly stopped resolving is exactly the kind of half-failure
      // that reads as "the client is broken": say it once, then stay quiet.
      if (refreshComplained) return
      refreshComplained = true
      process.stderr.write(
        err.dim(tr('dir.stale', { err: humanError(e) })) + '\n',
      )
    },
  )
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs)
    void done.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/// The roster as last seen, straight from the warm snapshot. Empty when this
/// account has never had a successful refresh.
export function cachedContacts(myUin: number): Contact[] {
  return contactsCache.get(myUin)?.contacts ?? []
}

export function isContact(myUin: number, uin: number): boolean {
  return cachedContacts(myUin).some((c) => c.uin === uin)
}

/// The account's groups as last seen. Same snapshot as the contacts, so a
/// group list answers offline and before the first refresh lands.
export function cachedGroups(myUin: number): RCQGroup[] {
  return contactsCache.get(myUin)?.groups ?? []
}

/// Incoming contact requests as last seen. Refreshed with the roster.
export function cachedPending(myUin: number): PendingRequest[] {
  return contactsCache.get(myUin)?.pending ?? []
}

export function groupById(myUin: number, gid: number): RCQGroup | null {
  return cachedGroups(myUin).find((g) => g.id === gid) ?? null
}

/// A group by its id (`21`) or by its name, whole or as a unique prefix.
/// Nobody types `21` for the room they call "Работа", and a terminal is the
/// one place where a name is easier to type than to click.
export function findGroup(myUin: number, token: string): RCQGroup | null {
  const groups = cachedGroups(myUin)
  const asId = Number(token)
  if (Number.isInteger(asId)) {
    const byId = groupById(myUin, asId)
    if (byId) return byId
  }
  const needle = token.trim().toLowerCase()
  if (!needle) return null
  const exact = groups.filter((g) => g.name.toLowerCase() === needle)
  if (exact.length === 1) return exact[0]
  const prefix = groups.filter((g) => g.name.toLowerCase().startsWith(needle))
  // An ambiguous prefix is not a group: picking one of two rooms for somebody
  // is how a message lands in the wrong one.
  return prefix.length === 1 ? prefix[0] : null
}

/// How many people are in a group, whether or not the roster came with it.
export function groupSize(g: RCQGroup): number {
  return g.member_count && g.member_count > 0 ? g.member_count : g.members.length
}

/// The name we hold for a uin, or null when nobody has ever told us one.
/// A `host` makes it a peer on ANOTHER island: their uin means nothing here,
/// so only the cross-island store may answer for them.
export function knownName(myUin: number, uin: number, host?: string): string | null {
  if (host) return getCrossIsland(uin, host)?.nickname || null
  const c = cachedContacts(myUin).find((x) => x.uin === uin)
  if (c?.nickname) return c.nickname
  return loadLearned(myUin)[String(uin)] || null
}

function ownHost(identity: WebIdentity): string {
  try {
    return new URL(identity.apiBase).host.toLowerCase()
  } catch {
    return 'api.rcq.app'
  }
}

/// The sender's island, but only when it is not ours.
///
/// ⚠ EVERY v=1 envelope carries `from_host`, local senders included
/// (crypto.ts fills it from the sender's own apiBase), so the bare field says
/// nothing at all. Cross-island means "not where we live", and reading it any
/// other way labels every ordinary v=1 message `#500@api.rcq.app` and, worse,
/// takes the same wrong turn everywhere a host decides behaviour.
export function foreignHost(identity: WebIdentity, senderHost?: string): string | undefined {
  if (!senderHost) return undefined
  const h = senderHost.toLowerCase()
  return h === ownHost(identity) ? undefined : h
}

/// How a person is written on a line. The founder's rule: a CONTACT you know
/// is written by NAME alone (`Boris`), because carrying `#203671965` beside a
/// name you saved is noise; a bare number then means exactly one thing, "you do
/// not know this person". Someone NOT in your contacts keeps the number, name
/// and all (`Ivan (#396)` for a stranger who told us a name, `#396` for one who
/// did not), so the number on the line is the mark of a non-contact.
///
/// ⚠ Cross-island always keeps `#uin@host`: `#500` here and `#500` on
/// is2.rcq.app are two different people, so a bare name there is ambiguous and
/// a reply could reach the wrong one. `/contacts` is where a contact's number
/// is looked up; it stays a bare-number list on purpose.
export function peerLabel(myUin: number, uin: number, host?: string): string {
  const name = knownName(myUin, uin, host)
  // Same-island contact: the name carries it, no number.
  if (!host && name && isContact(myUin, uin)) return name
  const handle = host ? `#${uin}@${host}` : `#${uin}`
  return name ? `${name} (${handle})` : handle
}

/// A group's name, falling back to its id only when we have never listed it.
export function groupLabel(myUin: number, gid: number): string {
  return lookupGroupName(myUin, gid) ?? tr('group.label', { gid })
}

export type Lookup =
  | { state: 'known'; info: UserInfo }
  /// The island answered: there is no such account. Almost always a typo.
  | { state: 'missing' }
  /// We could not ask (offline, rate-limited). NOT the same as "nobody there".
  | { state: 'unknown' }

const missing = new Set<number>()
const tried = new Set<number>()

/// How long one name lookup may hold a command. Node's fetch has no timeout
/// of its own, and this one sits in front of a SEND: an island that accepts
/// the connection and then says nothing must cost a few seconds and an honest
/// "could not ask", not the whole command.
const LOOKUP_MS = 6000

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
  })
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
}

/// Ask the island who a uin belongs to, and remember the name. Never throws.
export async function lookupUser(identity: WebIdentity, uin: number): Promise<Lookup> {
  if (missing.has(uin)) return { state: 'missing' }
  try {
    const info = await withDeadline(Api.userInfo(identity, uin), LOOKUP_MS)
    if (info?.nickname) learnName(identity.uin, uin, info.nickname)
    return { state: 'known', info }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      missing.add(uin)
      return { state: 'missing' }
    }
    return { state: 'unknown' }
  }
}

/// How many unknown senders one process will look up. /users/{uin}/info is
/// rate-limited at 180/min for good reason (it is the enumeration surface),
/// and a month-old backlog can hold a lot of unfamiliar names. Past the
/// budget the id stands in, which is what happened for every line before.
let lookupBudget = 40

/// The label for a line about to print, resolving the name first if that is
/// one cheap question. Never throws and never blocks on more than one request.
export async function labelForLine(identity: WebIdentity, uin: number, host?: string): Promise<string> {
  if (
    !host &&
    uin !== identity.uin &&
    lookupBudget > 0 &&
    !tried.has(uin) &&
    !knownName(identity.uin, uin)
  ) {
    lookupBudget--
    tried.add(uin)
    await lookupUser(identity, uin)
  }
  return peerLabel(identity.uin, uin, host)
}
