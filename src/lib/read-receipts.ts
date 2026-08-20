// Read receipts, the sending half (#636/#637). When the user is LOOKING at a
// 1:1 thread — tab visible, thread open — the peer's messages there count as
// read, and the peer is told so: inner kind 'read', outer type 'read' (routed
// by every client in the field, never pushed by the island). 1:1 only: a
// group message has as many readers as members and one receipt cannot speak
// for them.
//
// What was already receipted is remembered per thread in localStorage, so a
// reopened chat does not re-announce the whole history. The FIRST run on an
// install seeds that memory with everything currently in the thread WITHOUT
// sending (the news-badge rule: an archive the user lived with is not
// suddenly "just read" — and a peer must not get a storm of receipts for
// last month's messages the moment this build ships).
//
// Best-effort like the delivered receipt: a lost receipt costs a tick, never
// a message, and nothing retries.

import { scopedKey } from './account-scope'
import { Api, peerBundleFrom } from './api'
import { encryptV1, type Envelope, type WebIdentity } from './crypto'
import { sendV2 } from './signal-device'

/// Ids remembered per thread. Old ids fall off the front; the age gate below
/// keeps that from ever re-receipting them.
const CAP = 800
/// Receipts only reach back this far. Anything older is history, not reading.
const MAX_AGE_MS = 14 * 24 * 3600_000
/// targetIDs per envelope, so a long unread run still ships in sane packets.
const BATCH = 60

function keyFor(peer: number): string {
  return scopedKey(`readsent.peer.${peer}`)
}

function loadSent(peer: number): string[] | null {
  try {
    const raw = localStorage.getItem(keyFor(peer))
    if (raw == null) return null
    const arr = JSON.parse(raw) as string[]
    return Array.isArray(arr) ? arr : null
  } catch {
    return null
  }
}

function saveSent(peer: number, ids: string[]): void {
  try {
    localStorage.setItem(keyFor(peer), JSON.stringify(ids.length > CAP ? ids.slice(ids.length - CAP) : ids))
  } catch {
    /* quota — the age gate keeps repeats rare */
  }
}

// One send at a time per peer: the effect that calls this fires on every
// incoming-rows change, and two overlapping runs would receipt the same ids.
const inFlight = new Set<number>()

/// The thread is on screen: receipt whatever the peer sent that has not been
/// receipted yet. `rows` is the thread's incoming half (all authored by the
/// peer in a 1:1).
export function noteThreadViewed(
  identity: WebIdentity,
  peer: number,
  rows: ReadonlyArray<{ id: string; at: number }>,
): void {
  if (peer === identity.uin) return // Saved Messages read themselves
  const stored = loadSent(peer)
  if (stored == null) {
    // First run here: everything already in the thread predates read
    // receipts from this install. Remember it, announce nothing.
    saveSent(peer, rows.map((r) => r.id))
    return
  }
  const sent = new Set(stored)
  const now = Date.now()
  const fresh = rows.filter((r) => !sent.has(r.id) && now - r.at < MAX_AGE_MS).map((r) => r.id)
  if (fresh.length === 0 || inFlight.has(peer)) return
  inFlight.add(peer)
  // Marked BEFORE the wire: a receipt that fails to send is a tick the peer
  // does not get — same contract as the delivered receipt, and it keeps a
  // failing island from turning every rows-change into a resend burst.
  saveSent(peer, [...stored, ...fresh])
  void (async () => {
    try {
      for (let i = 0; i < fresh.length; i += BATCH) {
        await sendReadReceipt(identity, peer, fresh.slice(i, i + BATCH))
      }
    } finally {
      inFlight.delete(peer)
    }
  })()
}

/// v=2 with the v=1 fallback, exactly like the delivered receipt next to it
/// in message-receiver.tsx.
async function sendReadReceipt(identity: WebIdentity, peerUin: number, targetIDs: string[]): Promise<void> {
  const env: Envelope = { kind: 'read', targetIDs }
  try {
    const reached = await sendV2(identity, peerUin, env, 'read').catch(() => 0)
    if (reached === 0) {
      const info = await Api.userInfo(identity, peerUin).catch(() => null)
      if (!info?.identity_key || !info.signing_key) return
      const bundle = peerBundleFrom({
        uin: peerUin,
        identity_key: info.identity_key,
        signing_key: info.signing_key,
      })
      await Api.sendSealed(identity, peerUin, encryptV1(env, identity, bundle), 'read')
    }
  } catch {
    /* the peer keeps a plain tick */
  }
}
