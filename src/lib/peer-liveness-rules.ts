// The rules behind "is this contact on another island still there" (report
// 1067), on their own and pure, so they are proven offline against the built
// bundle (cli/test/peer-liveness.mjs). The store and the network half live in
// peer-liveness.ts; the send path reads `cardAgainstPin` from here too.
//
// ⚠⚠ Every answer that is not a clean, specific one is UNKNOWN, and unknown
// changes nothing. A bare 404 means very little on the open internet: a
// masquerade island answers a browser (which cannot carry its gateway key)
// with a decoy site, a parked domain answers anything with its own page, a
// self-host from before `/federation/uin-for-key` answers FastAPI's own "Not
// Found". Reading any of those as "deleted" would mark every contact of such an
// island deleted the first time their chat is opened. So the island has to
// say, in JSON, the exact thing the island code says for this case.

import { sameSigningKey } from './crossisland-gate'
import { verifyHomeIslandRecord } from './federation'

/// What a probe concluded about `uin@host`.
///  * alive: the island serves this number under the pinned keys.
///  * gone: the island has no such number AND no account under the pinned key,
///    and the person's own signed record names no other home.
///  * moved: the pinned key lives on: under another number on that island, or
///    on another home their signed record names. Not deleted, so not marked.
///  * key_changed: the island serves this number under ANOTHER key. Whoever
///    holds it now is not the person we pinned, or not provably so.
///  * unknown: anything else (refused, unreachable, not JSON, not the words).
export type Liveness = 'alive' | 'gone' | 'moved' | 'key_changed' | 'unknown'

/// One answer from an island: its status, and the body when it parsed as JSON
/// (null when it did not, which is what a decoy page parses as).
export interface IslandReply {
  status: number
  body: unknown
}

export interface PinnedKeys {
  identityKey: string
  signingKey: string
}

/// The island's own words for the two answers that count. Kept next to the
/// rule rather than matched loosely: `routers/federation.py` raises exactly
/// these, and nothing else on the way says them.
export const NO_SUCH_USER = 'no such user'
export const NO_ACCOUNT_FOR_KEY = 'no account for key'

function detailOf(body: unknown): string | null {
  const d = (body as { detail?: unknown } | null)?.detail
  return typeof d === 'string' ? d : null
}

/// A card an island served for an address, held against the keys pinned for
/// that address when it was added.
///  * match: both keys present and both the pinned bytes.
///  * differs: a real card, under any other key.
///  * no_card: nothing to compare (no answer, not JSON, a key missing).
///
/// The signing key is compared only when one was pinned: a row that never had
/// one is anchored by its identity key alone, as it always was.
export function cardAgainstPin(card: unknown, pin: PinnedKeys): 'match' | 'differs' | 'no_card' {
  const c = card as { identity_key?: unknown; signing_key?: unknown } | null
  if (!c || typeof c.identity_key !== 'string' || !c.identity_key) return 'no_card'
  if (typeof c.signing_key !== 'string' || !c.signing_key) return 'no_card'
  const ik = sameSigningKey(c.identity_key, pin.identityKey)
  const sk = pin.signingKey ? sameSigningKey(c.signing_key, pin.signingKey) : true
  return ik && sk ? 'match' : 'differs'
}

/// Step 1, `GET /federation/keys/{uin}` on their island. `absent` only for the
/// island's own "no such user": 403 `island_closed` is decided before the
/// number is looked up and says nothing about the person, so it is unknown.
export function cardStep(reply: IslandReply | null, pin: PinnedKeys): 'alive' | 'key_changed' | 'absent' | 'unknown' {
  if (!reply) return 'unknown'
  if (reply.status === 200) {
    const v = cardAgainstPin(reply.body, pin)
    return v === 'match' ? 'alive' : v === 'differs' ? 'key_changed' : 'unknown'
  }
  if (reply.status === 404 && detailOf(reply.body) === NO_SUCH_USER) return 'absent'
  return 'unknown'
}

/// Step 2, `GET /federation/uin-for-key?signing_key=<pinned>` on the SAME
/// island. Another number under the pinned key is a person who moved to a new
/// number there: alive, never marked. The same number back would contradict
/// step 1 a moment ago, so it proves nothing either way.
export function ownerStep(reply: IslandReply | null, uin: number): 'moved' | 'absent' | 'unknown' {
  if (!reply) return 'unknown'
  if (reply.status === 200) {
    const n = (reply.body as { uin?: unknown } | null)?.uin
    return typeof n === 'number' && Number.isSafeInteger(n) && n !== uin ? 'moved' : 'unknown'
  }
  if (reply.status === 404 && detailOf(reply.body) === NO_ACCOUNT_FOR_KEY) return 'absent'
  return 'unknown'
}

/// Step 3: does the person's own signed record of homes, verified against the
/// PINNED signing key, name any home other than this address?
///
/// A contact pinned on a backup copy (added that way before the add paths
/// refused it) answers steps 1 and 2 with two clean 404s once the copy is
/// deleted or swept, while the person lives on at their primary. Their record
/// is what says so. Unverifiable or absent: nothing is known, so no.
export function livesElsewhere(record: unknown, pinnedSigningKey: string, host: string, uin: number): boolean {
  if (record == null || !pinnedSigningKey) return false
  const v = verifyHomeIslandRecord(record, { expectedSk: pinnedSigningKey })
  if (!v.ok) return false
  return v.record.homes.some((h) => !(sameIslandHost(h.host, host) && h.uin === uin))
}

/// One spelling of an island address for comparing two of them.
export function sameIslandHost(a: string, b: string): boolean {
  const canon = (h: string) => {
    let s = h.trim().toLowerCase()
    if (s.endsWith(':443')) s = s.slice(0, -4)
    return s.replace(/\.+$/, '')
  }
  return canon(a) === canon(b)
}
