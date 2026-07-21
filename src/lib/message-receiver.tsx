// App-wide receive loop. Mounted once under WSProvider. On connect it ensures
// this account is provisioned as a libsignal device, drains the offline queue,
// and decrypts each envelope; live WS `message` pushes are decrypted too. Both
// feed the incoming-store, deduped by envelope id. Renders nothing.

import { useEffect } from 'react'
import { useIdentity } from './identity-context'
import { useWS } from './ws'
import { decryptIncoming, getDevice } from './signal-device'
import { addIncoming, addGroupIncoming, hydrateIncoming } from './incoming-store'
import { fileOutgoingCarbon } from './outgoing-store'
import { publishHomeIslandRecord } from './federation-publish'
import { applyPushedRecord, drainBackupQueues, listBackupHomes } from './multihome'
import { aliasFor, drainVisitedQueues, listVisitedIslands } from './visited-islands'
import { getCrossIsland } from './crossisland-store'
import { holdRequestMessage } from './crossisland-requests'
import { handleGmsg, handleSkdm, handleSknack } from './sender-key-receive'
import { Api } from './api'
import type { WebIdentity } from './crypto'

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
    handleSkdm(senderUIN, senderSigningKey, envelope as unknown as { gid: number; kid: string; e: number; i: number; ck: string })
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
    const tick = async () => {
      if (cancelled || listBackupHomes().length === 0) return
      await ensureHydrated(identity.uin) // dedup needs the seen-set first
      await drainBackupQueues(identity, async (row, host) => {
        if (cancelled) return
        const got = await decryptIncoming(identity, row.payload)
        if (!got) return
        // A group row in a BACKUP mailbox = that island also hosts a group we
        // joined (same identity, same mailbox) — alias it like the visited poll.
        const gid = typeof row.group_id === 'number' ? aliasFor(host, row.group_id) : row.group_id
        route(got.senderUIN, got.senderHost, got.envelope, gid, identity.uin, hostOf(identity.apiBase), got.senderSigningKey, identity)
      })
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
    const tick = async () => {
      if (cancelled || listVisitedIslands().length === 0) return
      await ensureHydrated(identity.uin) // dedup needs the seen-set first
      await drainVisitedQueues(identity, async (row, host) => {
        if (cancelled) return
        const got = await decryptIncoming(identity, row.payload)
        if (!got) return
        const gid = typeof row.group_id === 'number' ? aliasFor(host, row.group_id) : row.group_id
        route(got.senderUIN, got.senderHost, got.envelope, gid, identity.uin, hostOf(identity.apiBase), got.senderSigningKey, identity)
      })
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
    const SEALED_WS_TYPES = ['message', 'reaction', 'delete', 'edit', 'read', 'system', 'secscreen', 'visit', 'bounce', 'carbon', 'homerec']
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
