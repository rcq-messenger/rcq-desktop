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
// ⚠ Only a Stage 2 island (server 2026.08.22.15+) knows `ring`. An older one,
// a foreign self-host that may stay old for months, ignores the field and
// rings a closed app ONLY for type "call", so the quiet form there is a call
// that never rings. Before a waking deposit we ask the peer island's
// /server/info for `capabilities.envelope_class` and fall back to the legacy
// type "call" when it is not plainly true. Founder's rule: a call that does
// not ring is not a call; the legible row is paid only on islands that cannot
// do better. Same logic on Android and iOS.
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
import { loadServerInfo } from './server-info'

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

// ── does the peer island honour `ring`? ───────────────────────────────

/// How long a "yes, I honour `ring`" is trusted before the island is asked
/// again. A yes only turns into a no through a downgrade, so an hour is cheap.
const RING_YES_TTL_MS = 60 * 60_000

/// How long a "no" (false, absent, or no usable answer at all) is remembered.
/// Short on purpose: an island that upgrades should start ringing the quiet
/// way within minutes, and a single timeout or blocked route at that instant
/// must not brand it old for the rest of the run.
const RING_NO_TTL_MS = 10 * 60_000

/// The probe sits on the press-to-ringback path of the offer. Five seconds is
/// well over a healthy round trip and well under the point where the caller
/// decides the call is dead; on timeout the deposit takes the legacy form.
const RING_PROBE_TIMEOUT_MS = 5_000

const ringCache = new Map<string, { honours: boolean; at: number }>()
const ringInFlight = new Map<string, Promise<boolean>>()

/// True only when `host` plainly advertises `capabilities.envelope_class`,
/// the flag born together with `ring`. Anything else (an older island, a 404,
/// a failed or timed-out fetch, an unparseable body) is false: the caller
/// then pays the legible type "call" rather than risk a silent phone.
///
/// Plain `fetch`, the same way the deposit itself travels, so an island that
/// is blocked for a direct probe but reachable for the deposit does not look
/// "old" for a reason that has nothing to do with its age. The timeout is its
/// own abort and nothing else: the page's only transport state (`front.ts`)
/// rewrites the flagship origin and never grades a host on a failed request,
/// so a probe that runs out of time only yields false here, it does not move
/// the deposit onto another road. One request per host at a time: an offer
/// and a hangup racing for the same island share it.
async function honoursRing(host: string): Promise<boolean> {
  const hit = ringCache.get(host)
  if (hit && Date.now() - hit.at < (hit.honours ? RING_YES_TTL_MS : RING_NO_TTL_MS)) return hit.honours
  const pending = ringInFlight.get(host)
  if (pending) return pending
  const p = (async () => {
    // Plain AbortController: AbortSignal.timeout is still missing from older
    // webviews this page runs in (same reason as `fetchWithTimeout`).
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), RING_PROBE_TIMEOUT_MS)
    let honours = false
    try {
      const info = await loadServerInfo(`https://${host}`, { signal: ctl.signal })
      honours = info?.capabilities.envelope_class === true
    } catch {
      // `loadServerInfo` never throws; belt and braces so a warm-up nobody
      // awaits can never surface as an unhandled rejection.
    } finally {
      clearTimeout(timer)
      ringCache.set(host, { honours, at: Date.now() })
      ringInFlight.delete(host)
    }
    return honours
  })()
  ringInFlight.set(host, p)
  return p
}

/// Resolves once no probe of `host` is in flight. Never starts one.
///
/// Ordering guard for the signals that do not ring: each signal is deposited
/// from its own task, and the probe holds back only the offer. Without this a
/// `call_ice` batch, which never probes, would land in the callee island's
/// queue AHEAD of the offer it belongs to, and an Android callee drops ICE that
/// arrives before the offer. So nothing goes to a host while its probe runs.
function ringProbeSettled(host: string): Promise<void> {
  const pending = ringInFlight.get(host)
  return pending ? pending.then(() => undefined, () => undefined) : Promise.resolve()
}

/// Start the ring probe for `host` ahead of the offer, from the place where an
/// outgoing cross-island call begins. Fire-and-forget: by the time the offer
/// is built the answer is usually in the memo and the offer pays no round trip
/// for it. A failure here changes nothing; the offer's own `honoursRing` asks
/// again. Never called for a same-island call, which has no host to ask.
export function warmCrossIslandRing(host: string): void {
  void honoursRing(host)
}

/// §5d: which call signals must wake a CLOSED app. THE INNER ENVELOPE IS THE
/// SAME EITHER WAY; this only decides whether the recipient's island rings a
/// device that holds no live socket (Stage 2: via `ring:true`, not a louder
/// `envelope_type`; legacy type "call" only for an island that cannot read
/// `ring`, see `honoursRing`).
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

// ── per-call ordering ─────────────────────────────────────────────────

/// The last deposit asked for on each call id, so the next one can queue
/// behind it.
const callTails = new Map<string, Promise<unknown>>()

/// Run `work` after every earlier deposit of the same call has finished.
///
/// Each signal deposits from its own task, so without this the order in which
/// they land in the callee island's queue is whatever the network makes of it.
/// That was a narrow race while every deposit cost the same one POST; the
/// offer now also pays the ring probe on a slow island, and an ICE batch
/// released the instant that probe settles would POST side by side with the
/// offer it belongs to. An Android callee drops ICE that arrives before its
/// offer, and the call sits in "connecting". Android chains per call id in
/// exactly this way (`Session.depositCallSignal`), and so does iOS.
function inCallOrder(cid: string, work: () => Promise<boolean>): Promise<boolean> {
  const prev = callTails.get(cid) ?? Promise.resolve()
  const next = prev.then(work, work)
  callTails.set(cid, next)
  const settle = () => {
    if (callTails.get(cid) === next) callTails.delete(cid)
  }
  next.then(settle, settle)
  return next
}

function deposit(
  identity: WebIdentity,
  host: string,
  uin: number,
  env: CallEnvelope,
): Promise<boolean> {
  return inCallOrder(env.cid, () => depositNow(identity, host, uin, env))
}

async function depositNow(
  identity: WebIdentity,
  host: string,
  uin: number,
  env: CallEnvelope,
): Promise<boolean> {
  const waking = WAKING_SIGNALS.has(env.sig)
  // The ring probe runs ALONGSIDE the key card fetch, not after it: both are
  // a round trip to the same island and the offer is waiting on the slower of
  // the two, not their sum. A non-waking signal never probes; it does not ring
  // on any island, so the answer would change nothing about it. It does WAIT
  // for a probe already running for this host (`ringProbeSettled`), so a
  // signal of ANOTHER call to the same island cannot slip in mid-probe either;
  // signals of the same call are already queued behind each other above.
  const [keys, ringHonoured] = await Promise.all([
    sealingKeys(host, uin),
    waking ? honoursRing(host) : ringProbeSettled(host).then(() => false),
  ])
  if (!keys) return false
  // A call signal deposits as `envelope_type "message"`; a waking signal adds
  // `ring:true` so an island finding no live socket rings the peer instead of
  // posting a message banner. An island that honours `ring` (Stage 2 server)
  // rings without learning the type is a call. One that does not would route
  // and queue the row in silence, so for it alone the waking signal goes out
  // as the legacy type "call", the only thing such an island rings for.
  // `ring:true` rides along either way: harmless on the old island, and the
  // deposit is shaped the same on all three clients.
  const envelopeType = waking && !ringHonoured ? 'call' : 'message'
  return depositSealedWithKeys(identity, host, uin, env, keys, envelopeType, waking)
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
