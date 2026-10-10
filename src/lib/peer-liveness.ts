// Is a contact on another island still there? (report 1067)
//
// When somebody burns their account, their own island drops the contact rows
// on both sides and the neighbours there lose the row on their next /contacts.
// A contact on ANOTHER island hears nothing at all: that contact lives only on
// this device, the burned person's island does not know we hold them, and no
// client says anything to its contacts on the way out. The web was the worst
// of the three: a message to such a ghost showed as sent, no error, no word.
//
// So this device asks, lazily, the one island that knows: when a send to them
// failed, and when their chat is opened (at most once a day per address). It
// never polls the roster in the background. Asking about every contact every
// day is exactly the traffic pattern sealed sender exists to avoid; asking
// when the user opens a chat or a send just failed tells their island nothing
// a send would not have told it.
//
// How (peer-liveness-rules.ts has the rules themselves):
//   1. GET /federation/keys/{uin}        200 under the pinned keys: alive.
//                                        200 under other keys: key changed.
//                                        404 "no such user": go on.
//   2. GET /federation/uin-for-key?signing_key=<pinned>
//                                        another number: moved, not marked.
//                                        404 "no account for key": go on.
//   3. GET /federation/gossip-record?sk=<pinned> on OUR island
//                                        their signed record naming another
//                                        home: moved, not marked.
//                                        404 "no record", or a record naming
//                                        only this address: gone.
//   Anything unclear on the way, at any step: unknown, nothing changes.
//
// ⚠⚠ NEVER `/messages/sealed` and never `island-record`. A deposit wakes the
// phone at the other end and answers with presence; the record endpoint is a
// per-number lookup we have no reason to make. The probe asks only about a
// number and a key this device already holds.
//
// ⚠ Step 3 reads the mirror on our island, and a read keeps the mirrored
// record alive there (it renews its `touched_at`). That is why a contact marked
// gone is never probed again, and why sends to one skip the mirror altogether
// (federation-send.ts): a burned person's "where to reach me" must not be kept
// warm on our island by our own retries.
//
// Marks are per account (scopedKey) and keyed `uin@host`, never by bare number:
// the number is per island, and the same digits here are somebody else (#1061).
// A mark also names the pinned signing key it is about, and is ignored when the
// row at that address now pins another key or was (re)added after the mark:
// identity is the number AND the key, the address is only where to deliver.
//
// The "deleted" mark is cleared by two things only, both about the pinned
// number AND key: a message that verified under the pinned key and was
// deposited after the mark (message-receiver.tsx), and a card the island
// serves under both pinned keys, which the send path checks before every
// send (a restored island database, a re-register under the same keys).
// Not by a later probe, which a gone contact never gets, and not by anything
// under another key: a reissued number writing to us, or serving its card,
// must not bring the old contact back to life. The "key changed" mark is a
// statement about the card, so it lifts when a card under the pinned keys is
// seen again.

import { scopedKey } from './account-scope'
import { ciKey, getCrossIsland, type CrossIslandContact } from './crossisland-store'
import { sameSigningKey } from './crossisland-gate'
import { hostOfApiBase } from './multihome'
import { clockOffsetMs } from './message-time'
import type { WebIdentity } from './crypto'
import {
  cardStep,
  depositAfterMark,
  ownerStep,
  recordStep,
  type IslandReply,
  type Liveness,
  type PinnedKeys,
} from './peer-liveness-rules'

export type { Liveness } from './peer-liveness-rules'

interface Mark {
  /// The pinned signing key this record is about.
  sk: string
  /// When a probe found the account gone (ms).
  gone?: number
  /// When a card under another key was seen at this address (ms). Cleared by
  /// the next card that matches the pin again, on a send or a probe.
  keyChanged?: number
  /// When the last probe started (ms), for the once-a-day rule.
  probedAt?: number
  /// When the last probe after a FAILED send started (ms). Its own stamp: a
  /// send that fails a minute after the chat was opened (and found them
  /// alive) is exactly when to ask again, and only retry presses wait.
  failProbeAt?: number
}

const KEY = () => scopedKey('peer-liveness.v1')

/// The open-chat probe runs at most this often per address.
const OPEN_EVERY_MS = 24 * 3600_000
/// A failed send asks again sooner, but not on every retry press: each retry
/// already talked to their island, and the answer does not change that fast.
/// Counted from the last failure probe, not from the open one.
const FAILURE_EVERY_MS = 5 * 60_000
/// A probe that hangs is an unknown, not a spinner.
const PROBE_TIMEOUT_MS = 10_000

let version = 0
const listeners = new Set<() => void>()

function bump(): void {
  version++
  for (const l of listeners) {
    try {
      l()
    } catch {
      /* one broken subscriber must not stop the others */
    }
  }
}

/// For `useSyncExternalStore`: re-render when any mark changes.
export function subscribePeerLiveness(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function peerLivenessVersion(): number {
  return version
}

// Another tab of the same account writing a mark.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY()) bump()
  })
}

function load(): Record<string, Mark> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY()) || '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Mark>) : {}
  } catch {
    return {}
  }
}

function save(map: Record<string, Mark>): void {
  try {
    localStorage.setItem(KEY(), JSON.stringify(map))
  } catch {
    /* full or unavailable storage: the mark is lost, the send result is not */
  }
}

/// Does mark `m` still speak about `row`, the contact pinned at its address
/// now? The same signing key, and not older than the row: a contact removed
/// and added again starts clean, whichever device did the removing.
function holds(m: Mark, row: CrossIslandContact | null): boolean {
  if (!row?.signingKey || !sameSigningKey(m.sk, row.signingKey)) return false
  const markedAt = Math.max(m.gone ?? 0, m.keyChanged ?? 0)
  return markedAt === 0 || (row.addedAt || 0) <= markedAt
}

/// The record at this address, but only while it holds (see `holds`).
function liveMark(map: Record<string, Mark>, uin: number, host: string): Mark | null {
  const m = map[ciKey(uin, host)]
  return m && holds(m, getCrossIsland(uin, host)) ? m : null
}

/// Apply `fn` to the record for `uin@host` and write it back only if something
/// changed. Marks are about the contact pinned at the address: a key that is
/// not pinned there (a stale caller, a server row that carries a host) leaves
/// none, and a record that no longer holds starts over, keeping only its probe
/// stamps.
function update(uin: number, host: string, sk: string, fn: (m: Mark) => Mark, notify = true): void {
  const row = getCrossIsland(uin, host)
  if (!row?.signingKey || !sameSigningKey(sk, row.signingKey)) return
  const map = load()
  const k = ciKey(uin, host)
  const prev = map[k]
  let base: Mark = { sk: row.signingKey }
  if (prev && sameSigningKey(prev.sk, row.signingKey)) {
    base = holds(prev, row) ? { ...prev } : { sk: prev.sk, probedAt: prev.probedAt, failProbeAt: prev.failProbeAt }
  }
  const next = fn(base)
  if (prev && JSON.stringify(next) === JSON.stringify(prev)) return
  // Nothing but the key: a card that matched for somebody never marked, the
  // common case on every send, and not worth a row.
  if (!prev && Object.keys(next).every((f) => f === 'sk' || next[f as keyof Mark] == null)) return
  map[k] = next
  save(map)
  if (notify) bump()
}

/// What the chat banner and the contact row show for `uin@host`.
export function peerMark(uin: number, host: string): { gone: boolean; keyChanged: boolean } {
  const m = liveMark(load(), uin, host)
  return { gone: m?.gone != null, keyChanged: m?.keyChanged != null && m?.gone == null }
}

export function isPeerGone(uin: number, host: string): boolean {
  return liveMark(load(), uin, host)?.gone != null
}

/// A card under another key was seen at this address, and none under the
/// pinned keys since. Read raw, not through `peerMark`, which hides it under
/// `gone`: a mark can carry both (gone, then the number reissued).
export function isPeerKeyChanged(uin: number, host: string): boolean {
  return liveMark(load(), uin, host)?.keyChanged != null
}

/// The `ciKey`s of `rows` marked gone right now. One read of the marks for a
/// whole list, for the contact list's sort and rows.
export function goneCrossIslandKeys(rows: CrossIslandContact[]): Set<string> {
  const map = load()
  const out = new Set<string>()
  for (const row of rows) {
    const k = ciKey(row.uin, row.host)
    const m = map[k]
    if (m?.gone != null && holds(m, row)) out.add(k)
  }
  return out
}

/// The send path's card check for a pinned contact (federation-send.ts):
/// remember a card under another key, forget it once a card matches again.
/// `no_card` says nothing and changes nothing.
export function notePinnedCard(uin: number, host: string, pinnedSk: string, verdict: 'match' | 'differs' | 'no_card'): void {
  if (!pinnedSk || verdict === 'no_card') return
  update(uin, host, pinnedSk, (m) => {
    if (verdict === 'differs') {
      if (m.keyChanged == null) m.keyChanged = Date.now()
    } else {
      // The island serves this number under BOTH pinned keys right now: the
      // number and the key, which is this person (a reissued number shows
      // 'differs'). An earlier "deleted" was a false one, and the send that
      // saw this card is about to be deposited to them; leaving the banner
      // up would say "messages will not be delivered" next to one that was.
      // No mirror is read here, so nothing about them is kept warm.
      delete m.keyChanged
      delete m.gone
    }
    return m
  })
}

/// A message from `uin@host` verified under the pinned key: they are there.
///
/// `srvAt` is the island's deposit stamp. A copy deposited BEFORE the mark is
/// old mail arriving late (a backup mailbox, a long-closed tab draining), not a
/// sign of life, and leaves the mark alone. No stamp at all is a live delivery.
/// The stamp is on the island's clock and the mark on this device's, so they
/// are compared through the offset the socket learned (`depositAfterMark`).
export function notePeerHeardFrom(uin: number, host: string, srvAt?: number): void {
  // Every verified envelope from another island passes through here, so the
  // common case (nothing marked) is decided before the contact store is read.
  const m = load()[ciKey(uin, host)]
  if (m?.gone == null || !holds(m, getCrossIsland(uin, host))) return
  if (!depositAfterMark(srvAt, m.gone, clockOffsetMs())) return
  update(uin, host, m.sk, (x) => {
    delete x.gone
    return x
  })
}

/// The contact was removed: whatever we knew about that address goes with it.
export function forgetPeerLiveness(uin: number, host: string): void {
  const map = load()
  const k = ciKey(uin, host)
  if (!(k in map)) return
  delete map[k]
  save(map)
  bump()
}

const inFlight = new Map<string, Promise<Liveness>>()

/// Ask `uin@host`'s island whether the contact pinned there still exists, and
/// mark the answer. `open` runs at most once a day per address, `failure` at
/// most every few minutes. Never throws; a skipped probe answers `unknown`.
///
/// Only for a contact held in the cross-island store: the pinned key is half
/// of the question, and without one there is nobody to ask about.
export function probePeerLiveness(
  identity: WebIdentity,
  uin: number,
  host: string,
  trigger: 'open' | 'failure',
): Promise<Liveness> {
  const row = getCrossIsland(uin, host)
  if (!row?.signingKey || !row.identityKey) return Promise.resolve('unknown')
  const k = ciKey(uin, host)
  const running = inFlight.get(k)
  if (running) return running
  const map = load()
  // Already gone: the mark stands until they write or a send finds their card
  // under the pinned keys again, and asking again would only renew their
  // record in our island's mirror (see the header).
  if (liveMark(map, uin, host)?.gone != null) return Promise.resolve('gone')
  const prev = rawMark(map, k, row.signingKey)
  const prevAt = trigger === 'open' ? prev?.probedAt : prev?.failProbeAt
  if (prevAt != null) {
    const since = Date.now() - prevAt
    // A clock that went backwards reads as "long ago", not as "never again".
    if (since >= 0 && since < (trigger === 'open' ? OPEN_EVERY_MS : FAILURE_EVERY_MS)) {
      return Promise.resolve('unknown')
    }
  }
  const pin: PinnedKeys = { identityKey: row.identityKey, signingKey: row.signingKey }
  // Stamped before the network, so a reload in the middle does not ask twice.
  const now = Date.now()
  update(uin, host, pin.signingKey, (x) => ({ ...x, probedAt: now, ...(trigger === 'failure' ? { failProbeAt: now } : {}) }), false)
  const p = classify(hostOfApiBase(identity.apiBase), host, uin, pin)
    .catch((): Liveness => 'unknown')
    .then((verdict) => {
      apply(uin, host, pin.signingKey, verdict)
      return verdict
    })
    .finally(() => inFlight.delete(k))
  inFlight.set(k, p)
  return p
}

/// The raw record about `sk` at key `k`, ignoring the row checks: the probe
/// stamp is bookkeeping, valid for as long as the key is the same.
function rawMark(map: Record<string, Mark>, k: string, sk: string): Mark | null {
  const m = map[k]
  return m && sameSigningKey(m.sk, sk) ? m : null
}

function apply(uin: number, host: string, sk: string, verdict: Liveness): void {
  if (verdict === 'gone') {
    update(uin, host, sk, (m) => {
      if (m.gone == null) m.gone = Date.now()
      // A 404 for the number is no card at all, under any key.
      delete m.keyChanged
      return m
    })
  } else if (verdict === 'key_changed') {
    notePinnedCard(uin, host, sk, 'differs')
  } else if (verdict === 'alive') {
    notePinnedCard(uin, host, sk, 'match')
  }
  // moved, unknown: nothing to say, nothing changes.
}

async function getJson(url: string): Promise<IslandReply | null> {
  // Plain AbortController: AbortSignal.timeout is missing from older webviews.
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null // a decoy page, a parked domain: not an answer
    }
    return { status: res.status, body }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function classify(ownHost: string, host: string, uin: number, pin: PinnedKeys): Promise<Liveness> {
  const base = `https://${host}`
  const card = cardStep(await getJson(`${base}/federation/keys/${uin}`), pin)
  if (card !== 'absent') return card
  const owner = ownerStep(
    await getJson(`${base}/federation/uin-for-key?signing_key=${encodeURIComponent(pin.signingKey)}`),
    uin,
  )
  if (owner !== 'absent') return owner
  // Step 3 as strict as the first two: only the island's own "no record", or
  // a verified record naming no other home, is "gone". A failed read is not.
  const record = recordStep(
    await getJson(`https://${ownHost}/federation/gossip-record?sk=${encodeURIComponent(pin.signingKey)}`),
    pin.signingKey,
    host,
    uin,
  )
  return record === 'absent' ? 'gone' : record
}
