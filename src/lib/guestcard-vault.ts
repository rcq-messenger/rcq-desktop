// The cards other people gave us, in the vault.
//
// ⚠⚠ WITHOUT THIS THE WHOLE FEATURE HAS A TRAPDOOR. A guest card is the only
// way to reach somebody on a closed island. They live in localStorage, so a
// reinstall, a cleared browser or a second device means every one of them is
// gone — and the failure is silent and looks like the island working
// correctly, because a closed island answers a caller with no card by saying
// "no such number". A person would restore their account from their recovery
// phrase, see their contacts intact, and simply be unable to write to any of
// them, with nothing on screen explaining why.
//
// So the cards go where the account's other durable secrets go: a sealed vault
// slot, the same machinery as `crossisland-vault.ts` and for the same reason.
//
// ⚠ ONLY THEIRS, never ours. A card we minted is a credential we HAND OUT; if
// it is lost, we mint another and share it again, and the old one is revoked
// from the island's own list. A card somebody gave US is irreplaceable without
// asking them for it again, which on a closed island is exactly the
// conversation we cannot have.
//
// The merge is a union: two devices each hold cards from different people, and
// neither list is a subset of the other. Nothing is ever removed by a merge —
// only by the local `forgetTheirCard`, whose removals are not synced, because
// a card that a stale device drops must not vanish from a device that still
// needs it. The cost is a card kept slightly too long, which is invisible; the
// alternative is a contact who silently goes unreachable.

import type { WebIdentity } from './crypto'
import { allTheirCards, replaceTheirCards } from './guest-card'
import { fetchServerInfo } from './server-info'
import {
  bytesJson,
  jsonBytes,
  lastSeenVersion,
  readSlot,
  rememberVersion,
  slotId,
  VAULT_GUESTCARDS,
  VaultError,
  writeSlot,
} from './vault'

interface Payload {
  v: 1
  /// `uin@host` (or a bare uin on our own island) -> the raw card.
  c: Record<string, string>
}

/// The island's blob cap is 256 KiB; a card is ~43 characters and a handle is
/// short, so this is far under it. The bound exists so a corrupted or hostile
/// slot cannot make the client build an enormous object.
const MAX_CARDS = 2000

let rolledBackFor: number | null = null

export function retireGuestCardSync(uin: number): void {
  rolledBackFor = uin
}

export function lastSeenGuestCardVersion(identity: WebIdentity): number {
  return lastSeenVersion(slotId(identity, VAULT_GUESTCARDS))
}

function decode(p: Uint8Array | null): Payload | null {
  if (!p) return { v: 1, c: {} }
  try {
    const j = bytesJson<Partial<Payload>>(p)
    if (j && j.v === 1 && j.c && typeof j.c === 'object') {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(j.c)) {
        if (typeof v === 'string' && v && v.length <= 128 && Object.keys(out).length < MAX_CARDS) {
          out[k] = v
        }
      }
      return { v: 1, c: out }
    }
    if (j && typeof j.v === 'number' && j.v > 1) return null
  } catch {
    /* fall through */
  }
  return { v: 1, c: {} }
}

/// Union, local first. ⚠ A key present on both sides keeps the LOCAL value: a
/// person can hand out a fresh card after revoking the old one, and the device
/// that just received the new one is the device that is right.
export function mergeCards(
  local: Record<string, string>,
  remote: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...remote }
  for (const [k, v] of Object.entries(local)) out[k] = v
  const keys = Object.keys(out).sort()
  if (keys.length <= MAX_CARDS) return canon(out)
  const trimmed: Record<string, string> = {}
  for (const k of keys.slice(0, MAX_CARDS)) trimmed[k] = out[k]
  return canon(trimmed)
}

/// Sorted keys, so two devices that agree on the cards agree on the bytes and
/// do not rewrite the slot at each other. Same discipline as the cross-island
/// slot.
function canon(m: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(m).sort()) out[k] = m[k]
  return out
}

/// Boot, the nudge, and every reconnect. Never throws.
export async function syncGuestCards(identity: WebIdentity): Promise<number> {
  if (rolledBackFor === identity.uin) return 0
  try {
    const info = await fetchServerInfo(identity.apiBase)
    // Only where cards mean anything. An open island never mints one, so there
    // is nothing to carry and no reason to make a request.
    if (info?.capabilities.vault !== true || !info.capabilities.closed_island) return 0
  } catch {
    return 0
  }
  const slot = slotId(identity, VAULT_GUESTCARDS)
  try {
    const r = await readSlot(identity, slot, lastSeenVersion(slot))
    const remote = decode(r.plaintext)
    if (remote === null) return 0
    rememberVersion(slot, r.version)
    const merged = mergeCards(allTheirCards(), remote.c)
    replaceTheirCards(merged)
    if (JSON.stringify(merged) !== JSON.stringify(canon(remote.c))) {
      await push(identity, slot)
    }
    return Object.keys(merged).length
  } catch (e) {
    if (e instanceof VaultError && e.code === 'rolled_back') rolledBackFor = identity.uin
    return 0
  }
}

async function push(identity: WebIdentity, slot: string): Promise<void> {
  try {
    const version = await writeSlot(
      identity,
      slot,
      (remoteBytes) => {
        const remote = decode(remoteBytes)
        if (remote === null) return null
        const next = mergeCards(allTheirCards(), remote.c)
        if (JSON.stringify(next) === JSON.stringify(canon(remote.c))) return null
        return jsonBytes({ v: 1, c: next } satisfies Payload)
      },
      lastSeenVersion(slot),
    )
    rememberVersion(slot, version)
  } catch (e) {
    if (e instanceof VaultError && e.code === 'rolled_back') rolledBackFor = identity.uin
  }
}
