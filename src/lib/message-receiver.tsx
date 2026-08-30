// App-wide receive loop. Mounted once under WSProvider. On connect it ensures
// this account is provisioned as a libsignal device, drains the offline queue,
// and decrypts each envelope; live WS `message` pushes are decrypted too. Both
// feed the incoming-store, deduped by envelope id. Renders nothing.

import { useEffect } from 'react'
import { useIdentity } from './identity-context'
import { useWS } from './ws'
import { currentDeviceId, decryptIncoming, getDevice, myDeviceId, noteInboundFrom, resetSilenceProbes, sendV2 } from './signal-device'
import { addIncoming, addGroupIncoming, hydrateIncoming, beginCatchUp, endCatchUp, flushHistory, markDeleted,
  applyRemoteRead,
} from './incoming-store'
import { applyEditToOutgoing, carbonThreadKey, fileOutgoingCarbon } from './outgoing-store'
import { publishHomeIslandRecord } from './federation-publish'
import { answerKeyAsk, loadRoomKeys, putRoomKey } from './group-state'
import { snapshotFor } from './contacts-cache'
import { adoptHomesFromOwnRecord, applyPushedRecord, drainBackupQueues, listBackupHomes, scrubFrontAliasHomes } from './multihome'
import { aliasFor, drainVisitedQueues, listVisitedIslands } from './visited-islands'
import { getCrossIsland } from './crossisland-store'
import { ensureRequestsLoaded, holdRequestMessage, isBlocked } from './crossisland-requests'
import { isContact, shouldQuarantineStranger } from './stranger-requests'
import { handleContactReq } from './crossisland-contactreq'
import { CALL_OFFER_TTL_SEC, fileMissedCall, fileMissedCrossIslandOffer } from './crossisland-call'
import { deliverCrossIslandCallSignal } from './call'
import { myCallPolicy } from './call-privacy'
import { handleProfile, pushProfileTo } from './crossisland-profile'
import { decodeGmsg, handleGmsg, handleSkdm, handleSknack, replayHeldGmsg } from './sender-key-receive'
import { ackLiveGroupRow, drainGroupLog, forgetVouched, islandHasGroupLog, type GroupLogRequest } from './group-log'
import { Api, peerBundleFrom } from './api'
import { encryptV1 } from './crypto'
import type { CallEnvelope, ContactReqEnvelope, Envelope, ProfileEnvelope, WebIdentity } from './crypto'

// Hydrate the incoming store once per account per app load. Both receive paths
// (the primary connect-drain and the backup-island poll, which runs even when
// the primary is down) must wait on the SAME hydration so the seen-set dedup
// is populated before either ingests a row.
let hydratedFor: number | null = null
let hydration: Promise<void> = Promise.resolve()
function ensureHydrated(uin: number): Promise<void> {
  if (hydratedFor !== uin) {
    hydratedFor = uin
    hydration = hydrateIncoming(uin)
    // The room-key store is per-account and every page needs it hydrated -
    // a tab opened straight into a chat never mounts Contacts, and a key
    // minted there was held in memory only and lost on reload.
    loadRoomKeys(uin)
  }
  return hydration
}

/// §5d: apply one decrypted cross-island call signal.
///
/// The gates, in the spec's order — none of them is a WebRTC concern, which is
/// why they live here and not in the call state machine:
///
///  1. Blocked sender → nothing. Sealed sender means the island cannot filter
///     by who sent it, so the block is enforced on receipt or not at all.
///  2. Not an ACCEPTED cross-island contact → DROPPED, never quarantined.
///     A message from a stranger waits in the requests list; a call signal
///     cannot wait for anything, and holding an offer nobody will read until
///     tomorrow would file a phantom call rather than ask a question.
///  3. A `call_offer` older than 60s → stale. Offline drains deliver rows that
///     have been queued for hours, and each one would ring for a call the other
///     side abandoned long ago. It is filed as the missed call it really was,
///     stamped with the offer's own time.
///
/// ⚠ Nothing has type-checked this envelope: the receive path is
/// `JSON.parse(...) as Envelope`, so every field here can be any JSON a hostile
/// peer felt like depositing. A throw would abort the whole queue drain (which
/// catches per BATCH, not per row) — every drain, forever — so each field is
/// coerced rather than trusted, exactly as §5f does.
function handleCallSignal(senderUin: number, senderHost: string, env: CallEnvelope): void {
  if (isBlocked(senderUin, senderHost)) return
  if (!getCrossIsland(senderUin, senderHost)) return
  const sig = typeof env.sig === 'string' ? env.sig : ''
  // Only the signals this wire defines. Anything else is a NEWER client than
  // this one: ignore it, the way iOS (`default: break`) and Android already do.
  if (!sig.startsWith('call_')) return
  const cid = typeof env.cid === 'string' ? env.cid : ''
  if (!cid) return
  const ts = typeof env.ts === 'number' && Number.isFinite(env.ts) ? env.ts : 0
  // `data` values are strings on the wire; anything else is from a client that
  // broke the contract, and is left out rather than coerced into the state
  // machine as an `[object Object]` SDP.
  const data: Record<string, string> = {}
  if (env.data && typeof env.data === 'object') {
    for (const [k, v] of Object.entries(env.data as Record<string, unknown>)) {
      if (typeof v === 'string') data[k] = v
    }
  }
  if (sig === 'call_offer' && Math.floor(Date.now() / 1000) - ts > CALL_OFFER_TTL_SEC) {
    // The call id goes on the row: the caller may ALSO have deposited a
    // `call_missed` marker for this same call, and the two must collapse into
    // one line rather than tell the conversation about two calls.
    fileMissedCrossIslandOffer(senderUin, senderHost, data.media ?? 'audio', ts, cid)
    return
  }
  // A caller-written missed-call marker: the call is long over, so it files the
  // row and rings nothing. Dedupe is the row id, derived from `cid`.
  if (sig === 'call_missed') {
    fileMissedCall(senderUin, senderHost, data.media ?? 'audio', ts, cid)
    return
  }
  // Non-offer signals need no freshness rule of their own: they already no-op
  // unless they match the call this client currently has open.
  deliverCrossIslandCallSignal({
    type: sig,
    from_uin: senderUin,
    from_host: senderHost,
    call_id: cid,
    ...data,
  })
}

/// §5d: the ONE call envelope that arrives from our OWN island.
///
/// Everything else a same-island call needs rides the plaintext websocket
/// relay, so an envelope that did not cross a boundary is normally ignored. The
/// exception is `call_missed`: a marker the CALLER deposits when the island
/// told them we could not be reached at all, so that a client which was not
/// running still learns it was called (#678/#686). It never rings, since the
/// call is long over: it files the row the live path would have filed.
///
/// ⚠⚠ THE GATES HERE ARE THE WHOLE OF THE CONSENT CHECK. This branch sits above
/// the stranger quarantine in `route()` and is never reached by it, and a
/// marker is an ORDINARY SEALED DEPOSIT that any number on the island can
/// compose: nothing behind it was ever policed by the island, because no
/// signalling happened. So it asks the same question the island asks before it
/// lets a `call_offer` through (`_caller_allowed` in `routers/ws.py`), which it
/// asks on the websocket path ONLY.
///
/// Under "everyone" a stranger passes, and that is honest rather than a hole:
/// the same stranger may ring this account for real, and a ring nobody answers
/// leaves the same row. What the policy stops is a number the user has already
/// told the island may not call them.
function handleSameIslandCallEnvelope(myUin: number, senderUin: number, env: CallEnvelope): void {
  if (typeof env.sig !== 'string' || env.sig !== 'call_missed') return
  // host '' is how a same-island row is keyed in the shared block store.
  if (isBlocked(senderUin, '')) return
  const policy = myCallPolicy()
  if (policy === 'nobody') return
  if (policy === 'contacts' && !isContact(myUin, senderUin)) return
  const cid = typeof env.cid === 'string' ? env.cid : ''
  // ⚠ No call id, no dedupe key: the same envelope redelivered (acks are
  // best-effort) would file the row again, and again.
  if (!cid) return
  const ts = typeof env.ts === 'number' && Number.isFinite(env.ts) ? env.ts : 0
  const media =
    env.data && typeof env.data === 'object'
      ? ((env.data as Record<string, unknown>).media as string | undefined)
      : undefined
  fileMissedCall(senderUin, null, media === 'video' ? 'video' : 'audio', ts, cid)
}

// Route a decrypted envelope to the 1:1 store or the group store by group_id.
// `myUin` gates carbons (a message we sent from another device, echoed to our
// own uin) — only honour one that's actually signed by us.
function route(
  senderUIN: number,
  senderHost: string | undefined,
  envelope: Parameters<typeof addIncoming>[1],
  groupId: unknown,
  myUin: number,
  ownHost: string,
  senderSigningKey?: string,
  identity?: WebIdentity,
): void {
  if (envelope.kind === 'carbon') {
    if (senderUIN === myUin) {
      // Control carbons first: an edit/delete made on another of our devices
      // targets a row we already have — filing it as a NEW row (the content
      // path below) would be wrong twice over.
      const inner = envelope.env as
        | { kind?: string; targetID?: string; text?: string; at?: number }
        | undefined
      if (inner?.kind === 'edit' && inner.targetID != null) {
        const key = carbonThreadKey(envelope)
        if (key) applyEditToOutgoing(key, inner.targetID, inner.text ?? '')
      } else if (inner?.kind === 'delete' && inner.targetID != null) {
        markDeleted(inner.targetID, { fromSelf: true })
      } else if (inner?.kind === 'readmark') {
        // We read this thread on another device (A2): drop the badge here
        // too, minus anything that arrived after that read. Not a message,
        // so it must never reach fileOutgoingCarbon below.
        applyRemoteRead(envelope.to ?? null, envelope.gid ?? null, inner.at ?? Date.now())
      } else {
        fileOutgoingCarbon(envelope)
      }
    }
    return
  }
  // Sender-keys distribution / recovery (never rendered). SKDM stores the
  // chain bound to its authenticated sender; SKNACK asks the kid owner to
  // re-distribute. Both ride the per-member sealed path.
  // Room state key hand-off / ask-back (stage 6 phase 2). Checked before
  // skdm because both ride the same outer types; the inner kind decides.
  if ((envelope as { kind?: string }).kind === 'gskey') {
    const e = envelope as unknown as { gid?: number; ver?: number; key?: string }
    if (identity && typeof e.gid === 'number' && typeof e.ver === 'number' && typeof e.key === 'string') {
      // Membership gate: only a fellow member's key is worth holding, and the
      // roster snapshot is the client's own view of who that is.
      const snap = snapshotFor(identity.uin)
      const g = snap?.groups.find((x) => x.id === e.gid)
      const fromMember = !!g?.members?.some((m) => m.uin === senderUIN)
      if (fromMember || senderUIN === myUin) {
        if (putRoomKey(e.gid, e.ver, e.key, { replaceEqual: true })) {
          // A fresh key makes the sealed blob readable: nudge whoever draws
          // the group list to re-run the overlay.
          window.dispatchEvent(new Event('rcq-room-keys-changed'))
        }
      }
    }
    return
  }
  if ((envelope as { kind?: string }).kind === 'gsknack') {
    const e = envelope as unknown as { gid?: number }
    if (identity && typeof e.gid === 'number') {
      const snap = snapshotFor(identity.uin)
      const g = snap?.groups.find((x) => x.id === e.gid)
      const asker = g?.members?.find((m) => m.uin === senderUIN)
      if (asker?.identity_key) {
        void answerKeyAsk(identity, asker, e.gid)
      }
    }
    return
  }
  if ((envelope as { kind?: string }).kind === 'skdm') {
    // No identity means no account to file the chain under, and a chain filed
    // under the wrong one is exactly the bug this key shape exists to stop.
    if (identity) {
      const skdm = envelope as unknown as { gid: number; kid: string; e: number; i: number; ck: string }
      const accepted = handleSkdm(identity.uin, senderUIN, senderSigningKey, skdm)
      // A live gmsg can outrun its own SKDM (a drain cannot: skdm rows are
      // served first) and used to be lost for good. Replay whatever was held
      // for this kid through the normal decrypt path, in arrival order; a
      // copy the queue drain also delivers is absorbed by the chain position
      // and the envelope-id dedup downstream of route().
      if (accepted && typeof skdm.kid === 'string') {
        void replayHeldGmsg(identity, skdm.kid)
          .then((msgs) => {
            for (const m of msgs) route(m.senderUIN, undefined, m.envelope, m.gid, myUin, ownHost, undefined, identity)
          })
          .catch(() => {})
      }
    }
    return
  }
  if ((envelope as { kind?: string }).kind === 'sknack') {
    if (identity) void handleSknack(identity, senderUIN, envelope as unknown as { gid: number; kid: string })
    return
  }
  // Federation gossip B1 self-push: a contact handed us their fresh signed
  // home-island record. Verify it's signed by the SAME key that signed this
  // envelope (binds the record to its real sender), reject a ts rollback, and
  // cache their homes for future sends. Never rendered as a message.
  if ((envelope as { kind?: string }).kind === 'homerec') {
    const rec = (envelope as { rec?: unknown }).rec
    if (senderSigningKey && rec != null) applyPushedRecord(senderUIN, senderSigningKey, rec)
    return
  }
  // §5d cross-island call signalling. Sits ABOVE the quarantine for the same
  // reason §5f does, and one more of its own: a signal is EPHEMERAL. Held as a
  // message request it would be a call nobody can answer, sitting in a list,
  // and it must never reach the message store — the conversation gets the
  // one-line call summary the state machine writes when the call is over, not
  // the SDP that set it up. A same-island call otherwise rides the plaintext WS
  // relay; the single envelope that arrives from our own island is the
  // missed-call marker, which has its own handler and its own gates.
  if ((envelope as { kind?: string }).kind === 'call') {
    if (senderUIN !== myUin) {
      if (senderHost && senderHost !== ownHost) {
        handleCallSignal(senderUIN, senderHost, envelope as unknown as CallEnvelope)
      } else {
        handleSameIslandCallEnvelope(myUin, senderUIN, envelope as unknown as CallEnvelope)
      }
    }
    return
  }
  // §5f cross-island contact request / accept / decline. MUST sit above the
  // quarantine below: that quarantine swallows everything from an unaccepted
  // sender into "message requests", and a contactreq from an unaccepted sender
  // is the whole point of the envelope — held as a message it would be invisible
  // as the request it is. Consent metadata only: never the message store.
  // Same-island senders are ignored here; they have the server's /contacts flow.
  if ((envelope as { kind?: string }).kind === 'contactreq') {
    if (senderHost && senderHost !== ownHost && senderUIN !== myUin) {
      handleContactReq(senderUIN, senderHost, envelope as ContactReqEnvelope)
      // §5e: they just accepted us, so from this moment they HOLD us — and all
      // they hold is whatever their key-card fetch caught at add time. Hand
      // them our current name and picture now rather than making them wait for
      // the next time we happen to edit the profile.
      if (
        identity &&
        (envelope as ContactReqEnvelope).act === 'accept' &&
        getCrossIsland(senderUIN, senderHost)
      ) {
        void pushProfileTo(identity, senderHost, senderUIN)
      }
    }
    return
  }
  // §5e cross-island profile refresh: the peer's own name/picture, pushed by
  // them because nothing else can refresh it. Same placement rule as §5f above
  // — ABOVE the quarantine, and never into the message store. Display fields
  // only: `handleProfile` cannot reach a pinned key, and a `profile` from
  // someone we do not hold as an accepted contact is dropped on the floor.
  if ((envelope as { kind?: string }).kind === 'profile') {
    if (senderHost && senderHost !== ownHost && senderUIN !== myUin) {
      handleProfile(senderUIN, senderHost, envelope as ProfileEnvelope)
    }
    return
  }
  if (typeof groupId === 'number') {
    addGroupIncoming(groupId, senderUIN, envelope) // groups are single-island
    return
  }
  // Variant A consent: a message from an un-accepted CROSS-ISLAND sender is
  // quarantined as a "request" instead of landing in the chat list. Accepted
  // (we proactively added them) → normal ingest. Blocked → holdRequestMessage
  // drops it and returns false.
  if (senderHost && senderHost !== ownHost && senderUIN !== myUin) {
    if (!getCrossIsland(senderUIN, senderHost)) {
      holdRequestMessage(senderUIN, senderHost, envelope)
      return
    }
  }
  // The same consent gate for the OWN island, opt-in (Privacy → strangers to
  // requests). host '' marks a same-island row in the shared store. Returning
  // here also skips the delivery receipt below on purpose: a held message
  // must not confirm to a stranger that it landed in front of a human.
  if ((!senderHost || senderHost === ownHost) && senderUIN !== myUin) {
    const kind = (envelope as { kind?: string }).kind ?? ''
    if (shouldQuarantineStranger(myUin, senderUIN, kind)) {
      holdRequestMessage(senderUIN, '', envelope)
      return
    }
  }
  addIncoming(senderUIN, envelope)
  // Tell the sender it ARRIVED.
  //
  // ⚠ Asymmetric on purpose: this browser has no second tick of its own (its
  // outgoing rows are sending/sent/failed and nothing else, deliberately), so
  // it never APPLIES a delivery receipt — but a phone talking to it has one,
  // and without this its message to a web user would keep a single tick
  // forever. The island cannot fill that in: a deposit is sealed and
  // unauthenticated, so it does not know who sent the row it handed us.
  //
  // 1:1 only and never our own carbon: a group message has as many recipients
  // as members and one tick cannot stand for all of them.
  //
  // ⚠ Receipt AFTER the history write lands. The receipt tells the sender the
  // message arrived, and the decrypt above already advanced the ratchet on
  // disk — the queued copy of this same ciphertext can never be opened again.
  // Vouching for arrival while the plaintext's only copy is a scheduled write
  // is how a fan-out copy vanished for good on 2026-08-20. A failed write keeps
  // the tick back — the sender retries nothing, but nothing was promised.
  if (identity && senderUIN !== myUin && groupId == null && 'id' in envelope && envelope.id) {
    const targetID = envelope.id
    void flushHistory()
      .then(() => sendDeliveredReceipt(identity, senderUIN, targetID))
      .catch(() => {})
  }
}

/// Ship one delivery receipt, v=2 with a v=1 fallback, exactly like an ordinary
/// 1:1 send. Best-effort by design: a receipt that does not arrive costs a
/// second tick, never a message.
///
/// ⚠ The OUTER type is "read", not a new label. It decides whether the island
/// pushes (it does not for "read") and whether a client routes the packet live
/// at all — a brand new label would be routed by nobody until every client in
/// the field updated, which for a receipt means the tick stays broken for
/// exactly the oldest builds. The INNER kind is "delivered".
async function sendDeliveredReceipt(
  identity: WebIdentity,
  peerUin: number,
  targetID: string,
): Promise<void> {
  const env: Envelope = { kind: 'delivered', targetIDs: [targetID] }
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
    /* the tick stays where it was */
  }
}

function hostOf(apiBase: string): string {
  try {
    return new URL(apiBase).host
  } catch {
    return 'api.rcq.app'
  }
}

// Drain the PRIMARY island's queue on the ack protocol every other client
// already speaks: rows are fetched with `?ack=1` (the island keeps them), each
// row is acked only after this client actually processed it, and the cursor
// advances over the contiguous acked prefix. A drain interrupted anywhere —
// mid-fetch, mid-decrypt, mid-ack — loses nothing: unacked rows come back on
// the next drain and the envelope-id dedup collapses the repeats.
//
// ⚠ This replaced the legacy ack-less GET, and the difference is not academic.
// The legacy shape advances the cursor past everything returned AT FETCH TIME,
// and this component used to abandon the fetched rows whenever the socket
// flipped `connected` mid-drain — on a machine whose socket kept dying, the
// island had already let go of what the client then threw away. Messages were
// lost permanently, every reconnect, and restarting only restarted the loop.
//
// Single-flight: a flapping socket re-runs the connect effect faster than a
// drain finishes, and two drains racing would double-fetch the same rows.
//
// ⚠ Coalesced, not swallowed. A request that arrives DURING a drain is not
// satisfied by that drain's rows — they were fetched before whatever prompted
// the new request (typically the socket opening, and the island only replays
// the queue over this endpoint; a row queued in between is covered by nothing
// else while the socket then stays healthy). So a request folded into a
// running drain schedules exactly one follow-up pass after it finishes.
let drainInFlight: Promise<void> | null = null
let drainAgain = false

// A fetch that black-holes (a middlebox that eats the response) must not pin
// the single-flight forever. Plain AbortController — AbortSignal.timeout is
// still missing from older webviews this page runs in.
function fetchWithTimeout(url: string, init: RequestInit, ms = 30_000): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer))
}

function drainPrimaryQueue(identity: WebIdentity, catchUp: boolean): Promise<void> {
  if (drainInFlight) {
    drainAgain = true
    return drainInFlight
  }
  const run = (async () => {
    await ensureHydrated(identity.uin) // restore persisted history first
    // The quarantine store is sealed at rest and opens asynchronously. Wait
    // for it here rather than relying on its deferred-write path, so a drain
    // that lands a stranger's first message writes it straight away.
    await ensureRequestsLoaded()
    // A queue drain is history, not news. Without this the backlog arrives as
    // a wall of banners with a chime behind each one, every time the app is
    // opened or the socket reconnects — and the unread badges have already
    // said all of it.
    if (catchUp) beginCatchUp()
    try {
      // Drain as OUR libsignal device: the island then withholds the fan-out
      // copies that were encrypted for a sibling device of this account, which
      // no ratchet here can open.
      const myDev = await myDeviceId(identity)
      // ⚠ No id, no drain. Draining under a guessed one asks for another
      // device's rows — unreadable here — and then acks a cursor computed for
      // that device, which is how a backlog disappears without being read. The
      // queue keeps everything until this install knows which device it is.
      if (myDev === null) return
      await drainLegacyQueue(identity, myDev)
      // Stage 5: the rooms, from their logs, on an island that keeps them.
      // AFTER the legacy queue on purpose: the web stamps a row when it
      // ingests it, and everything the legacy queue still holds for this
      // account predates everything in the log (the account's first log
      // fetch is the line between them), so this order keeps the timeline.
      await drainRoomLog(identity, myDev)
    } catch {
      /* network hiccup — nothing was acked, the next drain redelivers */
    } finally {
      if (catchUp) endCatchUp()
    }
  })().finally(() => {
    drainInFlight = null
    if (drainAgain) {
      drainAgain = false
      // Never as catch-up: the follow-up exists to pick up what arrived while
      // the first pass ran, and that is news, not backlog.
      void drainPrimaryQueue(identity, false)
    }
  })
  drainInFlight = run
  return run
}

// One row off the primary island, legacy queue or room log alike: the dispatch
// by envelope_type that decides which decoder opens it. A `gmsg` is a
// sender-keys broadcast (decoded via the chain; held in memory when the chain
// has not arrived yet, see handleGmsg); everything else is a sealed envelope.
// Throws only on a TRANSIENT failure, which the caller answers by leaving the
// row unacked; everything terminal, "decrypted to nothing" included, returns.
async function ingestPrimaryRow(
  identity: WebIdentity,
  myDev: number,
  r: { envelope_type: string; payload: string; group_id: number | null; to_device_id?: number | null },
): Promise<void> {
  if (typeof r.to_device_id === 'number' && r.to_device_id !== myDev) {
    // A fan-out copy for a sibling device of this account: it was
    // encrypted against a ratchet that lives there, so no decrypt is
    // attempted and it is acked away by the caller. An island that predates
    // the `dev` filter hands out every copy, so this is not dead code.
  } else if (r.envelope_type === 'gmsg' && typeof r.group_id === 'number') {
    // Sender-keys broadcast: not a sealed envelope, decoded via the chain.
    const got = await handleGmsg(identity, r.payload, r.group_id)
    if (got) route(got.senderUIN, undefined, got.envelope, r.group_id, identity.uin, hostOf(identity.apiBase), undefined, identity)
  } else {
    const got = await decryptIncoming(identity, r.payload)
    if (got) {
      // A decrypted envelope proves the sending DEVICE can talk to us:
      // its silence probe stands down (device-scoped; v=1 names none).
      if (got.senderUIN !== identity.uin) noteInboundFrom(got.senderUIN, got.senderDeviceId)
      route(got.senderUIN, got.senderHost, got.envelope, r.group_id, identity.uin, hostOf(identity.apiBase), got.senderSigningKey, identity)
    }
  }
}

// The legacy `/messages/queue` drain, exactly as it has always run (see the
// notes above drainPrimaryQueue). Untouched by Stage 5: it keeps serving 1:1
// rows, and whatever legacy group rows the island wrote for this account
// before its first room-log fetch.
async function drainLegacyQueue(identity: WebIdentity, myDev: number): Promise<void> {
  const res = await fetchWithTimeout(`${identity.apiBase}/messages/queue?ack=1&dev=${myDev}`, {
    headers: { Authorization: `Bearer ${identity.jwt}` },
  })
  if (!res.ok) return
  const rows = (await res.json()) as Array<{
    id: number
    envelope_type: string
    payload: string
    group_id: number | null
    to_device_id?: number | null
    // Stage 2 (core-metadata plan): the island now labels each row with its
    // retention/push class and a durable per-mailbox sequence. Read when
    // present; both fall back to the legacy `envelope_type` / `id`.
    //
    // ⚠ The CURSOR stays on `id` (the ack below). `seq` is GAPPY per device
    // (a sibling device of this account consumes numbers this device never
    // sees), so a gap in `seq` is NOT a missing message and must never move
    // the cursor.
    cls?: number | null
    seq?: number | null
  }>
  const directIds: number[] = []
  const groupIds: number[] = []
  for (const r of rows) {
    try {
      await ingestPrimaryRow(identity, myDev, r)
      // Processed to its end, including "decrypted to nothing", which is
      // terminal. Only a THROW leaves a row unacked: the cursor then stops
      // in front of it and the island redelivers from there next time.
      ;(typeof r.group_id === 'number' ? groupIds : directIds).push(r.id)
    } catch {
      /* transient failure: leave unacked for redelivery */
    }
  }
  if (directIds.length || groupIds.length) {
    // ⚠ Before the ack, not after. An ack tells the island it may let go of
    // these rows, and history writes are coalesced: promising that while
    // their only copy is a scheduled write is how a crash in between loses
    // messages for good.
    await flushHistory()
    // Best-effort, like Android: a lost ack redelivers, the dedup absorbs.
    // ⚠ The SAME `dev` the drain above was served with. The island advances
    // the cursor over the contiguous prefix of what it handed THAT device;
    // computing that prefix over another device's rows wedges the queue.
    await fetchWithTimeout(`${identity.apiBase}/messages/queue/ack?dev=${myDev}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${identity.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ direct_ids: directIds, group_ids: groupIds }),
    }).catch(() => {})
  }
}

// The two room-log endpoints, authenticated and bounded like the legacy
// drain's requests.
function logRequestFor(identity: WebIdentity): GroupLogRequest {
  return (path, body) =>
    fetchWithTimeout(`${identity.apiBase}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${identity.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
}

// Stage 5 (core-metadata plan): on an island that keeps one log per room,
// drain the rooms from their logs, next to the legacy queue. The rows are the
// same envelope types and payloads the legacy group rows carry, so they go
// through the same dispatch; the ack follows the history flush, per room,
// over the contiguous prefix of what was processed (see group-log.ts). An
// island without the capability is never asked: the first fetch is also what
// marks this device a "log reader" there. Runs inside drainPrimaryQueue's
// single flight, right after the legacy drain, never concurrently with it.
async function drainRoomLog(identity: WebIdentity, myDev: number): Promise<void> {
  if (!(await islandHasGroupLog(identity.apiBase))) return
  try {
    await drainGroupLog(
      identity.apiBase,
      identity.uin,
      logRequestFor(identity),
      (row) => ingestPrimaryRow(identity, myDev, { envelope_type: row.envelope_type, payload: row.payload, group_id: row.gid }),
      flushHistory,
    )
  } catch {
    /* nothing was acked for the page that failed; the next drain re-serves it */
  }
}

export function MessageReceiver() {
  const { identity } = useIdentity()
  const { on, connected } = useWS()

  // Provision (publish our libsignal bundle so peers can reach us, as this
  // account's primary device or as a secondary one alongside the phone) + drain
  // the offline queue whenever we (re)connect.
  useEffect(() => {
    if (!identity || !connected) return
    void (async () => {
      try {
        await getDevice(identity) // provision-once (publishes/registers a bundle)
      } catch {
        /* the island could not say who owns the primary slot — v=1 still works */
      }
      // Federation F1: publish our signed home-island record. Fire-and-forget —
      // publishHomeIslandRecord swallows all errors, so it can never block the
      // queue drain or login even if the island lacks the F1 endpoint.
      //
      // ⚠ #605: READ the record before republishing it. The homes list is an
      // account-wide fact the island holds; this browser only ever knew its own
      // local half of it. Publishing first would PUT a one-home record under a
      // fresh ts over the two-home one a phone published — the island rejects
      // only an OLDER ts — so the backup island the person switched on there
      // would silently stop receiving. Adopting first also makes the toggle in
      // Settings tell the truth and gets the backup queue drained here too.
      //
      // In its own task, not awaited: adoption is two round trips per unknown
      // home and the queue drain below must not wait behind it.
      void (async () => {
        // Scrub first: a phantom front home adopted by an older build must
        // stop draining and stop being republished in THIS session, not the
        // next one. adoptHomesFromOwnRecord refuses fronts now, so the scrub
        // is not undone by the read that follows it.
        scrubFrontAliasHomes(identity)
        await adoptHomesFromOwnRecord(identity)
        void publishHomeIslandRecord(identity)
      })()
      // Advertise sender-keys support so others broadcast to us (encrypt-once)
      // instead of the legacy per-member fan-out. Fire-and-forget.
      void Api.advertiseCapabilities(identity, true).catch(() => {})
      await drainPrimaryQueue(identity, true)
    })()
    // The socket is back: forget how long peers have been "quiet". What we
    // measured while it was down was our own outage, and their answers may be
    // in the backlog the drain above is fetching right now.
    resetSilenceProbes()
  }, [identity, connected])

  // The socket is the fast road, not the only road. While it is down, this
  // poll IS delivery — a network that kills WebSockets moments after the
  // handshake while answering every HTTPS request is a real, observed failure
  // mode, and it used to mean no messages at all. Same drain, same dedup,
  // thirty seconds behind at worst. Does nothing while the socket is healthy.
  useEffect(() => {
    if (!identity || connected) return
    let first = true
    const tick = () => {
      const catchUp = first
      first = false
      void drainPrimaryQueue(identity, catchUp)
    }
    // Not immediately: a normal boot has the socket up within a second or two,
    // and its connect drain covers the backlog. Only a socket still down after
    // this grace is worth polling around.
    const start = setTimeout(tick, 5_000)
    const handle = setInterval(tick, 30_000)
    return () => {
      clearTimeout(start)
      clearInterval(handle)
    }
  }, [identity, connected])

  // The socket being OPEN is not proof the queue is empty. A row deposited in
  // the moment of a reconnect — or a live frame the island failed to deliver —
  // sits above our cursor with nothing scheduled to fetch it: the connect
  // drain has passed, and the offline poll above is gated on the socket being
  // DOWN. So a stable, healthy session meant that row waited forever
  // (fan-out live test, 2026-08-20). A slow sweep behind the healthy socket
  // picks those up; the id dedup absorbs the overlap with everything the
  // socket already delivered. 90s + per-tab jitter: cheap for the island
  // (a watermark query), desynchronised across tabs, and Chrome throttling
  // it further in background tabs is fine — slower is still not never.
  useEffect(() => {
    if (!identity || !connected) return
    const handle = setInterval(
      () => void drainPrimaryQueue(identity, false),
      90_000 + Math.floor(Math.random() * 15_000),
    )
    return () => clearInterval(handle)
  }, [identity, connected])

  // And the moment the tab comes back to the foreground, sweep once right
  // away: a background tab's socket dies in ~30-50s (throttled timers starve
  // the ping), so "returned to the tab" very often means "something queued
  // while the socket flapped" — catching up NOW beats waiting for the next
  // interval to come around.
  useEffect(() => {
    if (!identity) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') void drainPrimaryQueue(identity, false)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [identity])

  // Multihoming v1: poll the BACKUP islands' queues. Deliberately NOT gated on
  // the primary's WS being connected — when the primary island is down, this
  // loop IS the delivery path. Copies of primary-delivered messages are
  // expected; the incoming store dedups by envelope id.
  useEffect(() => {
    if (!identity) return
    let cancelled = false
    let firstTick = true
    let running = false
    // One row off a backup home, legacy queue or room log. `swallow` is the
    // legacy queue's rule: that fetch is the ack-less one, so the island has
    // already let go of the whole page, and a throw would abandon the rows
    // behind this one for good. The room log is acked by position, the other
    // way round: a transient failure (no libsignal device yet, say) must
    // THROW so the row stays in front of the cursor and is re-served, and
    // the strike ledger in group-log.ts acks past it only once it has failed
    // the same way on several drains.
    const ingest = async (row: { payload: string; group_id: number | null }, host: string, swallow: boolean) => {
      if (cancelled) return
      const got = swallow
        ? await decryptIncoming(identity, row.payload).catch(() => null)
        : await decryptIncoming(identity, row.payload)
      if (!got) return
      // A group row in a BACKUP mailbox = that island also hosts a group we
      // joined (same identity, same mailbox): alias it like the visited poll.
      const gid = typeof row.group_id === 'number' ? aliasFor(host, row.group_id) : row.group_id
      route(got.senderUIN, got.senderHost, got.envelope, gid, identity.uin, hostOf(identity.apiBase), got.senderSigningKey, identity)
    }
    const tick = async () => {
      // Single-flight: a tick that outlives the interval (a slow island, a
      // deep log) must not have the next one fetch the same page beside it.
      if (cancelled || running || listBackupHomes().length === 0) return
      running = true
      try {
        await ensureHydrated(identity.uin) // dedup needs the seen-set first
        // Only the first sweep is backlog. Every later one IS the live delivery
        // path whenever the primary island is down, and silencing those would
        // mean the outage that makes this loop matter also makes it invisible.
        const catchingUp = firstTick
        firstTick = false
        if (catchingUp) beginCatchUp()
        await drainBackupQueues(identity, (row, host) => ingest(row, host, true), {
          handle: (row, host) => ingest(row, host, false),
          // Stage 5: a backup island that keeps room logs is acked only once
          // the rows it served are on disk here.
          persisted: flushHistory,
        })
        if (catchingUp) endCatchUp()
      } finally {
        running = false
      }
    }
    void tick()
    const handle = setInterval(() => void tick(), 30_000)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [identity])

  // Cross-island groups (§5c): poll the guest mailbox on every VISITED island
  // — the group's island spools its fan-out there. Group rows file under the
  // local ALIAS id (per-island group ids collide across islands). A 1:1 row
  // arriving there (someone on that island messaged our guest uin) goes
  // through the normal route: its from_host differs from our primary island,
  // so it lands in the cross-island request quarantine — exactly right.
  useEffect(() => {
    if (!identity) return
    let cancelled = false
    let firstTick = true
    let running = false
    // Same split as the backup poller: the legacy guest queue swallows (the
    // ack-less fetch), the room log throws on a transient failure so the
    // cursor stays in front of the row.
    const ingest = async (row: { payload: string; group_id: number | null }, host: string, swallow: boolean) => {
      if (cancelled) return
      const got = swallow
        ? await decryptIncoming(identity, row.payload).catch(() => null)
        : await decryptIncoming(identity, row.payload)
      if (!got) return
      const gid = typeof row.group_id === 'number' ? aliasFor(host, row.group_id) : row.group_id
      route(got.senderUIN, got.senderHost, got.envelope, gid, identity.uin, hostOf(identity.apiBase), got.senderSigningKey, identity)
    }
    const tick = async () => {
      if (cancelled || running || listVisitedIslands().length === 0) return
      running = true
      try {
        await ensureHydrated(identity.uin) // dedup needs the seen-set first
        // Same as the backup poller: the first sweep is a mailbox we have not
        // read yet, everything after it is live.
        const catchingUp = firstTick
        firstTick = false
        if (catchingUp) beginCatchUp()
        await drainVisitedQueues(identity, (row, host) => ingest(row, host, true), {
          handle: (row, host) => ingest(row, host, false),
          // Same rule as the backup poll: the room-log ack waits for the write.
          persisted: flushHistory,
        })
        if (catchingUp) endCatchUp()
      } finally {
        running = false
      }
    }
    void tick()
    const handle = setInterval(() => void tick(), 30_000)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [identity])

  // Live sealed envelopes pushed over the socket. The server ships each with
  // ws packet `type` = its envelope_type, so a control envelope arrives as
  // `reaction`/`delete`/`edit`/`read`/… — NOT `message`. Subscribing only to
  // `message` meant a reaction/delete/edit sent from the phone was dropped
  // live and only applied on the next reload's queue drain (which reads every
  // row regardless of type). Subscribe to the full sealed-envelope set so live
  // delivery matches the drain. `gmsg` has its own handler below; other control
  // ws packets (presence/typing/pong/contact_*/account_burned) are not in this
  // list, so they're untouched.
  useEffect(() => {
    if (!identity) return
    const handle = (ev: Parameters<Parameters<typeof on>[1]>[0]) => {
      const payload = ev.payload as string | undefined
      if (!payload) return
      // Live delivery is NOT filtered by the island — every socket of the
      // account sees every copy of a fan-out — so a copy addressed to a sibling
      // device is dropped here. It is queued for that device, not for this one.
      const toDevice = ev.to_device_id
      if (typeof toDevice === 'number' && toDevice !== currentDeviceId()) return
      void (async () => {
        // The invariant at the top of this file — every receive path waits on
        // the same hydration — held for both drains but not here. A live frame
        // ingested before hydrateIncoming ran was added to a store whose
        // writes were still silently disabled (_activeUin unset), so the row
        // never reached disk while the decrypt had already burned the ratchet.
        await ensureHydrated(identity.uin)
        const got = await decryptIncoming(identity, payload)
        if (got) {
          // Device-scoped liveness for the silence probe (v=1 names no device).
          if (got.senderUIN !== identity.uin) noteInboundFrom(got.senderUIN, got.senderDeviceId)
          route(got.senderUIN, got.senderHost, got.envelope, ev.group_id, identity.uin, hostOf(identity.apiBase), got.senderSigningKey, identity)
        }
      })()
        // No device to open it with yet. The same envelope is in the queue, and
        // the drain that runs once there IS one delivers it.
        .catch(() => {})
    }
    // Every sealed 1:1 envelope_type a peer / our own other device can push.
    // skdm/sknack ride this same path and route() has handlers for both, but
    // they were missing here: a sender-key chain handed to us live was dropped,
    // the next gmsg had no key, we fanned an sknack out to the whole group, the
    // kid owner's skdm reply was dropped too, and the loop repeated every few
    // minutes. iOS and Android have carried both for a while. `nudge` and
    // `relay_share` are deliberately NOT here: web has no envelope kind for
    // either, so they would decrypt and fall through to a null row.
    // ⚠ `call` (§5d) is in this list and NOT in the `call_*` list `call.tsx`
    // subscribes to: those are the island's own plaintext relay frames for a
    // SAME-island call, this is a sealed envelope whose outer type happens to
    // be `call` because that is what makes the island ring a closed app. It
    // arrives here, gets decrypted, and only then does the signal inside it
    // reach the call machine. Omitting it would leave cross-island calls
    // working only on the next queue drain, i.e. minutes after they rang off.
    const SEALED_WS_TYPES = ['message', 'reaction', 'delete', 'edit', 'read', 'system', 'secscreen', 'visit', 'bounce', 'carbon', 'homerec', 'skdm', 'sknack', 'call']
    const offs = SEALED_WS_TYPES.map((tp) => on(tp, handle))
    return () => offs.forEach((off) => off())
  }, [identity, on])

  // Live sender-keys broadcasts pushed over the socket (server pkt type "gmsg").
  useEffect(() => {
    if (!identity) return
    return on('gmsg', (ev) => {
      const payload = ev.payload as string | undefined
      const gid = ev.group_id
      if (!payload || typeof gid !== 'number') return
      // Stage 5: the frame carries the row's `seq` when the island logged the
      // post (absent when it did not, or on an older island).
      const seq = ev.seq
      void (async () => {
        // Same hydration invariant as the sealed live path above: never ingest
        // into a store whose writes are still disabled.
        await ensureHydrated(identity.uin)
        const { routed: got, held } = await decodeGmsg(identity, payload, gid)
        if (got) route(got.senderUIN, undefined, got.envelope, gid, identity.uin, hostOf(identity.apiBase), undefined, identity)
        if (typeof seq !== 'number') return
        // ⚠ A broadcast HELD for a missing chain is not acked from here. The
        // hold is in memory (held-gmsg.ts); acking it would tell the island
        // this tab has a row that a reload before the kid owner's answer
        // would lose for good. Left unacked, the next drain re-serves it,
        // re-holds it (deduped by chain position) and acks it there, as the
        // legacy drain always has: the cursor is pinned for one sweep at
        // most, never forever.
        if (held) return
        // Ack it like a fetched row, so the next fetch does not re-serve it:
        // only when it is the next row after what this tab has vouched for
        // in the room, and then after the history write lands (group-log.ts
        // runs the flush only once that gate passes: a full-archive write per
        // frame that the gate then refuses is the stutter the coalescing
        // removed).
        await ackLiveGroupRow(identity.apiBase, identity.uin, logRequestFor(identity), gid, seq, flushHistory)
      })().catch(() => {})
    })
  }, [identity, on])

  // What this tab vouched for in each room is a fact about THIS session's
  // cursor. A later sign-in under the same number starts from the island's
  // cursor again, never from a stale local one.
  useEffect(() => {
    if (!identity) return
    const { apiBase, uin } = identity
    return () => forgetVouched(apiBase, uin)
  }, [identity])

  return null
}
