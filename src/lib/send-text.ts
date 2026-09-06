// One line of text into a thread that is NOT the one on screen: a forward
// out of a chat, a site's address out of the browser (#852).
//
// The composer has its own send path, and keeps it: it knows its thread, its
// timer, its sender keys and its row state. This is the path for a message
// composed anywhere and landing over there, and it does for the target what
// the composer does for its own thread - seals it for the target, mirrors it
// to our other devices, and files the row in the target thread's log so it
// is there when that thread is next opened. It used to live inside Chat.tsx,
// where only a chat could reach it, which is why the browser had nowhere to
// send an address.

import { Api, peerBundleFrom, type Contact, type RCQGroup } from './api'
import {
  bytesToB64,
  encryptV1,
  newUUIDv4,
  type CarbonEnvelope,
  type Envelope,
  type TextEnvelope,
  type WebIdentity,
} from './crypto'
import { threadTtl, ttlThreadKey } from './disappearing'
import { encryptGroupEnvelope } from './group-crypto'
import { ensureRoster } from './group-roster'
import { appendToThreadLog, ownExpiry, storageKey, type OutgoingRow } from './outgoing-store'
import { groupApiCtx } from './visited-islands'

/// Where a picked message goes: a contact, or a group. A foreign group comes
/// with its LOCAL alias as `id`; `groupApiCtx` resolves the island.
export type ForwardTarget =
  | { kind: 'peer'; uin: number; name: string; contact: Contact }
  | { kind: 'group'; id: number; name: string; group: RCQGroup }

/// A refusal the screen has a sentence for: `chat.error.<code>`.
export class SendTextError extends Error {
  constructor(readonly code: 'group_no_valid_members' | 'group_empty') {
    super(code)
  }
}

/// Mirror a sent envelope to our own other devices: wrap it with its
/// destination, seal it to ourselves, deposit it to our own number. The other
/// device files the inner message as ours in the destination thread; this one
/// dedups its own carbon by id. Best-effort - the message already went out.
///
/// ⚠ Foreign-group sends are not mirrored (`gid` null): the carbon would
/// carry a group id that another of our devices would read as a LOCAL group,
/// since alias ids are per device. v1 limit, documented in §5c.
export async function sendCarbon(
  identity: WebIdentity,
  inner: Envelope,
  to: number | null,
  gid: number | null,
): Promise<void> {
  if (to == null && gid == null) return
  try {
    const carbon: CarbonEnvelope = { kind: 'carbon', to, gid, env: inner }
    const selfBundle = peerBundleFrom({
      uin: identity.uin,
      identity_key: bytesToB64(identity.identityPub),
      signing_key: bytesToB64(identity.signingPub),
    })
    const wireB64 = encryptV1(carbon, identity, selfBundle)
    // Non-pushable type: it syncs over WS / the per-device queue, and never
    // pushes a "new message" alert to our own phone for a message we sent.
    await Api.sendSealed(identity, identity.uin, wireB64, 'carbon')
  } catch {
    /* best-effort multi-device echo; ignore */
  }
}

/// Send `text` to `target` as an ordinary text message and file it in that
/// thread's log. `fwdName` credits the original author of a forward; a
/// message composed here and now carries none.
///
/// Returns the row that was filed, for the caller's own bookkeeping (a sound,
/// a toast). Throws `SendTextError` for the two refusals with a sentence of
/// their own, and whatever the island or the sealing threw otherwise.
export async function sendTextTo(
  identity: WebIdentity,
  target: ForwardTarget,
  text: string,
  fwdName?: string,
): Promise<OutgoingRow> {
  const id = newUUIDv4()
  // ⚠ The TARGET thread's timer, not the one this was composed in. A message
  // composed here lands over there, and a forward used to carry no `ttl` at
  // all: one line forwarded into a room set to five minutes was permanent, on
  // every participant's device, under a header that says everything
  // disappears. Same shape `dyingNow` gives the composer's own sends, read
  // off the destination.
  const sentAt = Date.now()
  const targetTtl = threadTtl(ttlThreadKey(target.kind === 'group', target.kind === 'group' ? target.id : target.uin))
  const expiresAt = ownExpiry(targetTtl, sentAt)
  // ⚠⚠ `ts` goes on EVERY envelope, not just a disappearing one. It used to
  // ride along with `ttl`, so an ordinary message from this client carried no
  // send time at all, and the receiving client fell back to the moment it
  // arrived (`incoming-store`: `sentAt ?? at`). On a device that had been
  // offline for a few minutes that put the message below replies to it, under
  // the wrong clock: the founder saw one conversation in two different orders
  // on his phone and his desktop, 2026-09-06. iOS and Android have always
  // stamped every send; this client was the odd one out.
  const stamp = { ts: Math.floor(sentAt / 1000) }
  const dying: { ttl?: number } =
    targetTtl != null && expiresAt != null ? { ttl: targetTtl } : {}
  const env: TextEnvelope = { kind: 'text', id, text, ...(fwdName ? { fwdName } : {}), ...stamp, ...dying }

  let carbonGid: number | null = null
  if (target.kind === 'group') {
    // target.id may be a foreign-group alias: resolve the island ctx.
    const fctx = groupApiCtx(identity, target.id)
    // ⚠ The picker's list is fetched without rosters, so this group can carry
    // an empty member list. Sealing against that produces no payloads at all,
    // and the send would report an empty group - or worse, on a partial
    // roster, quietly reach only some of it.
    const full = await ensureRoster(fctx.ident, target.group)
    // A solo group (only us in the fresh roster) takes the message with an
    // empty wire, same as the composer does: the row lands in the thread below
    // and nobody else exists to reach.
    const solo =
      full.members.some((m) => m.uin === fctx.ident.uin) && !full.members.some((m) => m.uin !== fctx.ident.uin)
    if (!solo) {
      const { payloads, skipped } = await encryptGroupEnvelope(env, fctx.ident, full.members)
      if (payloads.length === 0) {
        throw new SendTextError(skipped.length > 0 ? 'group_no_valid_members' : 'group_empty')
      }
      await Api.sendGroupSealed(fctx.ident, fctx.gid, payloads)
    }
    carbonGid = fctx.host ? null : target.id
  } else {
    const wireB64 = encryptV1(env, identity, peerBundleFrom(target.contact))
    await Api.sendSealed(identity, target.uin, wireB64)
  }

  // ⚠⚠ Mirror it, like every other send does. The forward was once the one
  // path that never carboned, so a message forwarded from the desktop simply
  // never existed on the phone - the group fan-out deliberately skips
  // ourselves, so the carbon is the ONLY road our own words take to our own
  // other devices. Addressed at the TARGET thread, because that is where the
  // row lands.
  void sendCarbon(identity, env, target.kind === 'group' ? null : target.uin, carbonGid)

  const row: OutgoingRow = {
    id,
    text,
    sentAt,
    state: 'sent',
    ...(fwdName ? { fwdName } : {}),
    ...(expiresAt != null ? { expiresAt } : {}),
  }
  appendToThreadLog(storageKey(target.kind === 'group', target.kind === 'group' ? target.id : target.uin), row)
  return row
}
