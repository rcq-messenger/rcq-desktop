// The rules behind blocking a sender on ANOTHER island (reports 1064, 1065).
//
// A person is a number plus a pinned signing key; the island is only where
// their mail comes from. The block list used to be a set of addresses, and the
// gate that decides whether a cross-island message reaches the chat never
// looked at it: a pinned contact under the pinned key was delivered whether
// blocked or not, so blocking an accepted contact here stopped their calls,
// their requests and their profile, and nothing they wrote. A block is now
// held against the address AND the keys it was made against, and a sender is
// blocked when either matches: the same person writing from their backup or
// their new primary island is still the person who was blocked.
//
// Every decision carries the time it was made, an unblock included (kept as a
// tombstone). Decisions travel between the account's own devices as `ciack`
// carbons, and a carbon can arrive late: re-served from the queue, or the echo
// of an older block arriving after the person already unblocked here. The
// strictly newer decision wins; an older one, or one with the same time,
// changes nothing (decisions made on this device are always dated past the
// one held, so a tie is only ever an echo or a remote decision).
//
// A block "by key only" (an impostor using a contact's address under another
// key) is never an address block, here or on the wire: the address belongs to
// the real contact. It travels as its own act (crossisland-ack.ts), which
// phones and older webs ignore, and it survives an address block laid over it
// and that address block's lifting.
//
// Pure: no store, no network. The store (crossisland-requests.ts) does the I/O
// and the offline test (cli/test/crossisland-block.mjs) holds these rules to
// the built bundle.

import { sameSigningKey } from './crossisland-gate'

export interface BlockEntry {
  /// Blocked (true) or lifted (false, a tombstone that only remembers when).
  on: boolean
  /// When the decision was made, ms since epoch. 0 for a block written before
  /// decisions were stamped: any stamped decision is newer than it.
  at: number
  /// Signing keys blocked together with the address: the pinned key of a
  /// contact, or the keys a request row's messages were sealed under.
  keys?: string[]
  /// Only the keys are blocked, not the address. Set for a request that came
  /// under a contact's address with another key (`keyMismatch`): blocking the
  /// address there would cut off the real contact it was impersonating.
  keyOnly?: boolean
  /// On an ADDRESS block only: the keys of key-only blocks at this address
  /// that the address block was laid over (they are in `keys` too). Lifting
  /// the address leaves them blocked: unblocking the contact is not unblocking
  /// the impostor who wrote as them.
  keyOnlyKeys?: string[]
}

export type BlockMap = Record<string, BlockEntry>

/// What a block or an unblock says, from this device or from another of ours.
///  * on, address: block the address, `keys` with it.
///  * on, keyOnly: block `keys` only, never the address.
///  * off, address: lift the address. A key-only block it was laid over
///    stays, minus `keys` (the key of the person being let through, if any).
///  * off, keyOnly: lift `keys` from the key-only blocks here, nothing else.
export interface BlockDecision {
  on: boolean
  at: number
  keys?: string[]
  keyOnly?: boolean
}

/// Keys kept per entry. A request row keeps four (crossisland-requests.ts
/// `MAX_SPUBS`), a contact one; the rest is headroom, not a target.
export const MAX_BLOCK_KEYS = 8
/// Tombstones kept. They only settle a late carbon against an unblock, which
/// arrives within the queue's thirty days or not at all; the oldest go first.
export const MAX_TOMBSTONES = 200

export function blockKey(uin: number, host: string): string {
  return `${uin}@${host.toLowerCase()}`
}

/// `uin@host` back into its parts. The host may be '' (a same-island stranger
/// blocked from the requests list) and never holds an `@`.
export function parseBlockKey(k: string): { uin: number; host: string } | null {
  const at = k.indexOf('@')
  if (at <= 0) return null
  const uin = Number(k.slice(0, at))
  if (!Number.isInteger(uin) || uin <= 0) return null
  return { uin, host: k.slice(at + 1) }
}

function cleanKeys(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const k of v) {
    if (typeof k !== 'string' || !k || k.length > 128) continue
    if (!out.some((x) => sameSigningKey(x, k))) out.push(k)
  }
  return out.slice(-MAX_BLOCK_KEYS)
}

/// Whatever the store holds, as entries. The first shape on disk was
/// `{ "uin@host": true }`: that is a block made before decisions were
/// stamped. Anything unreadable is left out rather than guessed at.
export function normalizeBlocks(raw: unknown): BlockMap {
  const out: BlockMap = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!parseBlockKey(k)) continue
    if (v === true) {
      out[k] = { on: true, at: 0 }
      continue
    }
    if (!v || typeof v !== 'object') continue
    const e = v as Record<string, unknown>
    if (typeof e.on !== 'boolean') continue
    const at = typeof e.at === 'number' && Number.isFinite(e.at) && e.at > 0 ? e.at : 0
    if (!e.on) {
      out[k] = { on: false, at }
      continue
    }
    const keys = cleanKeys(e.keys)
    // Key-only with no key would block nothing at all; read it as nothing.
    if (e.keyOnly === true && !keys.length) continue
    const ko = e.keyOnly === true ? [] : cleanKeys(e.keyOnlyKeys)
    out[k] = {
      on: true,
      at,
      ...(keys.length ? { keys } : {}),
      ...(e.keyOnly === true ? { keyOnly: true } : ko.length ? { keyOnlyKeys: ko } : {}),
    }
  }
  return out
}

function sameKeyIn(list: string[], k: string): boolean {
  return list.some((x) => sameSigningKey(x, k))
}

/// Apply one decision for (uin, host). Returns the new map, or null when it
/// changes nothing: a decision not newer than the one held (a late carbon, or
/// the echo of our own), a key-only block with no key in it, or the same state
/// again.
///
/// A block over a block merges: the keys add up, and an address block is never
/// narrowed to key-only by a later key-only one (both were asked for). The
/// key-only part is remembered under the address block (`keyOnlyKeys`), and
/// lifting the address leaves it standing.
export function decideBlock(map: BlockMap, uin: number, host: string, d: BlockDecision): BlockMap | null {
  const k = blockKey(uin, host)
  const cur = map[k]
  const at = Number.isFinite(d.at) && d.at > 0 ? d.at : 0
  // ⚠ Strictly newer. An equal time keeps what is held: with "later applied
  // wins" a block and its own echo stamped alike could undo the unblock made
  // in between. Decisions made here are dated past the held one
  // (crossisland-requests.ts `localDecisionAt`), so a tie is never a tap.
  if (cur && cur.at >= at) return null
  const held = cur?.on ? cur : null
  // The key-only part of what is held: the whole entry when it is key-only,
  // else what key-only blocks named before an address block was laid over.
  const heldKeyOnly = held ? ((held.keyOnly ? held.keys : held.keyOnlyKeys) ?? []) : []
  const named = cleanKeys(d.keys)
  let next: BlockEntry
  if (!d.on && d.keyOnly) {
    // Only keys a key-only block named come off: a key blocked with the
    // address stays as long as the address block does. Nothing to lift
    // writes nothing (no tombstone): a key decision is not the address's.
    const lifted = heldKeyOnly.filter((x) => sameKeyIn(named, x))
    if (!held || !lifted.length) return null
    const keys = (held.keys ?? []).filter((x) => !sameKeyIn(lifted, x))
    if (held.keyOnly) {
      next = keys.length ? { on: true, at, keys, keyOnly: true } : { on: false, at }
    } else {
      const ko = heldKeyOnly.filter((x) => !sameKeyIn(lifted, x))
      next = { on: true, at, ...(keys.length ? { keys } : {}), ...(ko.length ? { keyOnlyKeys: ko } : {}) }
    }
  } else if (!d.on) {
    // Written even with nothing to lift: carbons can arrive out of order, and
    // the older block that follows this unblock must find it here.
    if (!cur && at === 0) return null
    const keep = heldKeyOnly.filter((x) => !sameKeyIn(named, x))
    next = keep.length ? { on: true, at, keys: keep, keyOnly: true } : { on: false, at }
  } else {
    const keys = cleanKeys([...(held?.keys ?? []), ...named])
    const addressBefore = held != null && !held.keyOnly
    const keyOnly = d.keyOnly === true && !addressBefore
    if (keyOnly && keys.length === 0) return null
    const ko = keyOnly ? [] : cleanKeys([...heldKeyOnly, ...(d.keyOnly === true ? named : [])])
    next = {
      on: true,
      at,
      ...(keys.length ? { keys } : {}),
      ...(keyOnly ? { keyOnly: true } : ko.length ? { keyOnlyKeys: ko } : {}),
    }
  }
  if (cur && JSON.stringify(cur) === JSON.stringify(next)) return null
  const out: BlockMap = { ...map, [k]: next }
  return pruneTombstones(out)
}

function pruneTombstones(map: BlockMap): BlockMap {
  const dead = Object.entries(map).filter(([, e]) => !e.on)
  if (dead.length <= MAX_TOMBSTONES) return map
  dead.sort((a, b) => a[1].at - b[1].at)
  const out = { ...map }
  for (const [k] of dead.slice(0, dead.length - MAX_TOMBSTONES)) delete out[k]
  return out
}

/// Is the address itself blocked? A key-only entry does not block its address.
export function addressBlocked(map: BlockMap, uin: number, host: string): boolean {
  const e = map[blockKey(uin, host)]
  return e?.on === true && !e.keyOnly
}

/// The entries that block a sender: the address, or the key the seal verified
/// under. `pinnedKeyAt` answers which key is pinned for a blocked address, so a
/// block made before keys were kept still follows the contact it was made
/// against to their other islands.
///
/// ⚠ The key is only ever the one a seal PROVED (`spub`), or the key pinned
/// for a contact. `from`/`from_host` are unsigned in v=1; a match on the key is
/// what makes "the same person on another island" more than a claim.
export function blockingEntries(
  map: BlockMap,
  uin: number,
  host: string,
  signingKey: string | null | undefined,
  pinnedKeyAt: (uin: number, host: string) => string | null | undefined,
): string[] {
  const hits: string[] = []
  const own = blockKey(uin, host)
  for (const [k, e] of Object.entries(map)) {
    if (!e.on) continue
    if (k === own && !e.keyOnly) {
      hits.push(k)
      continue
    }
    if (!signingKey) continue
    if (e.keys?.some((x) => sameSigningKey(x, signingKey))) {
      hits.push(k)
      continue
    }
    if (e.keyOnly) continue
    const addr = parseBlockKey(k)
    if (!addr || addr.host === '') continue
    if (sameSigningKey(pinnedKeyAt(addr.uin, addr.host), signingKey)) hits.push(k)
  }
  return hits
}

export function senderBlocked(
  map: BlockMap,
  uin: number,
  host: string,
  signingKey: string | null | undefined,
  pinnedKeyAt: (uin: number, host: string) => string | null | undefined,
): boolean {
  return blockingEntries(map, uin, host, signingKey, pinnedKeyAt).length > 0
}

/// One lift that letting a sender through takes: an entry, and whether it is
/// the address that comes off or only keys a key-only block named.
export interface BlockLift {
  uin: number
  host: string
  keyOnly: boolean
  /// keyOnly: the keys to lift. Address: the sender's own key, let through
  /// from a key-only block laid under the address block too.
  keys?: string[]
}

/// What letting `uin@host` (proven or pinned key `signingKey`) through lifts.
///  * Their own address, blocked: the address. A key-only block under it
///    stays, unless it named this very key.
///  * An entry that holds their key as a key-only block (they were taken for
///    an impostor somewhere): that key there, never that address.
///  * Another address blocked by their key or its pinned key (the same person
///    on another of their islands): that address.
export function liftsFor(
  map: BlockMap,
  uin: number,
  host: string,
  signingKey: string | null | undefined,
  pinnedKeyAt: (uin: number, host: string) => string | null | undefined,
): BlockLift[] {
  const out: BlockLift[] = []
  const own = blockKey(uin, host)
  for (const k of blockingEntries(map, uin, host, signingKey, pinnedKeyAt)) {
    const a = parseBlockKey(k)
    const e = map[k]
    if (!a || !e) continue
    const ko = (e.keyOnly ? e.keys : e.keyOnlyKeys) ?? []
    const mine = signingKey ? ko.filter((x) => sameSigningKey(x, signingKey)) : []
    if (k === own && !e.keyOnly) out.push({ ...a, keyOnly: false, ...(mine.length ? { keys: mine } : {}) })
    else if (mine.length) out.push({ ...a, keyOnly: true, keys: mine })
    else out.push({ ...a, keyOnly: false })
  }
  return out
}

/// The blocks in force, newest first, for the list a person unblocks from.
export function activeBlocks(map: BlockMap): Array<{ uin: number; host: string; entry: BlockEntry }> {
  const out: Array<{ uin: number; host: string; entry: BlockEntry }> = []
  for (const [k, e] of Object.entries(map)) {
    if (!e.on) continue
    const a = parseBlockKey(k)
    if (a) out.push({ ...a, entry: e })
  }
  return out.sort((a, b) => b.entry.at - a.entry.at || (blockKey(a.uin, a.host) < blockKey(b.uin, b.host) ? -1 : 1))
}

/// The decision time a `ciack` carries: `ts` (ms since epoch, what Android
/// writes and reads, and what every client writes now), else `at` (what web
/// builds before it wrote). Neither: undefined, and the time it was received
/// stands in (`ackDecisionAt`).
export function ackStamp(ts: unknown, at: unknown): unknown {
  return typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : at
}

/// The time a block or unblock carried by a `ciack` carbon was made. Its own
/// stamp when it has one (`ackStamp`); else the island's deposit stamp of the
/// row, when it was received (the decision cannot be later than its deposit),
/// else now (a live frame). An older iOS sends no stamp at all.
export function ackDecisionAt(ackAt: unknown, srvAt: number | undefined, now: number): number {
  // Never later than the deposit, nor than now: a device whose clock runs
  // ahead must not stamp a block that outranks every unblock made after it.
  const ceiling = typeof srvAt === 'number' && Number.isFinite(srvAt) && srvAt > 0 ? Math.min(srvAt, now) : now
  if (typeof ackAt === 'number' && Number.isFinite(ackAt) && ackAt > 0) return Math.min(ackAt, ceiling)
  return ceiling
}

/// What a block or unblock `ciack` is about: the address, or keys only.
///  * `blockkey` / `unblockkey` (this build's acts for a key block, which
///    phones and older webs ignore), or `"scope": "key"` on any of the four,
///    or `keyOnly` (web builds of a few days): keys only.
///  * `block` / `unblock` with no scope, or `"scope": "address"`: the address.
///  * Any other scope: null, and the act is ignored. A scope this build does
///    not know is never guessed into an address block, which would cut off
///    whoever really owns that address.
export function ackBlockScope(act: unknown, scope: unknown, keyOnly: unknown): 'address' | 'key' | null {
  const keyAct = act === 'blockkey' || act === 'unblockkey'
  if (!keyAct && act !== 'block' && act !== 'unblock') return null
  if (scope === undefined || scope === null) return keyAct || keyOnly === true ? 'key' : 'address'
  if (scope === 'key') return 'key'
  if (scope === 'address' && !keyAct) return 'address'
  return null
}

/// The keys a `ciack` names, cleaned the same way the store cleans its own.
export function ackKeys(v: unknown): string[] {
  return cleanKeys(v)
}
