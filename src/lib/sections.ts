// Chat-list sections: the format, the merge and the caps.
//
// Founder item 1 of 23.08, built to docs/sections-design-2026-08-23.md. A
// section is a user-made bucket in the chat list. The list of sections (and
// which chat sits in which) lives in a SECOND vault slot, "sections", derived
// exactly like "contacts": the island stores 32 hex characters and a sealed
// blob and attaches no meaning to either.
//
// This file is pure. No I/O, no React, no localStorage: the transport is in
// sections-vault.ts and the cache in sections-store.ts, and everything here is
// a function from trees to trees so the merge can be tested on its own (and so
// the CLI can import it, which is where the tests run).
//
// ## Two rules that are easy to get wrong
//
// ⚠⚠ PATCH, DO NOT REBUILD. Every function here copies the decoded JSON tree
// and edits the keys it knows about. Nothing deserialises into a typed struct
// and re-serialises from scratch, because that silently deletes whatever a
// newer build, or another platform, wrote next to it. The types below are
// accessors over a plain object, not the shape of the object.
//
// ⚠⚠ A MEMBER KEY CARRIES THE HOST. A uin is per-island: `1234` here and
// `1234@is2.rcq.app` are two different people, and keying them the same has
// already cost us a bug (contact aliases, `aliasKey` in local-store.ts). A
// foreign group is worse: its LOCAL id is a negative alias allocated in
// first-sight order on each device (visited-islands.ts `aliasFor`), so it is
// not the same number in two browsers. The slot never holds an alias; it holds
// (remoteId, host), and the page translates at the edge.

const enc = new TextEncoder()

// -----------------------------------------------------------
// Shape
// -----------------------------------------------------------

/// One section record. Every field is optional because the tree is patched,
/// not rebuilt, and because a record written by another client may carry keys
/// this build has never heard of (kept by the index signature).
export interface SectionRecord {
  /// 8 lower-case hex from a CSPRNG for a user section; one of [BUILTIN_IDS]
  /// for a built-in.
  id: string
  /// `"u"` user-created, `"d"` built-in.
  k?: 'u' | 'd'
  /// Name. User sections only; built-in names are localised in the client.
  n?: string
  /// Order key, ascending, in steps of [ORDER_STEP]. Ties break by id.
  o?: number
  /// 1 = ask for the PIN before showing this section. The FLAG syncs; the
  /// protection is local and encrypts nothing (see the copy in i18n).
  p?: 0 | 1
  /// 1 = hidden. Reserved: nothing writes it in v1.
  h?: 0 | 1
  /// Per-field last-write times in ms. Absent key reads as 0. This is what
  /// [merge] compares, so a rename on one device and a reorder on another
  /// both survive.
  t?: { n?: number; o?: number; p?: number; h?: number }
  /// Membership: member key -> added-at ms.
  m?: Record<string, number>
  /// Member tombstones: member key -> removed-at ms. Dropped after 90 days.
  x?: Record<string, number>
  [extra: string]: unknown
}

export interface SectionsTree {
  v: number
  s: SectionRecord[]
  /// Section tombstones: section id -> deleted-at ms.
  d?: Record<string, number>
  /// Last write time, ms. Informational; never merged on.
  w?: number
  [extra: string]: unknown
}

/// Ids the three clients agree on, so the order of the built-in sections
/// syncs even though their membership is derived rather than stored.
export const SYS_SAVED = 'sys.saved'
export const SYS_FAV = 'sys.fav'
export const SYS_CI = 'sys.ci'
export const SYS_GROUPS = 'sys.groups'
export const SYS_ONLINE = 'sys.online'
export const SYS_OFFLINE = 'sys.offline'
export const SYS_ARCHIVE = 'sys.archive'

/// Default order for a built-in that has no record yet. A client that does not
/// RENDER one of these (Saved Messages is a section on Android and a pinned row
/// here) still keeps its record and writes it back: dropping it would delete
/// another client's setting.
export const DEFAULT_ORDER: Record<string, number> = {
  [SYS_SAVED]: 0,
  [SYS_FAV]: 1024,
  [SYS_CI]: 2048,
  [SYS_GROUPS]: 3072,
  [SYS_ONLINE]: 4096,
  [SYS_OFFLINE]: 5120,
  [SYS_ARCHIVE]: 6144,
}

export const BUILTIN_IDS = Object.keys(DEFAULT_ORDER)

export const ORDER_STEP = 1024

// Caps, enforced in the UI, all well under the island's ceiling. The island
// caps a slot at 256 KB decoded; the seal costs 1 + 12 + 16 bytes and pads to a
// 512-byte boundary with a 4-byte length prefix, so the JSON ceiling is
// 261 628 bytes. Worst case at these caps is under 170 KB.
export const MAX_SECTIONS = 64
export const MAX_MEMBERS_PER_SECTION = 512
export const MAX_MEMBERS_TOTAL = 4096
export const MAX_NAME_SCALARS = 32
/// Refuse to write above this, after dropping expired tombstones. Never
/// truncate, never silently drop a member, never hand the island a blob it
/// will 413.
export const MAX_WRITE_BYTES = 200 * 1024
export const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000

export type SectionsErrorCode =
  | 'too_many_sections'
  | 'section_full'
  | 'too_many_members'
  | 'too_large'
  | 'unreadable'

export class SectionsError extends Error {
  constructor(public code: SectionsErrorCode) {
    super(code)
  }
}

export function emptyTree(): SectionsTree {
  return { v: 1, s: [], d: {}, w: 0 }
}

// -----------------------------------------------------------
// Member keys
// -----------------------------------------------------------

/// `p:<uin>` on our own island, `p:<uin>@<host>` for a peer on another one.
export function peerKey(uin: number, host?: string | null): string {
  return host ? `p:${uin}@${host.toLowerCase()}` : `p:${uin}`
}

/// `g:<id>` for a group on our island, `g:<remoteId>@<host>` for a foreign one.
/// ⚠ `remoteId` is the id on ITS island, never the negative local alias.
export function groupKey(remoteId: number, host?: string | null): string {
  return host ? `g:${remoteId}@${host.toLowerCase()}` : `g:${remoteId}`
}

export function isGroupKey(key: string): boolean {
  return key.startsWith('g:')
}

// -----------------------------------------------------------
// Codec
// -----------------------------------------------------------

/// Decode a slot's plaintext.
///
/// Returns null for "this build cannot read it": a `v` above 1, or bytes that
/// are not the tree at all. The caller then renders the built-in sections and
/// NEVER writes the slot. ⚠ This is deliberately not the contacts slot's rule
/// ("unknown version reads as empty"): that rule overwrites, and overwriting
/// here would erase the sections the user made on a newer client.
///
/// An absent slot (the island has nothing) is an empty tree, which is
/// readable and writable.
export function decode(plaintext: Uint8Array | null): SectionsTree | null {
  if (!plaintext) return emptyTree()
  let j: unknown
  try {
    j = JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    return null
  }
  if (!j || typeof j !== 'object') return null
  const o = j as Partial<SectionsTree>
  if (o.v !== 1) return null
  if (!Array.isArray(o.s)) return null
  const s = o.s.filter((r): r is SectionRecord => !!r && typeof r === 'object' && typeof r.id === 'string')
  return { ...(j as SectionsTree), v: 1, s, d: plainMap(o.d), w: typeof o.w === 'number' ? o.w : 0 }
}

export function encode(tree: SectionsTree): Uint8Array {
  return enc.encode(JSON.stringify(tree))
}

export function treeBytes(tree: SectionsTree): number {
  return enc.encode(JSON.stringify(tree)).length
}

function plainMap(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n
  }
  return out
}

// -----------------------------------------------------------
// Merge
// -----------------------------------------------------------

/// The whole of the conflict story, in one commutative, idempotent function.
///
/// Both paths use it: the read path folds what the island serves into the
/// cache (`cache = merge(cache, remote)`), and the write path folds the cache
/// into what the island holds right now, inside the read-merge-write loop that
/// vault.ts already owns (`next = merge(decode(remote), cache)`).
///
/// Per-FIELD last-writer-wins, so a rename on the phone and a reorder on the
/// desktop both survive. Equal timestamps with different values fall back to
/// "the larger value wins", which exists only to keep the function commutative
/// and is never the interesting case.
export function merge(a: SectionsTree, b: SectionsTree): SectionsTree {
  if (a.v > 1 || b.v > 1) throw new SectionsError('unreadable')
  const d: Record<string, number> = { ...plainMap(a.d) }
  for (const [id, ts] of Object.entries(plainMap(b.d))) d[id] = Math.max(d[id] ?? 0, ts)

  const byId = new Map<string, SectionRecord>()
  for (const r of a.s) byId.set(r.id, r)
  for (const r of b.s) {
    const cur = byId.get(r.id)
    byId.set(r.id, cur ? mergeRecord(cur, r) : r)
  }

  // A tombstone only wins over a record nobody has touched since: a section
  // deleted here and renamed there comes back, named.
  const kept: SectionRecord[] = []
  for (const r of byId.values()) {
    const dead = d[r.id]
    if (dead !== undefined && dead >= newestStamp(r)) continue
    kept.push(r)
  }

  // One chat lives in exactly one user section (§7). Two devices that filed the
  // same chat differently while offline are resolved here rather than by
  // whoever renders last: the larger add ts wins, ties go to the smaller id,
  // and the losers get a tombstone at the same ts so the outcome survives the
  // next merge from either side.
  const owner = new Map<string, { id: string; ts: number }>()
  for (const r of kept) {
    if (r.k === 'd') continue
    for (const [key, ts] of Object.entries(plainMap(r.m))) {
      const cur = owner.get(key)
      if (!cur || ts > cur.ts || (ts === cur.ts && r.id < cur.id)) owner.set(key, { id: r.id, ts })
    }
  }
  const out: SectionRecord[] = kept.map((r) => {
    if (r.k === 'd') return r
    const m = plainMap(r.m)
    let moved: SectionRecord | null = null
    for (const [key, ts] of Object.entries(m)) {
      const own = owner.get(key)
      if (own && own.id !== r.id) {
        moved = moved ?? { ...r, m: { ...m }, x: { ...plainMap(r.x) } }
        delete (moved.m as Record<string, number>)[key]
        const x = moved.x as Record<string, number>
        x[key] = Math.max(x[key] ?? 0, ts)
      }
    }
    return moved ?? r
  })

  out.sort((x, y) => orderOf(x) - orderOf(y) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  return {
    ...mergeUnknownTop(a, b),
    v: 1,
    s: out,
    d,
    w: Math.max(a.w ?? 0, b.w ?? 0),
  }
}

/// The newest thing anyone claims to have USED this record for. A section
/// tombstone older than this loses: somebody was working in the section after
/// it was deleted, which is a resurrection on purpose.
///
/// ⚠ Member TOMBSTONES (`x`) are deliberately not counted, and counting them
/// was a real bug: unticking one chat in a section's picker on an offline
/// device stamps `x` and nothing else, so it read as "the section was touched"
/// and brought a section deleted on the other device back from the dead,
/// stably, carrying whatever was left in it. Emptying a section is not a
/// reason to keep it. Adds (`m`) do count: filing a chat into a section is
/// somebody using it, and the alternative loses their filing entirely.
///
/// ⚠⚠ This is `max(t.*, m.*)` and the design doc (§2) says the same in the
/// same words. The three clients each implement this line; two that disagree
/// about one section do not merely render differently, they write the slot
/// back and forth at each other until the island 429s.
function newestStamp(r: SectionRecord): number {
  const t = r.t ?? {}
  let n = Math.max(t.n ?? 0, t.o ?? 0, t.p ?? 0, t.h ?? 0)
  for (const ts of Object.values(plainMap(r.m))) n = Math.max(n, ts)
  return n
}

function mergeRecord(a: SectionRecord, b: SectionRecord): SectionRecord {
  const ta = a.t ?? {}
  const tb = b.t ?? {}
  // Unknown keys first, so the fields below always win over a same-named
  // stranger, and so a key only one side knows about survives untouched.
  const out: SectionRecord = { ...mergeUnknown(a, b), id: a.id }
  out.k = (pickLarger(a.k, b.k) as 'u' | 'd' | undefined) ?? undefined
  if (out.k === undefined) delete out.k
  assignField(out, 'n', a.n, b.n, ta.n ?? 0, tb.n ?? 0)
  assignField(out, 'o', a.o, b.o, ta.o ?? 0, tb.o ?? 0)
  assignField(out, 'p', a.p, b.p, ta.p ?? 0, tb.p ?? 0)
  assignField(out, 'h', a.h, b.h, ta.h ?? 0, tb.h ?? 0)
  const t: NonNullable<SectionRecord['t']> = {}
  for (const f of ['n', 'o', 'p', 'h'] as const) {
    const v = Math.max(ta[f] ?? 0, tb[f] ?? 0)
    if (v > 0) t[f] = v
  }
  out.t = t
  const { m, x } = mergeMembers(plainMap(a.m), plainMap(a.x), plainMap(b.m), plainMap(b.x))
  if (Object.keys(m).length > 0 || a.m || b.m) out.m = m
  if (Object.keys(x).length > 0 || a.x || b.x) out.x = x
  return out
}

/// Add versus tombstone: the larger ts wins, and ON A TIE THE TOMBSTONE WINS.
/// A removal racing an add leaves the chat out of the section, which the user
/// can undo by adding it again; a chat resurrected into a section the user
/// emptied is the version nobody can undo by hand.
function mergeMembers(
  am: Record<string, number>,
  ax: Record<string, number>,
  bm: Record<string, number>,
  bx: Record<string, number>,
): { m: Record<string, number>; x: Record<string, number> } {
  const adds: Record<string, number> = {}
  const dels: Record<string, number> = {}
  for (const [k, ts] of Object.entries(am)) adds[k] = Math.max(adds[k] ?? 0, ts)
  for (const [k, ts] of Object.entries(bm)) adds[k] = Math.max(adds[k] ?? 0, ts)
  for (const [k, ts] of Object.entries(ax)) dels[k] = Math.max(dels[k] ?? 0, ts)
  for (const [k, ts] of Object.entries(bx)) dels[k] = Math.max(dels[k] ?? 0, ts)
  const m: Record<string, number> = {}
  for (const [k, ts] of Object.entries(adds)) {
    const gone = dels[k]
    if (gone !== undefined && gone >= ts) continue
    m[k] = ts
  }
  return { m, x: dels }
}

function assignField<K extends 'n' | 'o' | 'p' | 'h'>(
  out: SectionRecord,
  field: K,
  av: SectionRecord[K],
  bv: SectionRecord[K],
  at: number,
  bt: number,
) {
  const v = at === bt ? pickLarger(av, bv) : at > bt ? av : bv
  // `?? undefined` in spirit: a JSON `null` is an absent value here, see
  // `pickLarger`, and writing it back as `null` would leave the field on the
  // record for the next merge to read as a value again.
  if (v === undefined || v === null) delete out[field]
  else (out as Record<string, unknown>)[field] = v
}

/// Deterministic tie-break, identical on every client: numbers numerically,
/// strings by UTF-8 byte order (NOT by JS `<`, which compares UTF-16 units and
/// disagrees about surrogate pairs), 1 > 0, and anything else by its JSON.
///
/// ⚠⚠ A JSON `null` IS AN ABSENT VALUE HERE, on both sides, exactly like a
/// missing key (design §2). It has to be spelled out because the platforms do
/// not agree on their own: a key a Swift-style encoder wrote for a nil optional
/// arrives as `null` rather than missing, and ranking that `null` by
/// `JSON.stringify` instead makes `"null"` beat almost every real value, since
/// `n` (0x6e) is above every digit and above `"`. On `k`, which has NO
/// timestamp and is therefore always decided right here, that silently deletes
/// `k === 'u'`: the section drops out of `userSections`/`memberIndex`, its
/// filed chats fall back to their derived sections, and this client and the one
/// that kept the value then disagree about the content of the tree forever,
/// each concluding the island is missing something of its own and pushing,
/// until the account's 240 puts an hour run out.
function pickLarger<T>(a: T, b: T): T {
  if (a === undefined || a === null) return b
  if (b === undefined || b === null) return a
  if (typeof a === 'number' && typeof b === 'number') return a >= b ? a : b
  if (typeof a === 'string' && typeof b === 'string') return utf8Greater(a, b) ? a : b
  const ja = JSON.stringify(a) ?? ''
  const jb = JSON.stringify(b) ?? ''
  return utf8Greater(ja, jb) ? a : b
}

function utf8Greater(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i] > y[i]
  }
  return x.length >= y.length
}

/// Keys neither this build nor the merge above knows about. They belong to a
/// newer client and are carried through untouched (§2.1: patch, do not
/// rebuild). A key both sides carry with different values is settled by the
/// same deterministic tie-break the fields use, because an unknown key has no
/// timestamp to compare and the merge still has to be commutative.
function mergeUnknown(a: SectionRecord, b: SectionRecord): Record<string, unknown> {
  return mergeUnknownKeys(a, b, ['id', 'k', 'n', 'o', 'p', 'h', 't', 'm', 'x'])
}

function mergeUnknownTop(a: SectionsTree, b: SectionsTree): Record<string, unknown> {
  return mergeUnknownKeys(a, b, ['v', 's', 'd', 'w'])
}

function mergeUnknownKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  known: string[],
): Record<string, unknown> {
  const skip = new Set(known)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(a)) if (!skip.has(k)) out[k] = v
  for (const [k, v] of Object.entries(b)) {
    if (skip.has(k)) continue
    out[k] = k in out ? pickLarger(out[k], v) : v
  }
  return out
}

// -----------------------------------------------------------
// Reads
// -----------------------------------------------------------

export function orderOf(r: SectionRecord): number {
  if (typeof r.o === 'number' && Number.isFinite(r.o)) return r.o
  return DEFAULT_ORDER[r.id] ?? (BUILTIN_IDS.length + 1) * ORDER_STEP
}

export function recordFor(tree: SectionsTree, id: string): SectionRecord | undefined {
  return tree.s.find((r) => r.id === id)
}

/// Every section this client should draw, built-ins included (synthesised at
/// their default order when the slot has no record for them), in the one total
/// order every device agrees on: `o` ascending, ties by id.
export function orderedSections(tree: SectionsTree): SectionRecord[] {
  const out = tree.s.filter((r) => r.k !== 'u' || typeof r.n === 'string').slice()
  for (const id of BUILTIN_IDS) {
    if (!out.some((r) => r.id === id)) out.push({ id, k: 'd', o: DEFAULT_ORDER[id] })
  }
  return out.sort((a, b) => orderOf(a) - orderOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function userSections(tree: SectionsTree): SectionRecord[] {
  return orderedSections(tree).filter((r) => r.k === 'u')
}

export function isPinned(tree: SectionsTree, id: string): boolean {
  return recordFor(tree, id)?.p === 1
}

/// member key -> the id of the user section holding it. The merge guarantees
/// one section per key, so this is a function and not a multimap.
export function memberIndex(tree: SectionsTree): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of tree.s) {
    if (r.k !== 'u') continue
    for (const key of Object.keys(plainMap(r.m))) out.set(key, r.id)
  }
  return out
}

export function membersOf(tree: SectionsTree, id: string): string[] {
  return Object.keys(plainMap(recordFor(tree, id)?.m))
}

export function totalMembers(tree: SectionsTree): number {
  let n = 0
  for (const r of tree.s) if (r.k === 'u') n += Object.keys(plainMap(r.m)).length
  return n
}

export function sameTree(a: SectionsTree, b: SectionsTree): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/// `JSON.stringify` with every object key sorted, at every depth.
///
/// ⚠⚠ The depth is the whole point, and doing it by hand is why this is not
/// `JSON.stringify(x, Object.keys(x).sort())`: `merge` normalises the RECORD
/// array and the record's own key sequence, and nothing normalises the key
/// order inside `m`, `x` and `d`. Those are maps keyed by chat and by section
/// id, they are built by walking whatever order the two sides happened to hold
/// (`mergeMembers` seeds from `a` first, so `merge(x, x)` preserves x's), and a
/// stringify comparison then answers "different" about two trees that agree on
/// every member of every section.
///
/// A stranger's container is sorted here too. That is safe BECAUSE these bytes
/// are never written: `encode` still serialises the tree as it stands, so
/// another build's object is put back in the order it arrived in.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/// Do these two trees SAY the same thing? `merge(x, x)` is the identity on
/// content and puts every record, and every key inside a record, in the one
/// order all merge output has; sorting the rest of the keys takes out the one
/// piece of order the merge does not own.
///
/// ⚠ Use this, not `sameTree`, to decide whether to WRITE. A blob written by
/// Android or iOS orders its JSON their way, and a byte comparison then says
/// "different" about a tree that is identical: this client rewrites it in its
/// own order, the other client rewrites it back, and two devices that both do
/// that spend the account's 240 puts an hour telling each other nothing. iOS
/// answers this question over `.sortedKeys` bytes, so a comparison that reads
/// the order of `m` is not merely wasteful, it DISAGREES with iOS about the
/// same pair of trees: the phone settles and the browser pushes forever.
export function sameContent(a: SectionsTree, b: SectionsTree): boolean {
  return canonicalJson(merge(a, a)) === canonicalJson(merge(b, b))
}

// -----------------------------------------------------------
// Writes. Every one of these returns a NEW tree and mutates nothing.
// -----------------------------------------------------------

/// ⚠ Clamp by SCALARS, not by UTF-16 units and not by bytes. The pinned-message
/// 422 (22.08) was exactly this: a slot measured in one unit and filled in
/// another, on all three clients at once.
export function clampName(name: string): string {
  return Array.from(name.trim()).slice(0, MAX_NAME_SCALARS).join('')
}

export function newSectionId(): string {
  const b = new Uint8Array(4)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/// ⚠ The one place a record is edited. It copies the record and hands the copy
/// to `edit`, so every key this build does not know about rides along. A
/// record for a built-in that the slot has never carried is created here, which
/// is how `sys.archive` gets a `p` without anybody having to seed the tree.
function patch(
  tree: SectionsTree,
  id: string,
  now: number,
  edit: (r: SectionRecord) => SectionRecord,
): SectionsTree {
  let found = false
  const s = tree.s.map((r) => {
    if (r.id !== id) return r
    found = true
    return edit({ ...r })
  })
  if (!found) s.push(edit({ id }))
  return { ...tree, s, w: now }
}

/// ⚠ The cap counts the sections that EXIST, not the ones that ever existed.
/// Counting tombstones too (which is what this line did until the review of
/// 23.08, and what the design doc asked for) dead-ends the feature on pure
/// churn: make and delete 64 sections while trying out names and the next
/// "new section" is refused with "that is as many sections as one account can
/// hold" while the screen shows none at all, on every device, for 90 days,
/// with no action that clears it. Tombstones are bounded instead, by
/// [dropExpired], which keeps the newest [MAX_SECTIONS] of them.
export function createSection(tree: SectionsTree, name: string, now = Date.now()): SectionsTree {
  if (tree.s.length >= MAX_SECTIONS) {
    throw new SectionsError('too_many_sections')
  }
  const id = newSectionId()
  const top = orderedSections(tree).reduce((max, r) => Math.max(max, orderOf(r)), 0)
  const rec: SectionRecord = {
    id,
    k: 'u',
    n: clampName(name),
    o: top + ORDER_STEP,
    t: { n: now, o: now },
    m: {},
    x: {},
  }
  return { ...tree, s: [...tree.s, rec], w: now }
}

export function renameSection(tree: SectionsTree, id: string, name: string, now = Date.now()): SectionsTree {
  return patch(tree, id, now, (r) => ({ ...r, n: clampName(name), t: { ...r.t, n: now } }))
}

export function setPinned(tree: SectionsTree, id: string, on: boolean, now = Date.now()): SectionsTree {
  return patch(tree, id, now, (r) => ({
    ...r,
    k: r.k ?? (BUILTIN_IDS.includes(id) ? 'd' : 'u'),
    p: on ? 1 : 0,
    t: { ...r.t, p: now },
  }))
}

/// Delete a user section. The chats are not touched: they fall back into their
/// derived sections on the next render.
export function deleteSection(tree: SectionsTree, id: string, now = Date.now()): SectionsTree {
  return {
    ...tree,
    s: tree.s.filter((r) => r.id !== id),
    d: { ...plainMap(tree.d), [id]: now },
    w: now,
  }
}

/// Apply a whole new order at once (a drop, or a renormalise). Every section
/// that MOVES gets `t.o = now`; the ones that did not move are left alone so
/// they do not stamp over another device's reorder.
export function setOrder(tree: SectionsTree, orders: Map<string, number>, now = Date.now()): SectionsTree {
  let out = tree
  for (const [id, o] of orders) {
    const cur = recordFor(out, id)
    if (cur && orderOf(cur) === o && typeof cur.o === 'number') continue
    out = patch(out, id, now, (r) => ({
      ...r,
      k: r.k ?? (BUILTIN_IDS.includes(id) ? 'd' : 'u'),
      o,
      t: { ...r.t, o: now },
    }))
  }
  return { ...out, w: now }
}

/// File chats into a section. One write for the whole picker sheet.
///
/// A key that sits in another user section is moved: removed there with a
/// tombstone at the same ts, added here. That is the same outcome [merge]
/// would compute, done locally so the UI does not flicker through a state
/// where the chat is in two places.
export function addMembers(tree: SectionsTree, id: string, keys: string[], now = Date.now()): SectionsTree {
  const rec = recordFor(tree, id)
  const cur = plainMap(rec?.m)
  const fresh = keys.filter((k) => cur[k] === undefined)
  if (Object.keys(cur).length + fresh.length > MAX_MEMBERS_PER_SECTION) throw new SectionsError('section_full')
  if (totalMembers(tree) + fresh.length > MAX_MEMBERS_TOTAL) throw new SectionsError('too_many_members')
  let out = tree
  for (const key of fresh) {
    const holder = memberIndex(out).get(key)
    if (holder && holder !== id) out = removeMemberFrom(out, holder, key, now)
  }
  return patch(out, id, now, (r) => {
    const m = { ...plainMap(r.m) }
    const x = { ...plainMap(r.x) }
    for (const key of keys) {
      m[key] = m[key] ?? now
      delete x[key]
    }
    return { ...r, k: r.k ?? 'u', m, x }
  })
}

export function removeMemberFrom(tree: SectionsTree, id: string, key: string, now = Date.now()): SectionsTree {
  return patch(tree, id, now, (r) => {
    const m = { ...plainMap(r.m) }
    const x = { ...plainMap(r.x) }
    delete m[key]
    x[key] = now
    return { ...r, m, x }
  })
}

/// Take a chat out of whatever section holds it. This is the ONLY pruning
/// there is, and it happens on an explicit local action: removing a contact,
/// leaving a group, deleting a cross-island peer.
///
/// ⚠ Never prune because a chat did not resolve while rendering. A second
/// device that has not synced yet, or one failed roster fetch, would then
/// delete the membership for the whole account. That is the hazard the
/// contacts mirror was written around, and it is worse here: there is no
/// server-side list to rebuild from.
export function forgetMember(tree: SectionsTree, key: string, now = Date.now()): SectionsTree | null {
  const holder = memberIndex(tree).get(key)
  if (!holder) return null
  return removeMemberFrom(tree, holder, key, now)
}

/// Stamp the tree as touched without changing anything anybody can see.
///
/// It exists for one reason and it is not cosmetic: see the write-timing note
/// in `sections-vault.ts forgetSectionMember`. A slot that is written only
/// when the removed chat happened to be filed tells the island which removals
/// were filed, and `w` is the cheapest way to make the other case produce a
/// write too. `w` is informational and merges by `max`, so a client that
/// receives one has nothing to do about it.
export function touchTree(tree: SectionsTree, now = Date.now()): SectionsTree {
  return { ...tree, w: now }
}

/// Drop expired tombstones. Called before every write, never on read: a read
/// that pruned would fight with a device whose clock is behind.
///
/// Age is not the only bound. Churn inside the 90 days is: a section whose
/// membership is edited every day accumulates an `x` entry per removal, and a
/// slot that grows past [MAX_WRITE_BYTES] stops being writable at all, which
/// is a worse failure than forgetting the oldest removal. So both maps are
/// also capped by COUNT, newest kept: [MAX_SECTIONS] section tombstones and
/// [MAX_MEMBERS_PER_SECTION] member tombstones per section.
export function dropExpired(tree: SectionsTree, now = Date.now()): SectionsTree {
  const d = newestFew(plainMap(tree.d), now, MAX_SECTIONS)
  const s = tree.s.map((r) => {
    const x = plainMap(r.x)
    const keep = newestFew(x, now, MAX_MEMBERS_PER_SECTION)
    return Object.keys(keep).length === Object.keys(x).length ? r : { ...r, x: keep }
  })
  return { ...tree, s, d }
}

/// The `cap` newest entries of a tombstone map that are also inside the TTL,
/// in the map's OWN key order: which entries survive is decided by age, and
/// the order they are written in is left alone, because `sameTree` compares
/// the serialised JSON and a reshuffle there is a write nobody asked for.
function newestFew(map: Record<string, number>, now: number, cap: number): Record<string, number> {
  const live = Object.entries(map).filter(([, ts]) => now - ts <= TOMBSTONE_TTL_MS)
  let keep: Set<string> | null = null
  if (live.length > cap) {
    // Newest first, ties by key so every client drops the same ones.
    const ranked = live.slice().sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    keep = new Set(ranked.slice(0, cap).map(([k]) => k))
  }
  const out: Record<string, number> = {}
  for (const [k, ts] of live) if (!keep || keep.has(k)) out[k] = ts
  return out
}

/// The last gate before the seal. Refuse rather than truncate: a slot the
/// island 413s is a slot that stops syncing for everyone.
export function assertWritable(tree: SectionsTree): void {
  if (treeBytes(tree) > MAX_WRITE_BYTES) throw new SectionsError('too_large')
}
