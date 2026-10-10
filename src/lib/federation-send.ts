// Federation Layer B (F2) — cross-island send.
//
// The reusable core that delivers a sealed envelope to a peer on ANOTHER island:
// resolve the peer's current homes (federation-protocol.md §4), seal the envelope
// to them (v=1 sealed sender, to the keys pinned when they were added; their
// island's open key card only before anything is pinned), and deposit a copy
// to each home's island. Receiving is unchanged — the peer polls
// their own island, into which we deposited.
//
// NOT yet wired into the live UI send path: that needs a cross-island *contact*
// model (a peer on another island does not fit the flagship's server-side
// /contacts system, so it has to be stored locally). This module is the proven,
// verified mechanism the eventual UI feature calls. v=1 only: a v=2 libsignal
// session needs the peer's auth-gated prekey bundle on their island, which a
// cross-island sender has no token for; v=1 needs only the public identity key
// from the open card, and v=1 is the 1:1 default anyway.

import type { WebIdentity, Envelope } from './crypto'
import { encryptV1, messageClass } from './crypto'
import { type ResolvedPeer } from './federation-resolve'
import { resolveAndMirrorHomes } from './multihome'
import { findCrossIslandByUin, type CrossIslandContact } from './crossisland-store'
import { contactsCache, snapshotFor } from './contacts-cache'
import { cardAgainstPin } from './peer-liveness-rules'
import { isPeerGone, isPeerKeyChanged, notePinnedCard } from './peer-liveness'

export interface PeerKeyCard {
  identity_key: string
  signing_key: string
  signal_identity_key?: string | null
  // §5c display: the open card now carries the peer's nickname (+ optional
  // gender/status) so a cross-island contact shows a real name, not uin@host.
  nickname?: string | null
  gender?: string | null
  status_message?: string | null
}

/// Fetch a peer's open public-key card from their island (no auth). Returns null
/// on any failure (caller decides whether to fall back to v=1-on-own-island).
export async function fetchPeerKeyCard(host: string, uin: number): Promise<PeerKeyCard | null> {
  try {
    const res = await fetch(`https://${host}/federation/keys/${uin}`)
    if (!res.ok) return null
    return (await res.json()) as PeerKeyCard
  } catch {
    return null
  }
}

export interface SealKeys {
  identityKey: string
  signingKey: string
}

/// The send refused to seal: the island serves this address under a key that
/// is not the one pinned for the contact. Thrown by `deliverCrossIsland`, so
/// every caller that already treats a throw as "not delivered" does so here.
export class CrossIslandKeyChangedError extends Error {
  constructor(
    readonly uin: number,
    readonly host: string,
  ) {
    super(`the key card for ${uin}@${host} is not the pinned one; not sealed`)
    this.name = 'CrossIslandKeyChangedError'
  }
}

/// The keys an envelope for `peerUin@peerHost` is sealed to.
///
/// ⚠⚠ THE PIN WINS, and a card under another key stops the send. This used to
/// be `card?.identity_key || pinned`, the live card first and no comparison,
/// on the idea that a fresh card catches a peer who rotated. What it caught
/// just as well: a burned number the island handed to somebody else (numbers
/// go straight back into circulation, and `desired_uin` lets anyone with a key
/// claim a free one), or an island that simply serves another card. Either
/// way the web sealed our message to the newcomer's key and they read it. The
/// phones seal to the pin; so does this now.
///
/// And a card that DIFFERS is not sealed to the pin either: the deposit would
/// land in the newcomer's mailbox as a row they cannot open, push their phone,
/// and still read as delivered here. Nothing goes; the address is marked key
/// changed (peer-liveness.ts) and the chat says so. No card at all (their
/// island down or refusing) is no evidence of anything, and the pin is used as
/// it always was, unless the address is already marked key changed: no card
/// does not lift evidence we hold, and the last card seen there was somebody
/// else's. A 429 on the card (an anonymous per-IP bucket, shared behind a
/// carrier NAT) used to let exactly the deposit above through on a retry.
///
/// No pin (a first contact request, before anything was pinned) is the one
/// case where the card is the key: that IS the trust-on-first-use moment.
///
/// Returns null when there is no key to seal to; `keyChanged` says why.
export async function sealingKeysFor(
  peerHost: string,
  peerUin: number,
  pinned?: SealKeys,
): Promise<{ keys: SealKeys; keyChanged: false } | { keys: null; keyChanged: boolean }> {
  const card = await fetchPeerKeyCard(peerHost, peerUin)
  if (pinned?.identityKey) {
    const verdict = cardAgainstPin(card, pinned)
    notePinnedCard(peerUin, peerHost, pinned.signingKey, verdict)
    if (verdict === 'differs') return { keys: null, keyChanged: true }
    // Only a card under the pin clears the mark (notePinnedCard above), and
    // only then does the send go to the pin again.
    if (verdict === 'no_card' && isPeerKeyChanged(peerUin, peerHost)) return { keys: null, keyChanged: true }
    return { keys: { identityKey: pinned.identityKey, signingKey: pinned.signingKey || '' }, keyChanged: false }
  }
  if (!card?.identity_key) return { keys: null, keyChanged: false }
  return { keys: { identityKey: card.identity_key, signingKey: card.signing_key || '' }, keyChanged: false }
}

/// Deposit ONE sealed envelope to a peer's PRIMARY island and nowhere else.
///
/// The counterpart to `deliverCrossIsland` for signalling-shaped envelopes
/// (§5d call signals, §5f contact requests). ⚠ Deliberately NO fan-out over
/// multihome backup homes: a backup mailbox is polled on a ~30s timer, so a
/// copy landing there buys nothing for something the peer acts on live, and it
/// duplicates a consent record into a mailbox the peer may never read. If the
/// primary is down the request simply has not been delivered yet — which is
/// the honest state, and the caller says so rather than claiming it was sent.
///
/// Returns true when the primary island accepted the deposit. Never throws.
export async function depositSealedToPrimary(
  sender: WebIdentity,
  peerHost: string,
  peerUin: number,
  envelope: Envelope,
  // Locally-pinned keys from an existing cross-island contact. When present
  // they are what gets sealed to (see `sealingKeysFor`). Read-only here:
  // sealing to a key never writes one.
  localKeys?: { identityKey: string; signingKey: string },
  // Outer deposit type. Stage 2: a call wake rides `envelope_type "message"`
  // with `ring:true` (see `ring` below) rather than the more telling type
  // "call": same routing, same queue row, only the wake differs, and the island
  // stores the quieter type. The INNER envelope is untouched either way: the
  // island sees an opaque sealed blob and learns only that a call is arriving.
  envelopeType: 'message' | 'call' = 'message',
  // Stage 2: ask the island to RING a closed app for this deposit. Pairs with
  // `envelope_type "message"` on an island that honours it; an older island
  // ignores the unknown field and rings only for type "call", so the caller
  // picks the type (see `honoursRing` in crossisland-call.ts).
  ring = false,
): Promise<boolean> {
  // Pinned keys first, and nothing at all to a card under another key: see
  // `sealingKeysFor`. A profile push sealed to a newcomer would hand them our
  // picture's key.
  const { keys } = await sealingKeysFor(peerHost, peerUin, localKeys)
  if (!keys) return false
  return depositSealedWithKeys(sender, peerHost, peerUin, envelope, keys, envelopeType, ring)
}

/// The half of `depositSealedToPrimary` that does not go looking for a key.
///
/// Split out for §5d: a call fires a burst of signals within a couple of
/// seconds, and fetching the peer's card before every one of them would put an
/// extra round trip in front of each — on the offer, where it is felt as the
/// gap between pressing the button and hearing ringback. The caller resolves
/// the key once and passes it here for the rest of the call.
export async function depositSealedWithKeys(
  sender: WebIdentity,
  peerHost: string,
  peerUin: number,
  envelope: Envelope,
  keys: { identityKey: string; signingKey: string },
  envelopeType: string = 'message',
  // Stage 2: ring a closed app (§5d wake). With `envelope_type "message"` on
  // an island that honours it; the caller sends type "call" to one that does not.
  ring = false,
): Promise<boolean> {
  try {
    if (!keys.identityKey) return false
    const sealed = encryptV1(envelope, sender, {
      uin: peerUin,
      identityKey: keys.identityKey,
      signingKey: keys.signingKey,
    })
    const body: Record<string, unknown> = {
      to_uin: peerUin,
      envelope_type: envelopeType,
      cls: messageClass(envelopeType), // Stage 2: mirror the island's derivation
      payload: sealed,
    }
    if (ring) body.ring = true
    const res = await fetch(`https://${peerHost}/messages/sealed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}

export interface CrossIslandResult {
  /// Number of island homes the sealed envelope was accepted by (HTTP 2xx).
  delivered: number
  /// The homes that were attempted.
  homes: ResolvedPeer['homes']
  /// True if the peer's island routing record verified (else single-home guess).
  verified: boolean
}

/// Deliver one envelope to `peerUin@peerHost`, depositing to every resolved home.
///
/// Returns how many island homes accepted it; 0 is a failed send, and the
/// caller has to say so. Throws only when there is no key it may seal to: no
/// pin and no card, or `CrossIslandKeyChangedError` when the island serves a
/// card under a key that is not the pinned one. Transient per-home deposit
/// failures are counted, not thrown, so multi-homing degrades gracefully.
export async function deliverCrossIsland(
  sender: WebIdentity,
  peerHost: string,
  peerUin: number,
  envelope: Envelope,
  // Locally-pinned keys from the cross-island contact (anchored at add-time).
  // When present they are the keys sealed to, always (see `sealingKeysFor`),
  // and the send survives the peer's island being blocked or dead: we reach
  // the peer via the gossip mirror of their record. Omitted = live card only.
  localKeys?: { identityKey: string; signingKey: string },
  // Deposit type. Defaults to "message", which is what an actual message wants
  // — the island pushes those. A silent sync (the `homerec` self-push) passes
  // its own non-pushable type so it does not buzz the peer's device for a
  // routing record they will never look at. The endpoint is type-agnostic on
  // every island (`SealedSendIn.envelope_type` is a free string that is only
  // matched against the pushable set), so this needs no server change.
  envelopeType = 'message',
): Promise<CrossIslandResult> {
  // The pin, and never a card under another key (see `sealingKeysFor`).
  const choice = await sealingKeysFor(peerHost, peerUin, localKeys)
  if (!choice.keys) {
    if (choice.keyChanged) throw new CrossIslandKeyChangedError(peerUin, peerHost)
    throw new Error(`cannot fetch key card for ${peerUin}@${peerHost}`)
  }
  const { identityKey, signingKey } = choice.keys

  // Gossip-aware home resolution: mirror the record onto our island on success,
  // reap our gossip mirror when the peer's island is unreachable. Floor to the
  // single address we have when nothing resolves.
  //
  // ⚠ Not for a contact marked gone (report 1067). Reading the mirror renews
  // the record it serves, so every retry to a burned account kept "this
  // person lives on these islands" alive on OUR island, against the whole
  // point of burning it. The address we hold is still tried: if the mark was
  // wrong, the card check above already cleared it when the island served the
  // pinned keys again, and their next message would too.
  let homes: ResolvedPeer['homes'] = []
  if (signingKey && !isPeerGone(peerUin, peerHost)) {
    homes = await resolveAndMirrorHomes(sender, peerHost, peerUin, signingKey)
  }
  const verified = homes.length > 0
  if (homes.length === 0) homes = [{ host: peerHost, uin: peerUin }]

  const sealed = encryptV1(envelope, sender, { uin: peerUin, identityKey, signingKey })

  let delivered = 0
  for (const home of homes) {
    try {
      const res = await fetch(`https://${home.host}/messages/sealed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `cls` (Stage 2) mirrors the island's own derivation from the type.
        body: JSON.stringify({ to_uin: home.uin, envelope_type: envelopeType, cls: messageClass(envelopeType), payload: sealed }),
      })
      if (res.ok) delivered++
    } catch {
      /* this home is unreachable; multi-homing covers it via the others */
    }
  }
  return { delivered, homes, verified }
}

/// A read or delivered receipt to a contact on ANOTHER island (#1062): to
/// THEIR island, sealed to the keys we pinned when we added them, under the
/// ephemeral "read" type so it never pushes. Receipts only ever went to our
/// own island, where that number is somebody else or nobody, so a cross-island
/// contact never saw a second tick from us. No card read: a drain can owe the
/// same few people dozens of receipts. Returns false when the peer is not a
/// cross-island contact, and the caller takes the same-island road.
///
/// A thread is keyed by the bare number, so a contact on OUR island with it
/// wins: the number may be a neighbour here and somebody else over there, and
/// their receipts must not cross (the add paths refuse that pairing now,
/// #1061, but a roster from before can still hold it).
export async function depositReceiptCrossIsland(
  sender: WebIdentity,
  peerUin: number,
  envelope: Envelope,
): Promise<boolean> {
  if (peerUin === sender.uin) return false
  const roster = contactsCache.get(sender.uin)?.contacts ?? snapshotFor(sender.uin)?.contacts
  if (roster?.some((c) => c.uin === peerUin && !c.host)) return false
  const ci = findCrossIslandByUin(peerUin)
  if (!ci) return false
  await depositReceiptToContact(sender, ci, envelope)
  return true
}

/// The same deposit to one known contact: a delivered receipt answers the
/// exact address and key the message was verified under, not a number.
export async function depositReceiptToContact(
  sender: WebIdentity,
  ci: CrossIslandContact,
  envelope: Envelope,
): Promise<boolean> {
  return depositSealedWithKeys(sender, ci.host, ci.uin, envelope, {
    identityKey: ci.identityKey,
    signingKey: ci.signingKey,
  }, 'read')
}
