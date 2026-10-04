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
// newer decision wins; an older one changes nothing.
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
}

export type BlockMap = Record<string, BlockEntry>

/// What a block or an unblock says, from this device or from another of ours.
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
    out[k] = {
      on: true,
      at,
      ...(keys.length ? { keys } : {}),
      ...(e.keyOnly === true ? { keyOnly: true } : {}),
    }
  }
  return out
}

/// Apply one decision for (uin, host). Returns the new map, or null when it
/// changes nothing: an older decision than the one held (a late carbon), a
/// key-only block with no key in it, or the same state again.
///
/// A block over a block merges: the keys add up, and an address block is never
/// narrowed to key-only by a later key-only one (both were asked for).
export function decideBlock(map: BlockMap, uin: number, host: string, d: BlockDecision): BlockMap | null {
  const k = blockKey(uin, host)
  const cur = map[k]
  const at = Number.isFinite(d.at) && d.at > 0 ? d.at : 0
  if (cur && cur.at > at) return null
  let next: BlockEntry
  if (!d.on) {
    // Written even with nothing to lift: carbons can arrive out of order, and
    // the older block that follows this unblock must find it here.
    if (!cur && at === 0) return null
    next = { on: false, at }
  } else {
    const keys = cleanKeys([...(cur?.on ? (cur.keys ?? []) : []), ...(d.keys ?? [])])
    const addressBefore = cur?.on === true && !cur.keyOnly
    const keyOnly = d.keyOnly === true && !addressBefore
    if (keyOnly && keys.length === 0) return null
    next = {
      on: true,
      at,
      ...(keys.length ? { keys } : {}),
      ...(keyOnly ? { keyOnly: true } : {}),
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

/// The time a block or unblock carried by a `ciack` carbon was made. Its own
/// stamp when it has one; else the island's deposit stamp of the row (the
/// decision cannot be later than its deposit), else now (a live frame). An
/// older Android or iOS sends no stamp at all.
export function ackDecisionAt(ackAt: unknown, srvAt: number | undefined, now: number): number {
  // Never later than the deposit, nor than now: a device whose clock runs
  // ahead must not stamp a block that outranks every unblock made after it.
  const ceiling = typeof srvAt === 'number' && Number.isFinite(srvAt) && srvAt > 0 ? Math.min(srvAt, now) : now
  if (typeof ackAt === 'number' && Number.isFinite(ackAt) && ackAt > 0) return Math.min(ackAt, ceiling)
  return ceiling
}

/// The keys a `ciack` names, cleaned the same way the store cleans its own.
export function ackKeys(v: unknown): string[] {
  return cleanKeys(v)
}
