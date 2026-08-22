// Federation §5d — cross-island 1:1 call signalling, the transport half.
//
// A same-island call is a plaintext websocket relay: the client sends
// `{type:"call_offer", to_uin, call_id, sdp}` and the island forwards it to the
// other socket. Across an island boundary there is no shared socket, and this
// client sent that frame anyway — a bare `to_uin` down OUR island's socket,
// which our island resolved as a LOCAL number. Calling `1234@is2.rcq.app` rang
// our own #1234: a stranger, who could answer, at which point a real media
// session came up between two people who have never met. The call buttons were
// hidden for a cross-island peer as a stopgap; this module is what replaces it.
//
// Every signal now rides the same one-hop sealed deposit §5f uses: wrap it in a
// `kind:"call"` envelope, v=1-seal it to the peer's identity key, and POST it
// to their PRIMARY island. The island pushes it straight down their socket, or
// (new on 2026-08-15) rings their closed app. Stage 2 (core-metadata plan)
// asks for that ring with `ring:true` on an `envelope_type "message"` deposit
// rather than the more telling type `"call"`: the island honours `ring` and
// keeps the quieter type, so the mailbox learns less about what arrived.
//
// ⚠ The island the deposit lands on now learns that a call is arriving for this
// user, at this instant. Founder decision, taken with that stated: a censor can
// infer a call from packet timing and size anyway, and a call that does not
// ring is not a call. Who is calling, from which island, audio or video, and
// the SDP all stay sealed.
//
// ⚠ TURN is untouched and stays own-island on each side. Media is still P2P;
// only the signalling crosses.

import { getCrossIsland } from './crossisland-store'
import { newUUIDv4, type CallEnvelope, type WebIdentity } from './crypto'
import { depositSealedWithKeys, fetchPeerKeyCard } from './federation-send'
import { logCall } from './outgoing-store'

/// A `call_offer` older than this is not a call any more, it is history: the
/// offline queue drains rows that have been waiting for hours, and ringing for
/// one of them would be a phantom call from someone who long since gave up.
/// Same number on all three clients (Android `callOfferTtlSec`, iOS §5d).
export const CALL_OFFER_TTL_SEC = 60

/// Trickle ICE arrives as a burst of a dozen candidates in a second or two.
/// Same-island that is free — they ride an open socket. Cross-island each one
/// would be its own deposit, and since 2026-08-15 its own RING on a peer whose
/// app is closed. Collect a burst into ONE `call_ice` envelope carrying a
/// `candidates` JSON array; the debounce trades a fraction of a second of setup
/// latency for a call that wakes the peer once instead of a dozen times.
/// Android does the same, with the same window, and both phones already read
/// the batched shape.
const ICE_DEBOUNCE_MS = 350

/// How long a resolved sealing key is reused before the peer's card is fetched
/// again. A call is a burst of signals over a few seconds; re-fetching the card
/// in front of each of them puts a round trip where the user hears silence.
const KEY_TTL_MS = 5 * 60_000

export function buildCallSignal(sig: string, cid: string, data: Record<string, string>): CallEnvelope {
  return {
    kind: 'call',
    id: newUUIDv4(),
    sig,
    cid,
    ts: Math.floor(Date.now() / 1000), // epoch SECONDS, same as `contactreq`
    data,
  }
}

/// Coerce a signal's extra fields to the wire shape: `data` is typed
/// `Map<String, String>` on Android and `[String: String]` on iOS, so a number
/// or a boolean in there is a DECODE ERROR on both phones — the signal is
/// dropped in silence, and a dropped signal is a call that rings and never
/// connects. Anything that is not a primitive is left out entirely rather than
/// stringified into `[object Object]`.
function toWireData(extra: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === 'string') out[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
  }
  return out
}

// ── sealing keys ──────────────────────────────────────────────────────

const keyCache = new Map<string, { keys: { identityKey: string; signingKey: string }; at: number }>()

/// Resolve the key to seal to for `uin@host`. Prefers a fresh card (so a peer
/// who rotated is still reachable) and falls back to the keys pinned when the
/// contact was added (so a call still goes out when their island cannot serve
/// its card right now). Read-only: sealing to a key never writes one, and the
/// pinned pair stays the anti-impersonation anchor (§2.4).
async function sealingKeys(
  host: string,
  uin: number,
): Promise<{ identityKey: string; signingKey: string } | null> {
  const cacheKey = `${uin}@${host}`
  const hit = keyCache.get(cacheKey)
  if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.keys
  const card = await fetchPeerKeyCard(host, uin)
  const pinned = getCrossIsland(uin, host)
  const identityKey = card?.identity_key || pinned?.identityKey
  if (!identityKey) return null
  const keys = { identityKey, signingKey: card?.signing_key || pinned?.signingKey || '' }
  keyCache.set(cacheKey, { keys, at: Date.now() })
  return keys
}

/// §5d: which call signals must wake a CLOSED app. THE INNER ENVELOPE IS THE
/// SAME EITHER WAY; this only decides whether the recipient's island rings a
/// device that holds no live socket (Stage 2: via `ring:true`, not a louder
/// `envelope_type`).
///
/// Only the two signals that must reach a closed app ask for the ring: the
/// OFFER, which IS the call, and the END, which takes the ring back down when
/// the caller gives up before pickup — otherwise the callee's phone keeps
/// ringing at someone who already left. `call_answer`, `call_ice` and the
/// renegotiate/ice-restart pairs only mean anything to an app that is already
/// awake holding this call, so they never ring.
///
/// ⚠ Ringing on EVERY signal would wake the peer's phone repeatedly: with the
/// 350 ms ICE debounce still several rings per call, and one more timing
/// disclosure to their island for each. iOS (`CrossIslandSender.swift`,
/// `wakingSignals`) and Android (`CrossIslandSender.kt`, `callEnvelopeType`)
/// draw the line at exactly these two; all three must agree or a call wakes a
/// killed phone on one platform and not the other.
const WAKING_SIGNALS = new Set(['call_offer', 'call_end'])

async function deposit(
  identity: WebIdentity,
  host: string,
  uin: number,
  env: CallEnvelope,
): Promise<boolean> {
  const keys = await sealingKeys(host, uin)
  if (!keys) return false
  // Every call signal deposits as `envelope_type "message"`; a waking signal
  // adds `ring:true` so an island finding no live socket rings the peer instead
  // of posting a message banner. An island that honours `ring` (Stage 2 server)
  // rings without learning the type is a call. One that does not still routes
  // and queues the row, so the call degrades to no-wake rather than breaking.
  return depositSealedWithKeys(identity, host, uin, env, keys, 'message', WAKING_SIGNALS.has(env.sig))
}

// ── ICE micro-batching ────────────────────────────────────────────────

interface IceBatch {
  identity: WebIdentity
  host: string
  uin: number
  candidates: string[]
  timer: ReturnType<typeof setTimeout>
}

const iceBatches = new Map<string, IceBatch>()

/// Send everything buffered for `callId` as one envelope. Takes the buffer out
/// of the map SYNCHRONOUSLY, before its first await, so a signal that flushes
/// on its way out cannot race a teardown that drops the same buffer.
async function flushIce(callId: string): Promise<void> {
  const batch = iceBatches.get(callId)
  if (!batch) return
  iceBatches.delete(callId)
  clearTimeout(batch.timer)
  if (!batch.candidates.length) return
  await deposit(
    batch.identity,
    batch.host,
    batch.uin,
    // The batched shape both phones read: a JSON ARRAY of the same candidate
    // strings a single `candidate` would have carried, under `candidates`.
    buildCallSignal('call_ice', callId, { candidates: JSON.stringify(batch.candidates) }),
  )
}

/// Forget a call's buffered candidates without sending them. Called from
/// teardown: a call that ended has nothing to negotiate, and a buffer left in
/// the map would fire its timer into a dead call.
export function dropCrossIslandIce(callId: string): void {
  const batch = iceBatches.get(callId)
  if (!batch) return
  iceBatches.delete(callId)
  clearTimeout(batch.timer)
}

// ── send ──────────────────────────────────────────────────────────────

/// Deposit one call signal to `uin@host`. Returns true when their island
/// accepted it; an ICE candidate returns true as soon as it is buffered, since
/// its delivery is decided by the flush a moment later.
///
/// Never throws — the caller is a WebRTC callback, and a rejected promise
/// inside one is an unhandled rejection that tells the user nothing.
export async function sendCrossIslandSignal(
  identity: WebIdentity,
  host: string,
  uin: number,
  sig: string,
  callId: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  if (sig === 'call_ice') {
    const candidate = typeof extra.candidate === 'string' ? extra.candidate : ''
    if (!candidate) return false
    const existing = iceBatches.get(callId)
    if (existing) clearTimeout(existing.timer)
    const candidates = existing ? [...existing.candidates, candidate] : [candidate]
    iceBatches.set(callId, {
      identity,
      host,
      uin,
      candidates,
      timer: setTimeout(() => void flushIce(callId), ICE_DEBOUNCE_MS),
    })
    return true
  }
  // Any other signal flushes this call's pending candidates first, so none are
  // stranded behind an answer or a hangup that overtook them.
  await flushIce(callId)
  return deposit(identity, host, uin, buildCallSignal(sig, callId, toWireData(extra)))
}

// ── receive ───────────────────────────────────────────────────────────

/// The row a STALE cross-island offer leaves behind (§5d): it never rings, but
/// it was a genuinely missed call and the conversation should say so. Written
/// with the offer's OWN timestamp rather than now, so it sits where it happened
/// in the thread, and tagged with the peer's island so it lands in their
/// conversation and not a local namesake's.
///
/// The two halves of the label are i18n KEYS resolved at render time, matching
/// `logFinishedCall` in `call.tsx` — the row outlives the language the app
/// happened to be in when the call came in.
export function fileMissedCrossIslandOffer(
  peerUin: number,
  host: string,
  media: string,
  tsSeconds: number,
): void {
  const kind = media === 'video' ? 'call.log.video' : 'call.log.voice'
  logCall(
    peerUin,
    `${kind}|call.log.incoming|call.log.missed`,
    true,
    tsSeconds * 1000,
    host,
  )
}
