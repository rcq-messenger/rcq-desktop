// The contact list in the vault (stage 4 of the metadata plan, client half).
//
// Today's phase, "mirror": the island's `contacts` table is still what every
// client (including the phones that have not updated) adds to and removes
// from, so the server list is the truth and the vault holds a sealed copy of
// it. Every successful `/contacts` fetch on an island that advertises `vault`
// is folded into the account's `contacts` slot: entries that the server has
// and the slot does not are added, entries the server no longer has become
// tombstones, and nothing is written when the slot already says the same.
//
// Why bother before the table goes: the moment the island stops answering
// `/contacts` (the read-only and drop steps of the plan), a reinstall or a new
// device recovers its roster from this slot and from nowhere else, and a
// client that shipped today already keeps the copy current. The per-entry
// timestamps and the tombstones are what the later phases merge on; in this
// phase they are only recorded.
//
// What an entry holds: the edge (uin, blocked) and the last nickname seen for
// it, so a restored list has names before the first profile fetch. Keys,
// status and avatars are NOT here: those are the peer's profile and are
// fetched by uin as they are today.
//
// ⚠ Server-wins is the rule of THIS phase only. A merge that let the slot
// re-add what an old phone removed on the island would resurrect deleted
// contacts on every device; a merge that let the slot remove what the island
// still has would drop contacts the phone can see. When the island advertises
// the next phase the rule changes here, not in the pages.

import type { Contact } from './api'
import type { WebIdentity } from './crypto'
import { fetchServerInfo } from './server-info'
import {
  bytesJson,
  jsonBytes,
  lastSeenVersion,
  readSlot,
  rememberVersion,
  slotId,
  VAULT_CONTACTS,
  VaultError,
  writeSlot,
} from './vault'

export interface VaultContactEntry {
  /// Added (ms since epoch, first seen by any of the account's devices).
  a: number
  /// Updated (ms): the last time this entry's fields changed.
  u: number
  /// Blocked by me.
  b?: 1
  /// Last nickname seen, so a restored roster has names before it has profiles.
  n?: string
  /// Home island host for a cross-island peer (absent = same island as me).
  /// Recorded for the later phases; nothing reads it yet.
  h?: string
}

export interface VaultContacts {
  v: 1
  /// By uin (as a decimal string, since JSON keys are strings).
  c: Record<string, VaultContactEntry>
  /// Tombstones by uin: when the edge was last removed (ms). Dropped after
  /// TOMBSTONE_TTL_MS so the slot does not accumulate every contact ever
  /// deleted.
  g: Record<string, number>
}

const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000

/// Set for the rest of the session when the island serves a version below the
/// floor, or when another device retired this derivation (`vault_reset`).
/// Keyed by account so switching accounts in one tab clears it.
let stoppedFor: number | null = null

/// Stop the mirror for this session, from outside: `/auth/reissue` elsewhere
/// retired the identity this browser's slot name and key are derived from.
export function retireContactsMirror(uin: number): void {
  stoppedFor = uin
  lastMirrored = null
}

/// Account switch inside one tab.
export function resetContactsSyncState(): void {
  stoppedFor = null
  lastMirrored = null
}

function emptyList(): VaultContacts {
  return { v: 1, c: {}, g: {} }
}

/// Decode a slot's plaintext; a slot whose contents this build cannot read
/// (a newer `v`) is treated as empty-but-present so the writer starts from
/// what it knows rather than refusing forever.
function decode(p: Uint8Array | null): VaultContacts {
  if (!p) return emptyList()
  try {
    const j = bytesJson<Partial<VaultContacts>>(p)
    if (j && j.v === 1 && j.c && typeof j.c === 'object') {
      return { v: 1, c: j.c, g: j.g && typeof j.g === 'object' ? j.g : {} }
    }
  } catch {
    /* fall through */
  }
  return emptyList()
}

/// The last slot version this browser saw. Handed to the vault reads as the
/// rollback floor (see vault.ts readSlot), and kept there, keyed by SLOT NAME:
/// a reissue gives the account new names, and a floor that outlives the name
/// it belonged to is a floor no fresh slot can ever climb over.
export function lastSeenContactsVersion(identity: WebIdentity): number {
  return lastSeenVersion(slotId(identity, VAULT_CONTACTS))
}

/// Fold the server's list into the slot. `list` is the full `/contacts`
/// answer. Resolves when the slot is up to date (or was already), and never
/// throws: the roster is on screen already and a vault that is down is not
/// the user's problem at that moment. Returns what happened, for the log.
export async function mirrorContactsToVault(
  identity: WebIdentity,
  list: Contact[],
): Promise<'written' | 'unchanged' | 'skipped' | 'failed'> {
  if (stoppedFor === identity.uin) return 'skipped'
  // The list is fetched on every visit to the contacts page (one active
  // user was seen doing it every twenty seconds), and the mirror must not
  // turn each of those into a vault read as well. Same list as last time
  // this session: nothing to fold, no request.
  const key = listKey(identity.uin, list)
  if (key === lastMirrored) return 'unchanged'
  const info = await fetchServerInfo(identity.apiBase)
  if (info?.capabilities.vault !== true) return 'skipped'
  const slot = slotId(identity, VAULT_CONTACTS)
  const now = Date.now()
  let outcome: 'written' | 'unchanged' = 'unchanged'
  try {
    const version = await writeSlot(
      identity,
      slot,
      (remote) => {
        const cur = decode(remote)
        const next = foldServerList(cur, list, now)
        if (!next) {
          outcome = 'unchanged'
          return null
        }
        outcome = 'written'
        return jsonBytes(next)
      },
      lastSeenVersion(slot),
    )
    rememberVersion(slot, version)
    lastMirrored = key
    return outcome
  } catch (e) {
    if (e instanceof VaultError && e.code === 'rolled_back') {
      // The island served an older version than this browser has seen. This
      // used to clear the floor and let the next refresh rewrite the slot
      // from the server list, on the grounds that the server list is the
      // truth in the mirror phase. ⚠ It is the wrong move, because a rollback
      // is not one situation: `/auth/reissue` on another device empties the
      // vault and RETIRES this derivation, and the 404 that leaves behind
      // reads exactly like a restored backup. Rewriting there re-publishes
      // the whole contact list under the retired slot name, sealed with the
      // key the user has just declared compromised, which is the one thing
      // the reissue existed to prevent. So: stop for this session and keep
      // the floor. A genuinely rolled-back island heals on its own, because
      // another device's writes carry its version back over the floor.
      stoppedFor = identity.uin
      console.warn('[vault] contacts slot is below the floor; the mirror is stopped for this session')
    }
    return 'failed'
  }
}

/// What the mirror last folded this session, as a cheap fingerprint of the
/// edges (uin, blocked, nickname, host), sorted; keyed by account so a
/// switch never compares across accounts.
let lastMirrored: string | null = null

/// Forget that fingerprint. Called when another device's write lands (the
/// `vault_changed` nudge, or the reconnect sweep): the slot moved under us, so
/// "the same list as last time" no longer means "the slot already agrees".
export function invalidateContactsMirror(): void {
  lastMirrored = null
}

function listKey(uin: number, list: Contact[]): string {
  const parts = list
    .map((c) => `${c.uin}:${c.blocked ? 1 : 0}:${c.nickname ?? ''}:${c.host ?? ''}`)
    .sort()
  return `${uin}|${parts.join('\n')}`
}

/// Pure: the slot after folding the server list in, or null when nothing
/// would change. Exported for tests.
export function foldServerList(cur: VaultContacts, list: Contact[], now: number): VaultContacts | null {
  const next: VaultContacts = { v: 1, c: { ...cur.c }, g: { ...cur.g } }
  let changed = false
  const onServer = new Set<string>()
  for (const c of list) {
    const k = String(c.uin)
    onServer.add(k)
    const prev = next.c[k]
    const entry: VaultContactEntry = {
      a: prev?.a ?? now,
      u: prev?.u ?? now,
      ...(c.blocked ? { b: 1 as const } : {}),
      ...(c.nickname ? { n: c.nickname } : {}),
      ...(c.host ? { h: c.host } : {}),
    }
    if (!prev || !sameEntry(prev, entry)) {
      entry.u = now
      next.c[k] = entry
      changed = true
    }
    if (next.g[k] !== undefined) {
      delete next.g[k]
      changed = true
    }
  }
  for (const k of Object.keys(next.c)) {
    if (!onServer.has(k)) {
      delete next.c[k]
      next.g[k] = now
      changed = true
    }
  }
  for (const [k, t] of Object.entries(next.g)) {
    if (now - t > TOMBSTONE_TTL_MS) {
      delete next.g[k]
      changed = true
    }
  }
  return changed ? next : null
}

function sameEntry(x: VaultContactEntry, y: VaultContactEntry): boolean {
  return (x.b ?? 0) === (y.b ?? 0) && (x.n ?? '') === (y.n ?? '') && (x.h ?? '') === (y.h ?? '')
}

/// The roster as the vault has it, for a device that has nothing else (a
/// reinstall, a new browser) once the island stops serving `/contacts`.
/// Null when the island has no vault, the slot is empty, or it cannot be
/// opened. Records the version it saw.
export async function readContactsFromVault(identity: WebIdentity): Promise<VaultContacts | null> {
  const info = await fetchServerInfo(identity.apiBase)
  if (info?.capabilities.vault !== true) return null
  if (stoppedFor === identity.uin) return null
  const slot = slotId(identity, VAULT_CONTACTS)
  try {
    const r = await readSlot(identity, slot, lastSeenVersion(slot))
    if (!r.plaintext) return null
    rememberVersion(slot, r.version)
    return decode(r.plaintext)
  } catch (e) {
    if (e instanceof VaultError && e.code === 'rolled_back') stoppedFor = identity.uin
    return null
  }
}
