// Group broadcasts whose sender key has not arrived yet, kept on DISK.
//
// A `gmsg` is encrypted under a sender-key chain, and the chain arrives in a
// separate `skdm` envelope. Live delivery is unordered, so a broadcast can
// land before its own key; the core holds those in memory (held-gmsg.ts) and
// asks the chain's owner to re-send it. In a browser tab that is enough: the
// tab is still open when the answer comes back.
//
// A CLI is not a tab. `rcq send` lives about three seconds, and the drain acks
// the queue row before it exits, so an in-memory hold means the island lets
// go of a message this box has not read and never will. That is the exact loss
// class the "durable before ack" rule in receive.ts exists for, so the raw
// packet is written here first and replayed on later runs, until it opens or
// gets too old to matter.
//
// ⚠ Replay must not turn into a NACK storm. `handleGmsg` fires one recovery
// request per unknown kid per ten minutes, but that debounce is per PROCESS,
// and a cron'd `rcq send` is a new process every minute. So the stamp is kept
// here too, and an entry whose kid is still unknown is not even handed to
// `handleGmsg` until the window is up: replaying it could not have succeeded
// anyway, and the only thing it would produce is the request we already sent.

import fs from 'node:fs'
import type { WebIdentity } from '../../src/lib/crypto'
import { b64ToBytes } from '../../src/lib/crypto'
import { handleGmsg, type RoutedGmsg } from '../../src/lib/sender-key-receive'
import { knowsKid, ownsKid } from '../../src/lib/sender-key-store'
import type { GmsgWire } from '../../src/lib/sender-keys'
import { statePath } from './state'

/// Same ladder `sender-key-receive.ts` climbs for its own NACKs: the window
/// doubles per unanswered ask, and past the ladder the kid is written off
/// for a week. A kid whose owner deleted their account has no answerer, and
/// the flat ten-minute window turned that into a forever machine (366
/// whole-room fan-outs in 12h from one 24/7 install, measured 30.08).
const NACK_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 24 * 3600_000]
const NACK_ATTEMPTS_MAX = NACK_BACKOFF_MS.length
const NACK_WRITEOFF_MS = 7 * 24 * 3600_000
/// The longest a stamp can still matter, for the save-time sweep.
const NACK_WINDOW_MS = NACK_WRITEOFF_MS
/// Past this a broadcast is not worth carrying: the owner has answered every
/// recovery request it is going to answer, and the room has moved on.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
/// A hostile flood of un-openable broadcasts must stay cheap. Oldest first.
const CAP = 200

interface HeldRow {
  at: string
  gid: number
  kid: string
  payload: string
}

interface HeldFile {
  held: HeldRow[]
  /// kid -> the ask ledger, so a fresh process does not re-ask a question
  /// that is still in flight (or one that has been asked to death). Old
  /// files carry a bare epoch-ms number; `load` upgrades it to one attempt.
  nacked: Record<string, { n: number; at: number }>
}

function file(uin: number): string {
  return statePath(`gmsg-held-${uin}.json`)
}

function load(uin: number): HeldFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file(uin), 'utf8')) as {
      held?: HeldRow[]
      nacked?: Record<string, number | { n: number; at: number }>
    }
    const nacked: HeldFile['nacked'] = {}
    for (const [kid, v] of Object.entries(raw.nacked ?? {})) {
      nacked[kid] = typeof v === 'number' ? { n: 1, at: v } : v
    }
    return { held: Array.isArray(raw.held) ? raw.held : [], nacked }
  } catch {
    return { held: [], nacked: {} }
  }
}

function save(uin: number, f: HeldFile): void {
  const cutoff = Date.now() - MAX_AGE_MS
  f.held = f.held.filter((h) => Date.parse(h.at) > cutoff).slice(-CAP)
  for (const [kid, rec] of Object.entries(f.nacked)) {
    // A stamp outlives its packets by one write-off and no longer.
    if (rec.at < Date.now() - NACK_WINDOW_MS && !f.held.some((h) => h.kid === kid)) delete f.nacked[kid]
  }
  try {
    fs.writeFileSync(file(uin), JSON.stringify(f), { mode: 0o600 })
  } catch {
    /* an unwritable state dir is already being shouted about elsewhere */
  }
}

/// The kid a broadcast is sealed under, without decrypting anything. Null for
/// a packet that is not a gmsg wire at all.
function kidOf(payloadB64: string): string | null {
  try {
    const wire = JSON.parse(new TextDecoder().decode(b64ToBytes(payloadB64))) as GmsgWire
    return typeof wire.kid === 'string' ? wire.kid : null
  } catch {
    return null
  }
}

/// Open one group broadcast. Returns the routed message, or null when there is
/// nothing to show for it, and in the one null case that is RECOVERABLE (a
/// chain we have never been handed) the raw packet is kept for a later run.
///
/// The other nulls are terminal and deliberately not kept: our own broadcast
/// echoed back by the island, a replay of a position the chain already passed,
/// or a packet that failed its AEAD or its signature.
export async function openGroupPacket(
  identity: WebIdentity,
  payloadB64: string,
  gid: number,
): Promise<RoutedGmsg | null> {
  const got = await handleGmsg(identity, payloadB64, gid)
  if (got) return got
  const kid = kidOf(payloadB64)
  if (!kid || ownsKid(identity.uin, kid) || knowsKid(identity.uin, kid)) return null
  const f = load(identity.uin)
  if (!f.held.some((h) => h.kid === kid && h.payload === payloadB64)) {
    f.held.push({ at: new Date().toISOString(), gid, kid, payload: payloadB64 })
  }
  // handleGmsg has just sent the recovery request for this kid.
  f.nacked[kid] = Date.now()
  save(identity.uin, f)
  return null
}

export interface ReplayedPacket extends RoutedGmsg {
  gid: number
  /// When the packet first reached this box, ISO 8601. A broadcast can sit here
  /// for days waiting on its chain, and printing it as if it had just been said
  /// puts it in the wrong place in the conversation.
  at: string
}

/// Retry every stored broadcast whose chain may have arrived since. Whatever
/// opens is returned (and dropped from the store); a packet whose kid is now
/// known but still will not open is terminal and dropped too. Only genuinely
/// pending ones stay.
export async function replayStoredGroupPackets(identity: WebIdentity): Promise<ReplayedPacket[]> {
  const f = load(identity.uin)
  if (f.held.length === 0) return []
  const out: ReplayedPacket[] = []
  const keep: HeldRow[] = []
  for (const h of f.held) {
    if (!knowsKid(identity.uin, h.kid)) {
      // Still no chain. Asking again is the only move - up the ladder, and
      // past its top only once a week.
      const rec = f.nacked[h.kid]
      const wait = rec == null
        ? 0
        : rec.n >= NACK_ATTEMPTS_MAX
          ? NACK_WRITEOFF_MS
          : NACK_BACKOFF_MS[rec.n - 1]
      if (rec != null && Date.now() - rec.at < wait) {
        keep.push(h)
        continue
      }
      f.nacked[h.kid] = { n: Math.min((rec?.n ?? 0) + 1, NACK_ATTEMPTS_MAX + 1), at: Date.now() }
      await handleGmsg(identity, h.payload, h.gid).catch(() => null)
      keep.push(h)
      continue
    }
    const got = await handleGmsg(identity, h.payload, h.gid).catch(() => null)
    if (got) out.push({ ...got, gid: h.gid, at: h.at })
    // Known kid and no message: the chain has ratcheted past this position, or
    // the packet is corrupt. Either way no future run can do better.
  }
  f.held = keep
  save(identity.uin, f)
  return out
}
