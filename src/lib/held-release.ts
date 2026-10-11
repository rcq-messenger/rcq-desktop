// Which held messages an accept in the requests list may let into a number's
// thread, on its own.
//
// Pure on purpose, like crossisland-gate.ts and sender-trust.ts: the requests
// screen fetches the key the island publishes for the number, the store hands
// in the row, and the rule can be proven offline against the built bundle
// (cli/test/sender-auth.mjs).
//
// Why it exists (sender-auth follow-up, 12.10). An accept used to check only
// the keys COLLECTED on the row (`spubs`) and then release every message held
// on it. A v=2 row adds no key: its proof is the identity check, and one that
// failed is held flagged as a changed key with '' as its key. So when the
// number's real v=1 message (sealed under their card key) shared the row with
// such a fake, the row's keys were [their key], the card check passed, and the
// fake went into their thread with the real one. The row-level answer is not
// enough once a row is marked: each message has to show it was sealed under
// the key the island publishes, or it stays where it is.

import type { Envelope } from './crypto'
import { sameSigningKey } from './crossisland-gate'

export interface HeldRowForRelease {
  msgs: Envelope[]
  /// Something on this row came under a key that is not the one held or
  /// published for the number (a forged v=1 seal, or a v=2 identity the
  /// island does not vouch for).
  keyMismatch?: boolean
  /// The key that sealed each held message, by id; '' for a v=2 row.
  heldSpub?: Record<string, string>
}

export interface HeldSplit {
  /// Goes into the number's thread.
  release: Envelope[]
  /// Stays held: nothing shows it came from the holder of the published key.
  keep: Envelope[]
}

function idOf(m: Envelope): string | undefined {
  const id = (m as { id?: unknown }).id
  return typeof id === 'string' && id ? id : undefined
}

/// Split a row's held messages for an accept. `cardKey` is the signing key
/// the island publishes for the number now (null when the accept asked for
/// none: an unmarked row that names no key, whose messages are all verified
/// v=2 strangers).
///
///  * sealed under `cardKey`: released;
///  * on a MARKED row (keyMismatch), anything else stays: a '' key cannot
///    tell a verified v=2 row from a forged one, and a message held before
///    keys were recorded per message (no entry) cannot show either;
///  * on an unmarked row, a v=2 message ('') or one held before keys were
///    recorded is released, as it always was: every key the row collected
///    was checked against the card before this is asked;
///  * a message under any other key stays, marked or not.
export function splitHeldForRelease(row: HeldRowForRelease, cardKey: string | null | undefined): HeldSplit {
  const release: Envelope[] = []
  const keep: Envelope[] = []
  for (const m of row.msgs ?? []) {
    const id = idOf(m)
    const proof = id !== undefined ? row.heldSpub?.[id] : undefined
    if (proof && cardKey && sameSigningKey(proof, cardKey)) release.push(m)
    else if (row.keyMismatch) keep.push(m)
    else if (!proof) release.push(m)
    else keep.push(m)
  }
  return { release, keep }
}
