// Cross-island contacts in the vault (federation Layer B meets stage 4).
//
// `crossisland-store.ts` is the ONLY record that a peer on another island
// exists: there is no server-side row for them, because `/contacts` holds
// flagship users and a peer on another island is not one. That store is
// localStorage. So: clear the browser, reinstall the desktop app, or simply
// pick up the second device, and every cross-island contact is gone, with the
// peer's pinned keys, and the only way back is to ask them for their number
// again. Same-island contacts have survived this since stage 4; these did not.
//
// This module gives them the same slot treatment the sections tree gets, and
// deliberately NOT the treatment the contact list gets:
//
//   * `contacts` is a MIRROR. The island's list is the truth and the slot is a
//     sealed copy of it, so the merge is server-wins.
//   * this slot is the TRUTH. Nothing else in the world holds these rows, so
//     the merge is a two-way union of what the devices know, and a write that
//     failed is retried by the next read (the same trick sections uses: if
//     folding our copy into the island's copy changes the island's copy, the
//     island is missing something of ours).
//
// ⚠⚠ The pinned keys are the whole point and the one thing a merge must not
// get wrong. `identityKey` / `signingKey` / `signalIdentityKey` come from the
// peer's island key card at the moment we added them, and everything we ever
// verify about that peer is checked against them. So the merge is
// TRUST-ON-FIRST-USE across devices: when both sides hold the same handle, the
// keys come from the row with the EARLIER `addedAt`, never from the newer one.
// A second device cannot re-pin a peer to a different key by adding them
// again, which is exactly what an island that hands out a swapped key card
// would need it to do.
//
// Display fields (name, avatar, gender, status) move the other way: they carry
// their own `profileTs` from the peer's §5e envelope and the newest wins,
// which is the same rule `applyCrossIslandProfile` already uses on one device.

import type { WebIdentity } from './crypto'
import { scopedKey } from './account-scope'
import { fetchServerInfo } from './server-info'
import {
  bytesJson,
  jsonBytes,
  lastSeenVersion,
  readSlot,
  rememberVersion,
  slotId,
  VAULT_CROSSISLAND,
  VaultError,
  writeSlot,
} from './vault'
import {
  ciKey,
  listCrossIsland,
  replaceAllCrossIsland,
  type CrossIslandContact,
} from './crossisland-store'

export interface VaultCrossIsland {
  v: 1
  /// By `uin@host`, the same key the local store uses.
  c: Record<string, CrossIslandContact>
  /// Tombstones by `uin@host`: when the row was last removed (ms).
  g: Record<string, number>
}

const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000

/// Refuse to grow past this. The island's cap is 256 KiB decoded and a write
/// over it is a permanent 413, i.e. a sync that never works again and says
/// nothing. A row is ~250 bytes, so this is a few hundred cross-island
/// contacts; whoever gets there keeps every row locally and loses only the
/// backup, which is the mild half of the failure.
const MAX_ROWS = 600

let rolledBackFor: number | null = null

/// `vault_reset`: another device rotated the identity these slot names and
/// keys are derived from. Stop, keep the local rows (they are the only copy).
export function retireCrossIslandSync(uin: number): void {
  rolledBackFor = uin
}

/// Account switch inside one tab.
export function resetCrossIslandSyncState(): void {
  rolledBackFor = null
}

export function lastSeenCrossIslandVersion(identity: WebIdentity): number {
  return lastSeenVersion(slotId(identity, VAULT_CROSSISLAND))
}

function empty(): VaultCrossIsland {
  return { v: 1, c: {}, g: {} }
}

/// Decode a slot. `null` means "written by a newer build": the caller must
/// then leave the slot alone rather than overwrite what it cannot read.
function decode(p: Uint8Array | null): VaultCrossIsland | null {
  if (!p) return empty()
  try {
    const j = bytesJson<Partial<VaultCrossIsland>>(p)
    if (j && j.v === 1 && j.c && typeof j.c === 'object') {
      return { v: 1, c: j.c, g: j.g && typeof j.g === 'object' ? j.g : {} }
    }
    if (j && typeof j.v === 'number' && j.v > 1) return null
  } catch {
    /* fall through */
  }
  return empty()
}

function updatedAt(r: CrossIslandContact): number {
  // `profileTs` is epoch SECONDS (it comes off the wire that way); `addedAt`
  // is ms. Compare in ms.
  const p = typeof r.profileTs === 'number' && Number.isFinite(r.profileTs) ? r.profileTs * 1000 : 0
  return Math.max(r.addedAt || 0, p)
}

/// Every row leaving the merge goes through here, including the ones only one
/// device has. ⚠ Not only the combined ones: `applyCrossIslandProfile` keeps
/// the avatar id and its key as a pair, and a row that has been sitting in a
/// slot since before that rule could carry half of one. Half a pair names a
/// blob nobody can open, so the UI would render a broken picture forever.
function normalize(r: CrossIslandContact): CrossIslandContact {
  const paired = !!(r.avatarMediaId && r.avatarMediaKey)
  return {
    ...r,
    signalIdentityKey: r.signalIdentityKey ?? null,
    avatarMediaId: paired ? r.avatarMediaId : null,
    avatarMediaKey: paired ? r.avatarMediaKey : null,
  }
}

/// Take the keys from `base` and the display from whichever side is newer.
function combine(a: CrossIslandContact, b: CrossIslandContact): CrossIslandContact {
  // Trust on first use: the earlier row is the one that pinned the keys.
  const base = (a.addedAt || 0) <= (b.addedAt || 0) ? a : b
  const fresh = updatedAt(a) >= updatedAt(b) ? a : b
  return {
    uin: base.uin,
    host: base.host,
    identityKey: base.identityKey,
    signingKey: base.signingKey,
    signalIdentityKey: base.signalIdentityKey ?? null,
    addedAt: base.addedAt,
    nickname: fresh.nickname || base.nickname,
    gender: fresh.gender ?? base.gender ?? null,
    statusMessage: fresh.statusMessage ?? base.statusMessage ?? null,
    // Both halves or neither: an id without its key names a blob nobody can
    // open, the same rule `applyCrossIslandProfile` enforces.
    avatarMediaId: fresh.avatarMediaId && fresh.avatarMediaKey ? fresh.avatarMediaId : null,
    avatarMediaKey: fresh.avatarMediaId && fresh.avatarMediaKey ? fresh.avatarMediaKey : null,
    profileTs: Math.max(a.profileTs ?? 0, b.profileTs ?? 0) || undefined,
  }
}

function valid(r: unknown): r is CrossIslandContact {
  const c = r as CrossIslandContact
  return (
    !!c &&
    typeof c.uin === 'number' &&
    typeof c.host === 'string' &&
    !!c.host &&
    typeof c.identityKey === 'string' &&
    typeof c.signingKey === 'string'
  )
}

/// Pure, and the whole of the interesting behaviour. Exported for tests.
///
/// A tombstone kills a row only while it is NEWER than that row was added:
/// remove a peer on the phone, add them again on the desktop, and the fresh
/// row must win, or re-adding somebody you once removed would be impossible
/// from a second device.
export function mergeCrossIsland(
  local: VaultCrossIsland,
  remote: VaultCrossIsland,
  now: number,
): VaultCrossIsland {
  const out: VaultCrossIsland = { v: 1, c: {}, g: {} }
  for (const [k, ms] of Object.entries({ ...local.g, ...remote.g })) {
    const t = Math.max(local.g[k] ?? 0, remote.g[k] ?? 0)
    if (typeof ms === 'number' && now - t < TOMBSTONE_TTL_MS) out.g[k] = t
  }
  const keys = new Set([...Object.keys(local.c), ...Object.keys(remote.c)])
  for (const k of keys) {
    const a = local.c[k]
    const b = remote.c[k]
    const picked = valid(a) && valid(b) ? combine(a, b) : valid(a) ? a : valid(b) ? b : null
    if (!picked) continue
    const row = normalize(picked)
    const buried = out.g[k] ?? 0
    if (buried > (row.addedAt || 0)) continue
    // Re-added after the removal: the tombstone has been outlived.
    if (buried) delete out.g[k]
    out.c[ciKey(row.uin, row.host)] = row
  }
  return out
}

/// ⚠⚠ THE SHAPE IS A CONTRACT BETWEEN CLIENTS, not a private encoding.
///
/// Three clients write this slot and each has its own serialiser. Android's
/// gson omits null fields and always emits `profileTs` (it is a primitive
/// `Long` there, so an absent one is 0, not missing); a plain
/// `JSON.stringify` of our row writes `gender: null` and omits `profileTs`
/// when it is undefined, and orders keys by insertion. Every one of those
/// differences reads as "the island disagrees with me" to the OTHER client,
/// which rewrites, which makes this one disagree, and the two devices burn
/// the account's 240-writes-an-hour budget rewriting the same contacts at
/// each other forever.
///
/// So: one canonical row — required fields always, optional fields only when
/// they have a value, `profileTs` always a number — and a canonical JSON with
/// sorted keys for the compare. Encode through this, compare through this.
function canonRow(r: CrossIslandContact): Record<string, unknown> {
  const o: Record<string, unknown> = {
    uin: r.uin,
    host: r.host,
    nickname: r.nickname,
    identityKey: r.identityKey,
    signingKey: r.signingKey,
    addedAt: r.addedAt,
    profileTs: r.profileTs ?? 0,
  }
  if (r.signalIdentityKey) o.signalIdentityKey = r.signalIdentityKey
  if (r.gender) o.gender = r.gender
  if (r.statusMessage) o.statusMessage = r.statusMessage
  if (r.avatarMediaId && r.avatarMediaKey) {
    o.avatarMediaId = r.avatarMediaId
    o.avatarMediaKey = r.avatarMediaKey
  }
  // ⚠ Sorted, so the BYTES this client writes are the bytes Android writes.
  // Comparing canonically would have been enough to stop the rewrite war on
  // its own, but then the same contacts would sit in the slot in two different
  // orders depending on which device last touched them, and every parity test
  // between the clients would have to compare structures instead of strings.
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(o).sort()) sorted[k] = o[k]
  return sorted
}

export function canonState(s: VaultCrossIsland): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  for (const k of Object.keys(s.c).sort()) c[k] = canonRow(s.c[k])
  const g: Record<string, number> = {}
  for (const k of Object.keys(s.g).sort()) g[k] = s.g[k]
  return { v: 1, c, g }
}

/// Key-sorted stringify, so two clients that agree on the contacts agree on
/// the string as well.
function canonJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(val as Record<string, unknown>).sort()) out[k] = (val as Record<string, unknown>)[k]
      return out
    }
    return val
  })
}

function sameContent(a: VaultCrossIsland, b: VaultCrossIsland): boolean {
  return canonJson(canonState(a)) === canonJson(canonState(b))
}

function localState(): VaultCrossIsland {
  const st: VaultCrossIsland = { v: 1, c: {}, g: readTombstones() }
  for (const r of listCrossIsland()) st.c[ciKey(r.uin, r.host)] = r
  return st
}

/// Removals have to be remembered, or the next sync would fetch the row back
/// off the island and "deleting" a cross-island contact would undo itself on
/// the following boot. Kept next to the store's own key, per account.
const GRAVE_KEY = () => scopedKey('crossisland.graves.v1')

export function readTombstones(): Record<string, number> {
  try {
    const j = JSON.parse(localStorage.getItem(GRAVE_KEY()) || '{}')
    return j && typeof j === 'object' ? (j as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function writeTombstones(g: Record<string, number>): void {
  try {
    localStorage.setItem(GRAVE_KEY(), JSON.stringify(g))
  } catch {
    /* no storage; the row simply comes back on the next sync */
  }
}

/// Called by the store when a cross-island contact is removed.
export function buryCrossIsland(uin: number, host: string, now: number): void {
  const g = readTombstones()
  g[ciKey(uin, host)] = now
  writeTombstones(g)
}

async function available(identity: WebIdentity): Promise<boolean> {
  try {
    const info = await fetchServerInfo(identity.apiBase)
    return info?.capabilities.vault === true
  } catch {
    return false
  }
}

/// Boot, the nudge, and every reconnect. Merges both ways, writes the local
/// store, and pushes when the island turns out to be missing something of
/// ours. Never throws: a vault that is down is not the user's problem at that
/// moment, and every row is still on this device.
export async function syncCrossIsland(identity: WebIdentity): Promise<number> {
  if (rolledBackFor === identity.uin) return 0
  if (!(await available(identity))) return 0
  const slot = slotId(identity, VAULT_CROSSISLAND)
  const now = Date.now()
  try {
    const r = await readSlot(identity, slot, lastSeenVersion(slot))
    const remote = decode(r.plaintext)
    if (remote === null) {
      console.info('[crossisland] slot is newer than this build; not syncing')
      return 0
    }
    rememberVersion(slot, r.version)
    const merged = mergeCrossIsland(localState(), remote, now)
    const rows = Object.values(merged.c)
    replaceAllCrossIsland(rows)
    writeTombstones(merged.g)
    if (!sameContent(merged, remote)) {
      if (rows.length > MAX_ROWS) {
        console.warn(`[crossisland] ${rows.length} rows is over the slot budget; not backing up`)
        return rows.length
      }
      await push(identity, slot, now)
    }
    return rows.length
  } catch (e) {
    if (e instanceof VaultError && e.code === 'rolled_back') {
      rolledBackFor = identity.uin
      console.warn('[crossisland] island served a version below the floor; sync stopped for this session')
    }
    return 0
  }
}

async function push(identity: WebIdentity, slot: string, now: number): Promise<void> {
  try {
    const version = await writeSlot(
      identity,
      slot,
      (remoteBytes) => {
        const remote = decode(remoteBytes)
        if (remote === null) return null
        const next = mergeCrossIsland(localState(), remote, now)
        if (sameContent(next, remote)) return null
        return jsonBytes(canonState(next))
      },
      lastSeenVersion(slot),
    )
    rememberVersion(slot, version)
  } catch (e) {
    if (e instanceof VaultError && e.code === 'rolled_back') rolledBackFor = identity.uin
    // Anything else: the next read retries, because the merge will still
    // disagree with what the island holds.
  }
}

/// A local add or remove just happened. Debounced, because accepting a
/// cross-island request writes the row and then immediately writes the profile
/// that came with it.
let timer: ReturnType<typeof setTimeout> | null = null
export function scheduleCrossIslandPush(identity: WebIdentity): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void syncCrossIsland(identity)
  }, 900)
}
