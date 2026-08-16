// App-wide receive loop. Mounted once under WSProvider. On connect it ensures
// this account is provisioned as a libsignal device, drains the offline queue,
// and decrypts each envelope; live WS `message` pushes are decrypted too. Both
// feed the incoming-store, deduped by envelope id. Renders nothing.

import { useEffect } from 'react'
import { useIdentity } from './identity-context'
import { useWS } from './ws'
import { decryptIncoming, getDevice } from './signal-device'
import { addIncoming, addGroupIncoming, hydrateIncoming, beginCatchUp, endCatchUp } from './incoming-store'
import { fileOutgoingCarbon } from './outgoing-store'
import { publishHomeIslandRecord } from './federation-publish'
import { applyPushedRecord, drainBackupQueues, listBackupHomes } from './multihome'
import { aliasFor, drainVisitedQueues, listVisitedIslands } from './visited-islands'
import { getCrossIsland } from './crossisland-store'
import { ensureRequestsLoaded, holdRequestMessage, isBlocked } from './crossisland-requests'
import { handleContactReq } from './crossisland-contactreq'
import { CALL_OFFER_TTL_SEC, fileMissedCrossIslandOffer } from './crossisland-call'
import { deliverCrossIslandCallSignal } from './call'
import { handleProfile, pushProfileTo } from './crossisland-profile'
import { handleGmsg, handleSkdm, handleSknack } from './sender-key-receive'
import { Api } from './api'
import type { CallEnvelope, ContactReqEnvelope, ProfileEnvelope, WebIdentity } from './crypto'

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
    fileMissedCrossIslandOffer(senderUin, senderHost, data.media ?? 'audio', ts)
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
    if (senderUIN === myUin) fileOutgoingCarbon(envelope)
    return
  }
  // Sender-keys distribution / recovery (never rendered). SKDM stores the
  // chain bound to its authenticated sender; SKNACK asks the kid owner to
  // re-distribute. Both ride the per-member sealed path.
  if ((envelope as { kind?: string }).kind === 'skdm') {
    // No identity means no account to file the chain under, and a chain filed
    // under the wrong one is exactly the bug this key shape exists to stop.
    if (identity) {
      handleSkdm(identity.uin, senderUIN, senderSigningKey, envelope as unknown as { gid: number; kid: string; e: number; i: number; ck: string })
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
  // the SDP that set it up. A same-island call still rides the plaintext WS
  // relay, so an envelope that did not cross an island boundary is ignored.
  if ((envelope as { kind?: string }).kind === 'call') {
    if (senderHost && senderHost !== ownHost && senderUIN !== myUin) {
      handleCallSignal(senderUIN, senderHost, envelope as unknown as CallEnvelope)
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
  addIncoming(senderUIN, envelope)
}

function hostOf(apiBase: string): string {
  try {
    return new URL(apiBase).host
  } catch {
    return 'api.rcq.app'
  }
}

export function MessageReceiver() {
  const { identity } = useIdentity()
  const { on, connected } = useWS()

  // Provision (publish our libsignal bundle so peers can reach us) + drain the
  // offline queue whenever we (re)connect.
  useEffect(() => {
    if (!identity || !connected) return
    let cancelled = false
    void (async () => {
      await ensureHydrated(identity.uin) // restore persisted history first
      // The quarantine store is sealed at rest and opens asynchronously. Wait
      // for it here rather than relying on its deferred-write path, so a drain
      // that lands a stranger's first message writes it straight away.
      await ensureRequestsLoaded()
      try {
        await getDevice(identity) // provision-once (publishes bundle)
      } catch {
        /* provisioning failed (e.g. linked account whose bundle is the phone's) — skip */
      }
      // Federation F1: publish our signed home-island record. Fire-and-forget —
      // publishHomeIslandRecord swallows all errors, so it can never block the
      // queue drain or login even if the island lacks the F1 endpoint.
      void publishHomeIslandRecord(identity)
      // Advertise sender-keys support so others broadcast to us (encrypt-once)
      // instead of the legacy per-member fan-out. Fire-and-forget.
      void Api.advertiseCapabilities(identity, true).catch(() => {})
      // A queue drain is history, not news. Without this the backlog arrives as
      // a wall of banners with a chime behind each one, every time the app is
      // opened or the socket reconnects — and the unread badges have already
      // said all of it. Live WS traffic below is untouched: that IS the case
      // where a banner is the point.
      beginCatchUp()
      try {
        const res = await fetch(`${identity.apiBase}/messages/queue`, {
          headers: { Authorization: `Bearer ${identity.jwt}` },
        })
        if (!res.ok) return
        const rows = (await res.json()) as Array<{ envelope_type: string; payload: string; group_id: number | null }>
        for (const r of rows) {
          if (cancelled) return
          if (r.envelope_type === 'gmsg' && typeof r.group_id === 'number') {
            // Sender-keys broadcast: not a sealed envelope — decode via the chain.
            const got = await handleGmsg(identity, r.payload, r.group_id)
            if (got) route(got.senderUIN, undefined, got.envelope, r.group_id, identity.uin, hostOf(identity.apiBase), undefined, identity)
            continue
          }
          const got = await decryptIncoming(identity, r.payload)
          if (got) route(got.senderUIN, got.senderHost, got.envelope, r.group_id, identity.uin, hostOf(identity.apiBase), got.senderSigningKey, identity)
        }
      } catch {
        /* network hiccup — next reconnect drains again (queue isn't acked here) */
      } finally {
        endCatchUp()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [identity, connected])

  // Multihoming v1: poll the BACKUP islands' queues. Deliberately NOT gated on
  // the primary's WS being connected — when the primary island is down, this
  // loop IS the delivery path. Copies of primary-delivered messages are
  // expected; the incoming store dedups by envelope id.
  useEffect(() => {
    if (!identity) return
    let cancelled = false
    let firstTick = true
    const tick = async () => {
      if (cancelled || listBackupHomes().length === 0) return
      await ensureHydrated(identity.uin) // dedup needs the seen-set first
      // Only the first sweep is backlog. Every later one IS the live delivery
      // path whenever the primary island is down, and silencing those would
      // mean the outage that makes this loop matter also makes it invisible.
      const catchingUp = firstTick
      firstTick = false
      if (catchingUp) beginCatchUp()
      await drainBackupQueues(identity, async (row, host) => {
        if (cancelled) return
        const got = await decryptIncoming(identity, row.payload)
        if (!got) return
        // A group row in a BACKUP mailbox = that island also hosts a group we
        // joined (same identity, same mailbox) — alias it like the visited poll.
        const gid = typeof row.group_id === 'number' ? aliasFor(host, row.group_id) : row.group_id
        route(got.senderUIN, got.senderHost, got.envelope, gid, identity.uin, hostOf(identity.apiBase), got.senderSigningKey, identity)
      })
      if (catchingUp) endCatchUp()
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
    const tick = async () => {
      if (cancelled || listVisitedIslands().length === 0) return
      await ensureHydrated(identity.uin) // dedup needs the seen-set first
      // Same as the backup poller: the first sweep is a mailbox we have not
      // read yet, everything after it is live.
      const catchingUp = firstTick
      firstTick = false
      if (catchingUp) beginCatchUp()
      await drainVisitedQueues(identity, async (row, host) => {
        if (cancelled) return
        const got = await decryptIncoming(identity, row.payload)
        if (!got) return
        const gid = typeof row.group_id === 'number' ? aliasFor(host, row.group_id) : row.group_id
        route(got.senderUIN, got.senderHost, got.envelope, gid, identity.uin, hostOf(identity.apiBase), got.senderSigningKey, identity)
      })
      if (catchingUp) endCatchUp()
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
      void decryptIncoming(identity, payload).then((got) => {
        if (got) route(got.senderUIN, got.senderHost, got.envelope, ev.group_id, identity.uin, hostOf(identity.apiBase), got.senderSigningKey, identity)
      })
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
      void handleGmsg(identity, payload, gid).then((got) => {
        if (got) route(got.senderUIN, undefined, got.envelope, gid, identity.uin, hostOf(identity.apiBase), undefined, identity)
      })
    })
  }, [identity, on])

  return null
}
