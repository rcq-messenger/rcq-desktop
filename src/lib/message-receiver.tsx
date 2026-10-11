// App-wide receive loop. Mounted once under WSProvider. On connect it ensures
// this account is provisioned as a libsignal device, drains the offline queue,
// and decrypts each envelope; live WS `message` pushes are decrypted too. Both
// feed the incoming-store, deduped by envelope id. Renders nothing.

import { useEffect, useRef } from 'react'
import { rememberTheirCard, theirCard } from './guest-card'
import { peerSealKeys } from './peer-keys'
import { useIdentity } from './identity-context'
import { useWS } from './ws'
import { currentDeviceId, decryptIncoming, getDevice, myDeviceId, noteInboundFrom, resetSilenceProbes, sendV2 } from './signal-device'
import { addIncoming, addGroupIncoming, serverStampMs, hydrateIncoming, beginCatchUp, endCatchUp, flushHistory, markDeleted,
  applyRemoteRead,
} from './incoming-store'
import { applyEditToOutgoing, carbonThreadKey, fileOutgoingCarbon } from './outgoing-store'
import { publishHomeIslandRecord } from './federation-publish'
import { answerKeyAsk, loadRoomKeys, putRoomKey, roomKey, sealedKeyVer } from './group-state'
import { handleProfileKeyEnvelope, loadProfileKeys } from './profile-key'
import { snapshotFor } from './contacts-cache'
import { isRandomTraffic, randomEnded, randomMatched } from './random-peers'
import { adoptHomesFromOwnRecord, applyPushedRecord, backupIdentityFor, drainBackupQueues, listBackupHomes, scrubFrontAliasHomes } from './multihome'
import { aliasFor, drainVisitedQueues, guestIdentityFor, listVisitedIslands } from './visited-islands'
import { getCrossIsland, getVerifiedCrossIsland } from './crossisland-store'
import { notePeerHeardFrom } from './peer-liveness'
import { depositReceiptToContact } from './federation-send'
import { carbonIsOwn, crossIslandGateVerdict, foreignRoomBroadcastDropped, groupFrameDropped, isContentKind, sameSigningKey } from './crossisland-gate'
import { roomKeyVersionAllowed, skdmRoomMatches, type V2Identity } from './sender-trust'
import { foreignClaim, noteRoomSnapshot, refreshRoomRoster, resolveDirectTrust, resolveRoomTrust } from './sender-trust-resolve'
import { parseGroupChanged } from './group-events'
import type { GuestRoom } from './held-gmsg'
import { applyRequestAck } from './crossisland-ack'
import { isBurning } from './burn-cascade'
import { browserOnline, failoverAccount, failoverVerdict, primaryAnswers, setReceivingViaBackup } from './backup-failover'
import { pollVisitedPending } from './crossisland-pending-poll'
import { ensureRequestsLoaded, holdRequestMessage, isBlocked, isBlockedSender, retractHeldMessage } from './crossisland-requests'
import { isContact, shouldQuarantineStranger } from './stranger-requests'
import { handleContactReq } from './crossisland-contactreq'
import { CALL_OFFER_TTL_SEC, fileMissedCall, fileMissedCrossIslandOffer } from './crossisland-call'
import { deliverCrossIslandCallSignal } from './call'
import { myCallPolicy } from './call-privacy'
import { handleProfile, pushProfileTo } from './crossisland-profile'
import { decodeGmsg, handleGmsg, handleSkdm, handleSknack, replayHeldGmsg, type GmsgAuthorize } from './sender-key-receive'
import { ackLiveGroupRow, drainGroupLog, forgetVouched, islandHasGroupLog, NotTheRowsFault, strikeRow, type GroupLogRequest } from './group-log'
import { localStrikeStore } from './group-log-strikes'
import { Api, peerBundleFrom } from './api'
import { bytesToB64, encryptV1 } from './crypto'
import type { CallEnvelope, CarbonEnvelope, ContactReqEnvelope, Envelope, ProfileEnvelope, WebIdentity } from './crypto'

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
    loadProfileKeys(uin)
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
function handleCallSignal(senderUin: number, senderHost: string, env: CallEnvelope, senderSigningKey?: string): void {
  // The address, or the key the seal proved: a person blocked on one of their
  // islands does not ring from another (crossisland-block-rules.ts).
  if (isBlockedSender(senderUin, senderHost, senderSigningKey)) return
  // Gate 2 asks for the pinned ADDRESS and the pinned KEY. `from`/`from_host`
  // are unsigned in v=1, so the address alone would let anyone who knows one
  // of our contacts ring us as them. Under another key the sender is a
  // stranger, and a stranger's signal is dropped like any other.
  if (!getVerifiedCrossIsland(senderUin, senderHost, senderSigningKey)) {
    if (getCrossIsland(senderUin, senderHost)) {
      console.warn('[crossisland] call signal under a key that is not the pinned one; dropped', { senderUin, senderHost })
    }
    return
  }
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

/// What a decrypted row proved about who sealed it, for route().
interface SealProof {
  /// The key a v=1 seal verified under, or the key a broadcast's chain is
  /// bound to (sender-key-receive verified the broadcast under it).
  spub?: string
  /// v=2 only: the identity check signal-device ran before it decrypted.
  v2?: V2Identity
  /// The row may be left for a later drain when it cannot be judged yet: true
  /// only for a v=1 seal, which nothing advanced. A v=2 row moved its ratchet
  /// and a broadcast its chain, so neither opens a second time.
  retryable?: boolean
}

/// 'retry': the row could not be judged for now (a room's roster unreadable,
/// nothing cached) and nothing irreversible happened to it. The queue drains
/// leave it unacked; everything else drops it.
type RouteResult = 'done' | 'retry'

function proofOf(got: { senderSigningKey?: string; senderV2?: V2Identity }): SealProof {
  return got.senderV2 != null
    ? { v2: got.senderV2 }
    : { spub: got.senderSigningKey, retryable: true }
}

/// Answers "may the owner of this chain still speak in the room" for
/// sender-key-receive, BEFORE the chain is ratcheted (see GmsgAuthorize).
function gmsgAuthorizer(identity: WebIdentity, localGid: number): GmsgAuthorize {
  return async (senderUin, spub) => {
    const room = await resolveRoomTrust(identity, localGid, senderUin, spub, null)
    // The island did not hand the roster over: nothing about this broadcast,
    // so the drains leave it where it is and count no strike against it.
    if (room === 'retry') throw new NotTheRowsFault('room roster unavailable')
    if (room.trust === 'self' || room.trust === 'pinned') return true
    console.warn('[sender-auth] broadcast under a chain whose owner the room does not hold; dropped', { localGid, senderUin })
    return false
  }
}

// Route a decrypted envelope to the 1:1 store or the group store by group_id.
//
// ⚠⚠ WHO SENT IT IS DECIDED FIRST (sender-auth, 11.10). In a v=1 seal `from`
// and `from_host` are unsigned and the deposit is anonymous, so the number on
// a row is a claim anyone holding our open key card can make. The only
// comparison of the key a seal proved with anything used to sit at the
// cross-island gate, and a sender dodged it by leaving `from_host` out. Every
// branch below now starts from one verdict (sender-trust.ts), computed before
// the first of them: the profile key, the room key and the sender-key chain
// hand-offs, the guest card, the home record, call signalling, carbons,
// receipts, edits, deletes and reactions as much as the messages themselves.
async function route(
  senderUIN: number,
  senderHost: string | undefined,
  envelope: Envelope,
  groupId: unknown,
  identity: WebIdentity,
  proof: SealProof,
  /// The island's deposit stamp for this row, when the path that fetched it
  /// has one. See `IncomingRow.srvAt`: without it a queue drain files a day
  /// of backlog as if it had all arrived just now, and the read marker from
  /// another device can never clear any of it.
  srvAt?: number,
): Promise<RouteResult> {
  // ⚠⚠ RANDOM-CHAT TRAFFIC IS NOT OURS TO FILE, and this device has no random
  // chat at all. Undelivered queue rows go to EVERY device of the account, so a
  // phone in a random chat had its anonymous conversation written into a
  // permanent thread here, with the stranger's number in the roster and their
  // nickname fetched a moment later. Not after the session ended, as on the
  // phones: from the FIRST message, while it was still running. Whoever had
  // this open had no anonymity in random chat whatsoever (07.09).
  //
  // The island tells every device when a pair starts and ends, which is how
  // this device knows whom to ignore without being able to join in.
  //
  // Before everything else on purpose: nothing about traffic we are about to
  // drop is worth a roster read or a card.
  if (isRandomTraffic(senderUIN, isContact(identity.uin, senderUIN))) return 'done'

  if (typeof groupId === 'number') {
    // ⚠⚠ A GROUP FRAME NEVER REACHES A 1:1 HANDLER (spec 2026-09-15, section 7).
    // The island stores a group-sealed payload for any subset of a room's
    // members without checking the sender, so one member can address exactly
    // one other through the room. A contact request, a call, a profile push, a
    // key ask, a visit or a carbon riding such a frame is dropped here;
    // content keeps rendering in its group's thread only.
    if (groupFrameDropped((envelope as { kind?: unknown }).kind)) return 'done'
    return routeRoomFrame(senderUIN, envelope, groupId, identity, proof, srvAt)
  }
  return routeDirect(senderUIN, senderHost, envelope, identity, proof, srvAt)
}

/// A row that arrived as a room's frame: a per-member copy, or a broadcast
/// decoded through a sender-key chain.
///
/// ⚠⚠ Only a MEMBER of that room, under the key its roster holds for them,
/// speaks there (sender-auth, 11.10). `POST /messages/group-sealed` is
/// anonymous and checks recipients only, so anyone who knew a room's id, one
/// member's number and that member's card could post into the room as its
/// owner, retract anybody's message with the owner's authority, or rewrite one
/// as its author. Not a member, or not under that key: dropped. Moderation
/// rights come from the same verified roster row, and act in this room only.
async function routeRoomFrame(
  senderUIN: number,
  envelope: Envelope,
  groupId: number,
  identity: WebIdentity,
  proof: SealProof,
  srvAt: number | undefined,
): Promise<RouteResult> {
  const kind = (envelope as { kind?: unknown }).kind
  const room = await resolveRoomTrust(identity, groupId, senderUIN, proof.spub, proof.v2)
  if (room === 'retry') {
    // The roster could not be read and nothing is cached. A v=1 seal comes
    // back on the next drain; anything else cannot be opened again.
    if (proof.retryable) return 'retry'
    console.warn('[sender-auth] room roster unreadable; row dropped', { groupId, senderUIN, kind })
    return 'done'
  }
  if (room.trust !== 'self' && room.trust !== 'pinned') {
    console.warn('[sender-auth] row in a room from someone it does not hold under that key; dropped', {
      groupId,
      senderUIN,
      kind,
      trust: room.trust,
    })
    return 'done'
  }

  // Sender-keys distribution (never rendered). The chain is bound to the
  // member who sealed it, to the key they sealed it under, and to THIS room.
  if (kind === 'skdm') {
    const skdm = envelope as unknown as { gid: number; kid: string; e: number; i: number; ck: string }
    // The chain names its room, the frame names where it was deposited. A
    // chain handed over in one room is never a key for another.
    if (!skdmRoomMatches(skdm.gid, room.ctx.gid)) {
      console.warn('[sender-keys] SKDM for another room than the frame it rode; dropped', { groupId, gid: skdm.gid })
      return 'done'
    }
    // Filed under the home account, against the room's island. A v=2 SKDM
    // names no key to bind the chain to and is refused inside handleSkdm.
    const accepted = handleSkdm(identity.uin, senderUIN, proof.spub, skdm, room.ctx.host)
    // A live gmsg can outrun its own SKDM (a drain cannot: skdm rows are
    // served first) and used to be lost for good. Replay whatever was held
    // for this kid through the normal decrypt path, in arrival order; a
    // copy the queue drain also delivers is absorbed by the chain position
    // and the envelope-id dedup downstream of route().
    if (accepted && typeof skdm.kid === 'string') {
      void replayHeldGmsg(identity, skdm.kid, (r) => gmsgAuthorizer(identity, r.aliasGid))
        .then(async (msgs) => {
          for (const m of msgs) {
            // A held broadcast from a room on another island goes through
            // the same door as a live one (routeForeignRoomBroadcast).
            if (m.host) await routeForeignRoomBroadcast(m.senderUIN, m.spub, m.envelope, m.host, m.gid, identity, undefined)
            else await route(m.senderUIN, undefined, m.envelope, m.gid, identity, { spub: m.spub })
          }
        })
        .catch(() => {})
    }
    return 'done'
  }
  // A member asking the kid owner to re-distribute. Answered from our own
  // island's roster only (handleSknack reads it), so only for a room here.
  if (kind === 'sknack') {
    const e = envelope as unknown as { gid: number; kid: string }
    if (room.ctx.host == null && skdmRoomMatches(e.gid, room.ctx.gid)) void handleSknack(identity, senderUIN, e)
    return 'done'
  }
  addGroupIncoming(groupId, senderUIN, envelope, srvAt, {
    moderator: room.role === 'owner' || room.role === 'admin',
    self: room.trust === 'self',
  })
  return 'done'
}

/// A 1:1 row.
async function routeDirect(
  senderUIN: number,
  senderHost: string | undefined,
  envelope: Envelope,
  identity: WebIdentity,
  proof: SealProof,
  srvAt: number | undefined,
): Promise<RouteResult> {
  const myUin = identity.uin
  const ownHost = hostOf(identity.apiBase)
  const kind = typeof (envelope as { kind?: unknown }).kind === 'string' ? (envelope as { kind: string }).kind : ''
  const spub = proof.spub
  const t = await resolveDirectTrust(identity, senderUIN, senderHost, spub, proof.v2)
  // `from_host` when it names another island, for the two branches that are
  // ABOUT the claimed address (a contact request, a profile refresh) and do
  // their own pinned-key checks.
  const foreign = foreignClaim(senderHost, identity)

  // ⚠⚠ A GUEST CARD the sender handed us, on a closed island. Read before any
  // decision about whether we want this message: it is what makes "they wrote
  // to me" into "I can answer them", and the answer path (the delivered
  // receipt) fires within the same tick. Held even for a message we go on to
  // quarantine as a stranger's, because the card costs nothing to keep and
  // the alternative is a person who accepted a request an hour later and then
  // cannot reply.
  //
  // But never on the unsigned number alone: a pinned sender's card is filed
  // under the row that pinned them, a stranger's only where we hold none yet,
  // and a forged one not at all. A junk card filed under a contact's number
  // used to break every key read for them on a closed island.
  //
  // Never from a carbon: a carbon is our own message coming back from another
  // of our devices, and its `card` is OURS.
  if (kind !== 'carbon' && (t.trust === 'pinned' || t.trust === 'unpinned')) {
    const card = (envelope as { card?: unknown }).card
    if (typeof card === 'string' && card && (t.trust === 'pinned' || !theirCard(senderUIN, t.host))) {
      rememberTheirCard(senderUIN, t.host, card)
    }
  }
  // Our own signing key, and whether THIS envelope was sealed under it.
  const ownSigningKey = bytesToB64(identity.signingPub)
  const ownSeal = senderUIN === myUin && sameSigningKey(spub, ownSigningKey)
  if (kind === 'carbon') {
    // ⚠⚠ Not on `from` alone: that field is unsigned in v=1, and a carbon's
    // `ciack` pins contact keys, so a forged one would let a stranger pin
    // their own key for a contact of ours and pass every pinned-key check
    // after it. Two locks: the verdict is SELF (our key on a v=1 seal, one of
    // the devices our island publishes for us on a v=2 one), and carbonIsOwn
    // (crossisland-gate.ts), the TRANSITIONAL rule iOS ships too: a carbon
    // that names a key must name OUR signing key, every inner kind; a `ciack`
    // carbon is taken only under our own key; a keyless (v=2) carbon is taken
    // for the other kinds, because Android seals its carbons v=2 until 0.194
    // has spread, and then the strict rule (our key, every kind) is to be
    // switched on. The inner kind is read HERE, before the rule, because the
    // rule depends on it. A refused carbon applies nothing and returns, so the
    // caller acks it like any other row route() consumed and the island stops
    // re-serving it.
    const inner = (envelope as { env?: unknown }).env as
      | { kind?: string; targetID?: string; text?: string; at?: number }
      | undefined
    if (t.trust === 'self' && carbonIsOwn(senderUIN, myUin, senderHost, ownHost, spub, ownSigningKey, false, inner?.kind)) {
      const carbon = envelope as CarbonEnvelope
      // Control carbons first: an edit/delete made on another of our devices
      // targets a row we already have — filing it as a NEW row (the content
      // path below) would be wrong twice over.
      if (inner?.kind === 'edit' && inner.targetID != null) {
        const key = carbonThreadKey(carbon)
        if (key) applyEditToOutgoing(key, inner.targetID, inner.text ?? '')
      } else if (inner?.kind === 'delete' && inner.targetID != null) {
        markDeleted(inner.targetID, { fromSelf: true })
      } else if (inner?.kind === 'ciack') {
        // A cross-island request answered on another of my devices. The row is
        // per-install, so without this the same request sits here waiting to be
        // accepted a SECOND time — which is not idempotent: it would re-TOFU
        // the peer and overwrite the keys the other device pinned.
        // No event of our own: `clearRequest`/`blockRequest` already notify the
        // store's listeners, and the pending list watches the store.
        //
        // `ownSeal` again on purpose, although carbonIsOwn already refuses a
        // `ciack` carbon not sealed under our key (keyless included, even
        // while keyless carbons of other kinds are allowed): this is the line
        // that pins keys, and it should read as guarded without a trip into
        // another file.
        // The row's deposit stamp goes with it: a block or an unblock from a
        // sender that predates `at` is dated by it, never by when this
        // device happened to drain it.
        if (ownSeal) applyRequestAck(inner as Record<string, unknown>, srvAt)
      } else if (inner?.kind === 'readmark') {
        // We read this thread on another device (A2): drop the badge here
        // too, minus anything that arrived after that read. Not a message,
        // so it must never reach fileOutgoingCarbon below.
        applyRemoteRead(carbon.to ?? null, carbon.gid ?? null, inner.at ?? Date.now())
      } else {
        // With the row's island stamp: a carbon drained from the queue is
        // otherwise filed at the moment of the drain (#1039).
        fileOutgoingCarbon(carbon, srvAt)
      }
    } else if (senderUIN === myUin) {
      console.warn('[sender-auth] carbon not sealed by this account; ignored')
    }
    return 'done'
  }
  // Profile key hand-off / ask-back. Both file state under the sender's bare
  // number in the HOME namespace: the face we show for that number, and the
  // key to ours. Only a person of our island under the key we hold for them
  // (or another device of ours) gets either; anyone else could blank a
  // contact's face, or swap it with the island's help.
  if (kind === 'pkey' || kind === 'pkeyask') {
    if (t.trust === 'self' || (t.trust === 'pinned' && t.host == null)) {
      void handleProfileKeyEnvelope(identity, senderUIN, envelope as { kind?: string; key?: string })
    }
    return 'done'
  }
  // Room state key hand-off / ask-back (stage 6 phase 2). Sealed 1:1, about a
  // room of OUR island: taken only from a member of that room under the key
  // its roster holds for them (or a device of ours), never by bare number.
  if (kind === 'gskey') {
    const e = envelope as unknown as { gid?: number; ver?: number; key?: string }
    if (!foreign && typeof e.gid === 'number' && e.gid > 0 && typeof e.ver === 'number' && typeof e.key === 'string') {
      await acceptRoomKey(identity, senderUIN, proof, e.gid, e.ver, e.key)
    }
    return 'done'
  }
  if (kind === 'gsknack') {
    const e = envelope as unknown as { gid?: number }
    if (!foreign && typeof e.gid === 'number' && e.gid > 0) {
      const gid = e.gid
      const room = await resolveRoomTrust(identity, gid, senderUIN, spub, proof.v2)
      if (room !== 'retry' && (room.trust === 'pinned' || room.trust === 'self')) {
        // The answer is sealed to the keys the roster holds for the asker,
        // read the way it always was. ⚠ The home snapshot stores groups
        // WITHOUT members (the list loads member-less on purpose), so one
        // roster read on demand; the frames are rare and roster-gated on
        // both ends.
        const snap = snapshotFor(identity.uin)
        let g = snap?.groups.find((x) => x.id === gid)
        if (!g?.members?.length) g = await Api.groupInfo(identity, gid).catch(() => undefined)
        const asker = g?.members?.find((m) => m.uin === senderUIN)
        if (asker?.identity_key) void answerKeyAsk(identity, asker, gid)
      }
    }
    return 'done'
  }
  // Sender-key traffic rides a room's frames on every client (group-sealed,
  // with the room's id on the row). One sealed 1:1 is bound to no room, so
  // there is nothing to check its sender against: dropped.
  if (kind === 'skdm' || kind === 'sknack') {
    console.warn('[sender-keys] sender-key traffic outside a room frame; dropped', { senderUIN, kind })
    return 'done'
  }
  // Federation gossip B1 self-push: a contact handed us their fresh signed
  // home-island record. Taken only from a sender pinned under the key we hold
  // for them, and verified against that key (the same bytes, once pinned): a
  // record signed by whoever sealed the envelope used to repoint where our
  // messages to that contact go. Reject a ts rollback, cache their homes for
  // future sends. Never rendered as a message.
  if (kind === 'homerec') {
    const rec = (envelope as { rec?: unknown }).rec
    if (t.trust === 'pinned' && spub && rec != null) applyPushedRecord(senderUIN, spub, rec)
    return 'done'
  }
  // §5d call signalling. Sits ABOVE the quarantine for the same reason §5f
  // does, and one more of its own: a signal is EPHEMERAL. Held as a message
  // request it would be a call nobody can answer, sitting in a list, and it
  // must never reach the message store — the conversation gets the one-line
  // call summary the state machine writes when the call is over, not the SDP
  // that set it up. A same-island call otherwise rides the plaintext WS relay;
  // the single envelope that arrives from our own island is the missed-call
  // marker, which has its own handler and its own gates. A forged sender
  // files no missed call and rings nothing.
  if (kind === 'call') {
    if (t.trust === 'pinned' && t.host != null) {
      handleCallSignal(senderUIN, t.host, envelope as unknown as CallEnvelope, spub)
    } else if ((t.trust === 'pinned' || t.trust === 'unpinned') && t.host == null && !t.unverified) {
      handleSameIslandCallEnvelope(myUin, senderUIN, envelope as unknown as CallEnvelope)
    }
    return 'done'
  }
  // §5f cross-island contact request / accept / decline. MUST sit above the
  // quarantine below: that quarantine swallows everything from an unaccepted
  // sender into "message requests", and a contactreq from an unaccepted sender
  // is the whole point of the envelope — held as a message it would be invisible
  // as the request it is. Consent metadata only: never the message store.
  // Same-island senders are ignored here; they have the server's /contacts flow.
  // The ADDRESS is what this envelope is about, so it reads the claimed one;
  // handleContactReq does its own pinned-key checks against it.
  if (kind === 'contactreq') {
    if (foreign && senderUIN !== myUin) {
      handleContactReq(senderUIN, foreign, envelope as ContactReqEnvelope, spub)
      // §5e: they just accepted us, so from this moment they HOLD us — and all
      // they hold is whatever their key-card fetch caught at add time. Hand
      // them our current name and picture now rather than making them wait for
      // the next time we happen to edit the profile.
      if (
        (envelope as ContactReqEnvelope).act === 'accept' &&
        // Only the pinned key's accept: our profile goes to the person we
        // pinned, never on the say-so of an unsigned address.
        getVerifiedCrossIsland(senderUIN, foreign, spub)
      ) {
        void pushProfileTo(identity, foreign, senderUIN)
      }
    }
    return 'done'
  }
  // §5e cross-island profile refresh: the peer's own name/picture, pushed by
  // them because nothing else can refresh it. Same placement rule as §5f above
  // — ABOVE the quarantine, and never into the message store. Display fields
  // only: `handleProfile` cannot reach a pinned key, and a `profile` from
  // someone we do not hold as an accepted contact is dropped on the floor.
  if (kind === 'profile') {
    if (foreign && senderUIN !== myUin) handleProfile(senderUIN, foreign, envelope as ProfileEnvelope, spub)
    return 'done'
  }

  // Our own number under our own key: a note to Saved Messages, or a note
  // retracted on another device of the account.
  if (t.trust === 'self') {
    addIncoming(myUin, envelope, srvAt, { self: true })
    return 'done'
  }
  // ⚠⚠ A key is held for this number and the seal was not it (or a contact
  // whose key nothing here can tell us). Content goes to the requests list,
  // flagged, so it is seen and never merged into the contact's thread in
  // silence; an accept there checks the key against the island once more.
  // Control traffic is dropped: an edit, a delete, a reaction or a receipt in
  // someone else's name has nothing to belong to.
  if (t.trust === 'forged' || t.unverified) {
    if (senderUIN === myUin) {
      console.warn('[sender-auth] our own number under a key that is not ours; dropped', { kind })
      return 'done'
    }
    const host = t.host ?? ''
    if (isContentKind(kind)) {
      holdRequestMessage(senderUIN, host, envelope, { spub, keyMismatch: t.keyChanged })
    } else {
      // Dropped, except for what it says about a message we hold from this
      // very key: a delete for everyone takes that back.
      const del = envelope as { targetID?: string }
      if (kind === 'delete' && del.targetID) retractHeldMessage(senderUIN, host, del.targetID, spub ?? '')
    }
    console.warn('[sender-auth] envelope under a key that is not the one held for this number', {
      senderUIN,
      host: t.host,
      kind,
      unverified: t.unverified === true,
    })
    return 'done'
  }

  if (t.host != null) {
    // Variant A consent: a message from an un-accepted CROSS-ISLAND sender is
    // quarantined as a "request" instead of landing in the chat list. Accepted
    // (we proactively added them) → normal ingest. Blocked → dropped, accepted
    // or not. The rule itself is crossisland-gate.ts.
    //
    // ⚠⚠ #985(1): CONTENT only is held. Everyone on a group's island stamps that
    // island as `from_host`, so a co-member's control traffic to our guest copy
    // there (a `visit` from opening a profile, and the like) was held too and
    // surfaced as a request with nothing in it. Every other kind from an
    // unaccepted sender is DROPPED: not held, and never applied, because a
    // `delete`, `edit` or `secscreen` from a stranger reaching the stores below
    // would be the worse bug. The key, contactreq, profile, homerec and call
    // branches above keep their own gates and never get here.
    //
    // "Accepted" is the pinned row senderTrust found under the key the seal
    // proved; its island is where they live, whatever `from_host` said.
    const pinned = t.trust === 'pinned' ? getCrossIsland(senderUIN, t.host) : null
    // Blocked by the address or by the key the seal proved, on any of their
    // islands. Asked for an accepted contact too (reports 1064, 1065): the
    // pinned key is who they are, and it is what a block holds against them.
    const blocked = isBlockedSender(senderUIN, t.host, spub)
    const verdict = crossIslandGateVerdict(kind, pinned?.signingKey ?? null, spub, blocked)
    if (verdict.action === 'hold') {
      // Returning skips the delivered receipt below, as for every held row:
      // a held message must not confirm to a stranger that it landed.
      holdRequestMessage(senderUIN, t.host, envelope, { spub, keyMismatch: verdict.keyMismatch })
      return 'done'
    }
    if (verdict.action === 'drop') {
      // Blocked: nothing at all, and no receipt. Their request row went with
      // the block, so there is nothing held to take back either.
      if (blocked) return 'done'
      // Dropped, except for what it says about a message we hold from them:
      // a delete for everyone takes that back, or the accept would replay it.
      const del = envelope as { targetID?: string }
      if (kind === 'delete' && del.targetID) retractHeldMessage(senderUIN, t.host, del.targetID, spub)
      return 'done'
    }
    // Delivered means verified under the pinned key: the person is there,
    // whatever a probe concluded about the address (report 1067). One of the
    // two places an "account deleted" mark comes off (the other is a card
    // under the pinned keys on a send), and never on the number alone: a
    // reissued number writes under another key and is held above.
    if (pinned) notePeerHeardFrom(pinned.uin, pinned.host, srvAt)
    addIncoming(senderUIN, envelope, srvAt)
    // From another island (#1062): answered on THEIR island, to the contact
    // this row was verified as (address and pinned key), never by number. A
    // stranger's row is held before it gets here, so nobody unaccepted learns
    // that this device is awake.
    if (pinned && 'id' in envelope && envelope.id) {
      const env: Envelope = { kind: 'delivered', targetIDs: [envelope.id] }
      void flushHistory()
        .then(() => depositReceiptToContact(identity, pinned, env))
        .catch(() => {})
    }
    return 'done'
  }

  // Our island. The same consent gate as above, opt-in (Privacy → strangers
  // to requests), for a sender we hold no key for. host '' marks a
  // same-island row in the shared store, and the key the seal proved goes
  // with it, so an accept can check it against their card. Returning here
  // also skips the delivery receipt below on purpose: a held message must not
  // confirm to a stranger that it landed in front of a human.
  if (t.trust === 'unpinned') {
    if (shouldQuarantineStranger(myUin, senderUIN, kind)) {
      holdRequestMessage(senderUIN, '', envelope, { spub })
      return 'done'
    }
    // A stranger deleting for everyone a message we still hold.
    const del = envelope as { targetID?: string }
    if (kind === 'delete' && del.targetID && retractHeldMessage(senderUIN, '', del.targetID, spub ?? '')) return 'done'
  }
  addIncoming(senderUIN, envelope, srvAt)
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
  //
  // ⚠⚠ SAME ISLAND ONLY, which this branch is: `sendDeliveredReceipt` seals
  // with a key from OUR island's /users/{uin}/info, so for a sender on another
  // island it would address whoever holds that number HERE.
  if ('id' in envelope && envelope.id) {
    const targetID = envelope.id
    void flushHistory()
      .then(() => sendDeliveredReceipt(identity, senderUIN, targetID))
      .catch(() => {})
  }
  return 'done'
}

/// A room state key sealed to us 1:1. Taken only from a member of that room
/// under the key its roster holds for them, or from another device of ours,
/// and only within reach of the version we know of. `putRoomKey` is monotonic,
/// so one envelope carrying an absurd version used to wedge the room for good
/// (every later legitimate key was "older"), and it was taken from anyone who
/// wrote the room's number and a member's.
async function acceptRoomKey(
  identity: WebIdentity,
  senderUIN: number,
  proof: SealProof,
  gid: number,
  ver: number,
  keyB64: string,
): Promise<void> {
  const room = await resolveRoomTrust(identity, gid, senderUIN, proof.spub, proof.v2)
  if (room === 'retry' || (room.trust !== 'self' && room.trust !== 'pinned')) {
    console.warn('[sender-auth] room key from someone the room does not hold under that key; ignored', { gid, senderUIN })
    return
  }
  const held = roomKey(gid)?.v ?? null
  const sealedOf = (blob: string | null | undefined) => (blob ? sealedKeyVer(blob) : null)
  let sealed = sealedOf(room.stateBlob ?? snapshotFor(identity.uin)?.groups.find((g) => g.id === gid)?.state_blob)
  // The roster this was judged by may have come without the room's blob (a
  // screen read it): read it once with the blob before refusing a version.
  if (!roomKeyVersionAllowed(ver, held, sealed) && room.stateBlob == null) {
    sealed = sealedOf(await refreshRoomRoster(identity, gid))
  }
  if (!roomKeyVersionAllowed(ver, held, sealed)) {
    console.warn('[sender-auth] room key version out of reach; ignored', { gid, ver, held, sealed })
    return
  }
  if (putRoomKey(gid, ver, keyB64, { replaceEqual: true })) {
    window.dispatchEvent(new Event('rcq-room-keys-changed'))
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
      // Roster first, then one cached, queued card read per peer (peer-keys.ts):
      // a drain can owe receipts to the same few people dozens of times over,
      // and each fresh read was one more request of the kind that stalled the
      // island on 28.09.
      const keys = await peerSealKeys(identity, peerUin)
      if (!keys) return
      const bundle = peerBundleFrom({ uin: peerUin, ...keys })
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
// A v=2 row sealed to this device that its session did not open is one of
// those (decryptIncoming's `holdUnopened`): both callers keep a strike ledger
// that writes it off after a few drains.
async function ingestPrimaryRow(
  identity: WebIdentity,
  myDev: number,
  r: {
    envelope_type: string
    payload: string
    group_id: number | null
    to_device_id?: number | null
    /// The island's own stamp, an ISO string with an offset. Absent on the
    /// paths that do not carry one, and refused rather than guessed when it
    /// has no offset (see `serverStampMs`).
    received_at?: string
  },
): Promise<void> {
  const srvAt = serverStampMs(r.received_at)
  if (typeof r.to_device_id === 'number' && r.to_device_id !== myDev) {
    // A fan-out copy for a sibling device of this account: it was
    // encrypted against a ratchet that lives there, so no decrypt is
    // attempted and it is acked away by the caller. An island that predates
    // the `dev` filter hands out every copy, so this is not dead code.
  } else if (r.envelope_type === 'gmsg' && typeof r.group_id === 'number') {
    // Sender-keys broadcast: not a sealed envelope, decoded via the chain.
    // The room decides whether the chain's owner may still speak there
    // before the chain moves (gmsgAuthorizer); a roster it cannot read
    // throws, and the row stays for the next drain.
    const got = await handleGmsg(identity, r.payload, r.group_id, undefined, gmsgAuthorizer(identity, r.group_id))
    if (got) await route(got.senderUIN, undefined, got.envelope, r.group_id, identity, { spub: got.spub }, srvAt)
  } else {
    const got = await decryptIncoming(identity, r.payload, { holdUnopened: true })
    if (got) {
      // A decrypted envelope proves the sending DEVICE can talk to us:
      // its silence probe stands down (device-scoped; v=1 names none). Only
      // when the island vouches for that device's identity.
      if (got.senderUIN !== identity.uin && got.senderV2 === 'verified') noteInboundFrom(got.senderUIN, got.senderDeviceId)
      // A v=1 row that could not be judged yet (a room roster unreadable) is
      // left in front of the cursor: nothing about it advanced.
      if ((await route(got.senderUIN, got.senderHost, got.envelope, r.group_id, identity, proofOf(got), srvAt)) === 'retry') {
        throw new NotTheRowsFault('sender not judged yet; left for the next drain')
      }
    }
  }
}

// The legacy `/messages/queue` drain, as it has always run (see the notes
// above drainPrimaryQueue). Untouched by Stage 5: it keeps serving 1:1 rows,
// and whatever legacy group rows the island wrote for this account before its
// first room-log fetch.
//
// One addition (report 981): the strike ledger the room log keeps, here keyed
// by queue id. A row that throws its OWN way on enough consecutive drains is
// acked past instead of holding the cursor for ever, and that is what lets a
// v=2 row this device's session did not open be held at all, rather than
// acked away as null on the spot. A failure that is not the row's (no device,
// the network, a roster not read) holds the row as before and counts nothing.
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
  const ledger = localStrikeStore(identity.apiBase, identity.uin, 'queue')
  const struck = ledger.read()
  let ledgerDirty = false
  // 1:1 and group rows are numbered by two different tables.
  const keyOf = (r: { id: number; group_id: number | null }) => `${typeof r.group_id === 'number' ? 'g' : 'd'}${r.id}`
  for (const r of rows) {
    const key = keyOf(r)
    try {
      await ingestPrimaryRow(identity, myDev, r)
      if (struck[key]) {
        delete struck[key]
        ledgerDirty = true
      }
    } catch (e) {
      // Only a THROW leaves a row unacked: the cursor then stops in front of
      // it and the island redelivers from there next time. Until the row has
      // failed its own way on enough drains: then it is acked past.
      const verdict = strikeRow(struck, key, e)
      if (verdict !== 'wait') ledgerDirty = true
      if (verdict !== 'writeOff') continue
    }
    // Processed to its end, including "decrypted to nothing", which is
    // terminal, or written off as unreadable here.
    ;(typeof r.group_id === 'number' ? groupIds : directIds).push(r.id)
  }
  // The fetch hands over every row above this device's cursor, so an entry
  // for a row it did not hand over was acked or reaped: dead weight.
  const served = new Set(rows.map(keyOf))
  for (const key of Object.keys(struck)) {
    if (!served.has(key)) {
      delete struck[key]
      ledgerDirty = true
    }
  }
  if (ledgerDirty) ledger.write(struck)
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
      (row) => ingestPrimaryRow(identity, myDev, { envelope_type: row.envelope_type, payload: row.payload, group_id: row.gid, received_at: row.received_at }),
      flushHistory,
      // On disk (report 981): a tab opened for a minute at a time still
      // reaches the strike limit, and a stuck row stops holding its room.
      localStrikeStore(identity.apiBase, identity.uin),
    )
  } catch {
    /* nothing was acked for the page that failed; the next drain re-serves it */
  }
}

/// One `gmsg` row out of a guest mailbox on another island (visited or
/// backup), decoded the way the primary drain decodes its own (see
/// ingestPrimaryRow), with the room's island in the picture: the AEAD binds
/// that island's own id for the room, a re-send request goes to that island
/// under our guest identity there, and the result is filed under the local
/// alias like every other row from there.
///
/// Acking follows the primary drain exactly. A broadcast that decoded, one that
/// was dropped and one held for a missing chain all RETURN, which the room-log
/// drain acks: the hold re-arms from the next copy and the NACK is out. Only a
/// throw leaves the row in front of the cursor. The legacy guest queue is the
/// ack-less fetch, so there (`swallow`) a throw is caught instead of losing the
/// rows behind this one.
async function ingestGuestGmsg(
  identity: WebIdentity,
  room: GuestRoom,
  payloadB64: string,
  remoteGid: number,
  srvAt: number | undefined,
  swallow: boolean,
): Promise<void> {
  const authorize = gmsgAuthorizer(identity, room.aliasGid)
  const got = swallow
    ? await handleGmsg(identity, payloadB64, remoteGid, room, authorize).catch(() => null)
    : await handleGmsg(identity, payloadB64, remoteGid, room, authorize)
  if (!got) return
  await routeForeignRoomBroadcast(got.senderUIN, got.spub, got.envelope, room.host, room.aliasGid, identity, srvAt)
}

/// A decoded broadcast from a room on ANOTHER island, into route().
///
/// ⚠⚠ With the room's island as the sender's host, and with every inner kind
/// route() would resolve in the HOME namespace dropped first
/// (foreignRoomBroadcastDropped). Routed with no host, as it first was, the
/// broadcast read as same-island traffic from the home island: a `pkeyask`
/// from member 4242 there looked 4242 up HERE and sealed our profile key to
/// an unrelated person, a `call` filed a missed call from them, a `card` was
/// filed under the home number. The host also files a card under (uin, host).
/// `spub` is the key the broadcast's chain is bound to: the room's roster on
/// that island is asked whether its owner is a member under that key.
async function routeForeignRoomBroadcast(
  senderUIN: number,
  spub: string,
  envelope: Envelope,
  host: string,
  aliasGid: number,
  identity: WebIdentity,
  srvAt: number | undefined,
): Promise<void> {
  if (foreignRoomBroadcastDropped((envelope as { kind?: unknown }).kind)) return
  await route(senderUIN, host, envelope, aliasGid, identity, { spub }, srvAt)
}

export function MessageReceiver() {
  const { identity } = useIdentity()
  const { on, connected } = useWS()
  // The backup poll decides the failover line at the END of a pass, which can
  // finish long after it started (a slow island, a deep log). A ref, so it
  // reads the socket as it is then, not as it was when the effect ran.
  const connectedRef = useRef(connected)
  connectedRef.current = connected

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
    // way round: a transient failure (no libsignal device yet, a v=2 row our
    // session did not open) must THROW so the row stays in front of the
    // cursor and is re-served, and the strike ledger in group-log.ts acks
    // past it only once it has failed its own way on several drains.
    const ingest = async (row: { envelope_type: string; payload: string; group_id: number | null; received_at?: string }, host: string, swallow: boolean) => {
      if (cancelled) return
      // A sender-keys broadcast for a room this backup island hosts. Not a
      // sealed envelope: see ingestGuestGmsg.
      if (row.envelope_type === 'gmsg' && typeof row.group_id === 'number') {
        const ident = backupIdentityFor(identity, host)
        if (!ident) return
        const room: GuestRoom = { ident, host, aliasGid: aliasFor(host, row.group_id) }
        await ingestGuestGmsg(identity, room, row.payload, row.group_id, serverStampMs(row.received_at), swallow)
        return
      }
      const got = swallow
        ? await decryptIncoming(identity, row.payload).catch(() => null)
        : await decryptIncoming(identity, row.payload, { holdUnopened: true })
      if (!got) return
      // A group row in a BACKUP mailbox = that island also hosts a group we
      // joined (same identity, same mailbox): alias it like the visited poll.
      const gid = typeof row.group_id === 'number' ? aliasFor(host, row.group_id) : row.group_id
      const res = await route(got.senderUIN, got.senderHost, got.envelope, gid, identity, proofOf(got), serverStampMs(row.received_at))
      // The room log is acked by position: a row that could not be judged yet
      // stays in front of the cursor. The legacy fetch has already let go.
      if (res === 'retry' && !swallow) throw new NotTheRowsFault('sender not judged yet; left for the next drain')
    }
    const account = failoverAccount(identity)
    const tick = async () => {
      // Single-flight: a tick that outlives the interval (a slow island, a
      // deep log) must not have the next one fetch the same page beside it.
      // A burn in progress stops this loop before it can re-prove the key on
      // an island the burn is deleting from (spec 2026-09-15, F2).
      if (cancelled || running || isBurning()) return
      if (listBackupHomes().length === 0) {
        // The last backup was removed in Settings while the line was up.
        setReceivingViaBackup(account, false)
        return
      }
      running = true
      try {
        await ensureHydrated(identity.uin) // dedup needs the seen-set first
        // Only the first sweep is backlog. Every later one IS the live delivery
        // path whenever the primary island is down, and silencing those would
        // mean the outage that makes this loop matter also makes it invisible.
        const catchingUp = firstTick
        firstTick = false
        // Is the primary down, or is this the usual extra copy beside it?
        // Asked beside the drain, not before it: while the primary is down
        // (the one time the answer matters) the probe waits out its timeout,
        // and the backup's mail should not wait with it. Not asked at all
        // while the socket is up or the browser is offline (backup-failover.ts).
        const primary = !connectedRef.current && browserOnline()
          ? primaryAnswers(identity.apiBase)
          : Promise.resolve(null)
        if (catchingUp) beginCatchUp()
        const answered = await drainBackupQueues(identity, (row, host) => ingest(row, host, true), {
          handle: (row, host) => ingest(row, host, false),
          // Stage 5: a backup island that keeps room logs is acked only once
          // the rows it served are on disk here.
          persisted: flushHistory,
        })
        if (catchingUp) endCatchUp()
        const primaryAnswered = await primary
        // Torn down while the pass ran (an account switch): the answer is
        // about the account being left and must not latch onto anything.
        if (cancelled) return
        setReceivingViaBackup(account, failoverVerdict({
          backupAnswered: answered > 0,
          online: browserOnline(),
          // Read now, not when the pass began: a socket that came up during
          // the drain has answered the question the probe was asking.
          socketUp: connectedRef.current,
          primaryAnswered,
        }))
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

  // The failover line comes down without waiting for the next backup pass when
  // the primary's socket opens (it answered, whatever the pass thought) and
  // when the browser loses its network (nothing arrives through anything
  // then). Both are what Android and iOS clear it on.
  useEffect(() => {
    if (!identity) return
    const account = failoverAccount(identity)
    if (connected) setReceivingViaBackup(account, false)
    const onOffline = () => setReceivingViaBackup(account, false)
    window.addEventListener('offline', onOffline)
    return () => window.removeEventListener('offline', onOffline)
  }, [identity, connected])

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
    const ingest = async (row: { envelope_type: string; payload: string; group_id: number | null; received_at?: string }, host: string, swallow: boolean) => {
      if (cancelled) return
      // #986(a): a sender-keys broadcast. Once our guest number on that
      // island advertises sender keys (signing in there with the phrase does
      // it, and the capability is per number, not per device), its members
      // stop sealing a copy per member and post ONE broadcast instead. This
      // path sent every row to the per-member decryptor, which cannot open a
      // broadcast, so the room went silent while the primary drain, which
      // routes `gmsg`, kept working for the account signed in there.
      if (row.envelope_type === 'gmsg' && typeof row.group_id === 'number') {
        const ident = guestIdentityFor(identity, host)
        if (!ident) return
        const room: GuestRoom = { ident, host, aliasGid: aliasFor(host, row.group_id) }
        await ingestGuestGmsg(identity, room, row.payload, row.group_id, serverStampMs(row.received_at), swallow)
        return
      }
      const got = swallow
        ? await decryptIncoming(identity, row.payload).catch(() => null)
        : await decryptIncoming(identity, row.payload, { holdUnopened: true })
      if (!got) return
      const gid = typeof row.group_id === 'number' ? aliasFor(host, row.group_id) : row.group_id
      const res = await route(got.senderUIN, got.senderHost, got.envelope, gid, identity, proofOf(got), serverStampMs(row.received_at))
      if (res === 'retry' && !swallow) throw new NotTheRowsFault('sender not judged yet; left for the next drain')
    }
    const tick = async () => {
      if (cancelled || running || isBurning() || listVisitedIslands().length === 0) return
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
        // F1 (spec 2026-09-15): the contact requests addressed to our guest
        // copies. Due at most once per island per five minutes, so most ticks
        // send nothing; the schedule inside decides. ⚠ Started, not awaited:
        // the poll talks to islands that are somebody else's, and a slow one
        // must not hold `running` and stop this drain. It is single-flight
        // and bounded by its own pass deadline.
        if (!cancelled && !isBurning()) void pollVisitedPending(identity)
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
          if (got.senderUIN !== identity.uin && got.senderV2 === 'verified') noteInboundFrom(got.senderUIN, got.senderDeviceId)
          // A live frame carries the island's own `server_time`, which is the
          // same clock the queued copy would have been stamped with. Falling
          // back to nothing (not to Date.now()) keeps the chain honest: no
          // stamp means the row keeps behaving exactly as it did before.
          // A 'retry' needs nothing here: the queued copy of the same row is
          // what the next drain judges.
          await route(got.senderUIN, got.senderHost, got.envelope, ev.group_id, identity, proofOf(got), serverStampMs(ev.server_time))
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

  // A small room's roster rides its membership change: the receive path's
  // copy (sender-trust-resolve.ts) is kept current from it, so a member added
  // or removed is judged by the roster as it is now without a read.
  useEffect(() => {
    if (!identity) return
    return on('group_membership_changed', (ev) => {
      const change = parseGroupChanged(ev)
      if (change?.snapshot) noteRoomSnapshot(identity, change.snapshot)
    })
  }, [identity, on])

  // ⚠⚠ The account's random-chat state, watched by a device that HAS no random
  // chat. The island fans these two frames out to every session, and without
  // them this browser cannot tell a stranger's anonymous message from an
  // ordinary one — nothing on the wire says which it is. See `random-peers`.
  useEffect(() => {
    if (!identity) return
    const offMatch = on('random_match', (ev) => {
      const peer = (ev as { peer?: { uin?: unknown } }).peer
      const uin = peer?.uin
      if (typeof uin === 'number') randomMatched(uin)
    })
    const offEnd = on('random_end', () => randomEnded())
    return () => {
      offMatch()
      offEnd()
    }
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
        // A roster that cannot be read throws before the chain moves, and the
        // frame stays unacked for the drain to judge.
        const { routed: got, held } = await decodeGmsg(identity, payload, gid, undefined, gmsgAuthorizer(identity, gid))
        if (got) await route(got.senderUIN, undefined, got.envelope, gid, identity, { spub: got.spub })
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
