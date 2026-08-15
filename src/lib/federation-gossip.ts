// Federation gossip B1 (second half) — SELF-PUSH of the home-island record.
//
// The server gossip mirror (multihome.ts) lets a contact resolve your homes
// from THEIR island even after your island dies — but only if some client
// mirrored your record there first. Self-push closes the remaining gap: when
// your record CHANGES (you add/remove a backup, or promote a backup to
// primary), you proactively hand your fresh signed record to every contact, in
// an end-to-end-sealed `homerec` envelope. The contact verifies it against the
// signing key they already pinned for you and caches your new homes locally —
// so a later "both my islands are gone at once" still leaves your contacts
// knowing where you moved.
//
// Privacy: this only ever tells a contact about YOUR OWN homes, and only people
// who are already your contacts. Nothing about the social graph leaks (that's
// why we self-push instead of asking mutual contacts — the founder's call).

import type { WebIdentity, HomeRecordEnvelope } from './crypto'
import { bytesToB64, encryptV1 } from './crypto'
import { getDevice } from './signal-device'
import { buildHomeIslandRecord, type HomeIslandRecord } from './federation'
import { Api, peerBundleFrom, type Contact } from './api'
import { assembleHomes } from './multihome'
import { deliverCrossIsland } from './federation-send'
import { isBlocked } from './crossisland-requests'
import { listCrossIsland, type CrossIslandContact } from './crossisland-store'

// Non-pushable envelope_type: a silent record sync must NOT buzz the contact's
// device (the server only pushes message/system/secscreen).
const HOMEREC_TYPE = 'homerec'

/// Build this account's current signed home-island record (same shape as the
/// one PUT to islands). Returns null if the libsignal device isn't ready yet.
async function buildOwnRecord(identity: WebIdentity): Promise<HomeIslandRecord | null> {
  try {
    const device = await getDevice(identity)
    const ik = device.signalIdentityKeyB64()
    const sk = bytesToB64(identity.signingPub)
    const homes = assembleHomes(identity)
    const ts = Math.floor(Date.now() / 1000)
    return buildHomeIslandRecord({ ik, sk, signingPriv: identity.signingPriv, homes, ts })
  } catch {
    return null
  }
}

/// Seal `rec` to one contact and deposit it (their island for a cross-island
/// contact, ours for a flagship contact). Best-effort; never throws.
async function pushToContact(identity: WebIdentity, contact: Contact, rec: HomeIslandRecord): Promise<boolean> {
  const env: HomeRecordEnvelope = { kind: 'homerec', rec }
  try {
    if (contact.host) {
      // Cross-island contact: deliver to their home(s). deliverCrossIsland
      // seals from the locally-pinned keys and routes via gossip if needed.
      const res = await deliverCrossIsland(identity, contact.host, contact.uin, env, {
        identityKey: contact.identity_key,
        signingKey: contact.signing_key,
      })
      return res.delivered > 0
    }
    const wire = encryptV1(env, identity, peerBundleFrom(contact))
    await Api.sendSealed(identity, contact.uin, wire, HOMEREC_TYPE)
    return true
  } catch {
    return false
  }
}

/// Seal `rec` to one CROSS-ISLAND contact and deposit it to their island(s).
///
/// ⚠⚠ These people were missing from the fan-out entirely, and they are the
/// ones the record exists for. The audience below was `Api.contacts` — OUR OWN
/// island's contact list — which by construction contains nobody on another
/// island: a cross-island peer cannot be in it, because the island's contacts
/// table is a pair of local uins with no host column. So the record that
/// answers "where do I reach you when your island dies" was self-pushed to
/// exactly the people who can already reach us the ordinary way, and to none
/// of the people who cannot. Same family of hole as §5e itself.
async function pushToCrossIsland(
  identity: WebIdentity,
  c: CrossIslandContact,
  rec: HomeIslandRecord,
): Promise<boolean> {
  const env: HomeRecordEnvelope = { kind: 'homerec', rec }
  try {
    // Seals from the keys pinned at add-time and routes via the gossip mirror
    // when their island cannot serve a card, so this survives the outage it is
    // meant to prepare for. `homerec` (not `message`): a silent record sync
    // must not buzz their device — the same reason the local branch above
    // picks that type, and the deposit endpoint is type-agnostic on every
    // island, so it carries across unchanged.
    const res = await deliverCrossIsland(
      identity,
      c.host,
      c.uin,
      env,
      { identityKey: c.identityKey, signingKey: c.signingKey },
      HOMEREC_TYPE,
    )
    return res.delivered > 0
  } catch {
    return false
  }
}

/// Fan the current signed record out to every (non-blocked) contact, on our
/// island AND on others. Call this AFTER a record change (add/remove backup,
/// promote) — NOT on every boot (that would re-send to everyone for nothing).
/// Fully best-effort: a failed contact just misses this push and re-learns the
/// homes via the server gossip mirror or the next push. Returns how many
/// contacts accepted the deposit.
export async function pushHomeRecordToContacts(identity: WebIdentity): Promise<number> {
  const rec = await buildOwnRecord(identity)
  if (!rec) return 0
  let contacts: Contact[] = []
  try {
    contacts = await Api.contacts(identity)
  } catch {
    // Our own island being unreachable is not a reason to skip the cross-island
    // half — it is a reason to do it. This used to `return 0` here, so the one
    // failure that makes the record worth pushing also suppressed the push to
    // the only audience that could still receive it.
  }
  const local = contacts.filter((c) => !c.blocked && c.uin !== identity.uin)
  const foreign = listCrossIsland().filter((c) => !isBlocked(c.uin, c.host))
  const results = await Promise.all([
    ...local.map((c) => pushToContact(identity, c, rec)),
    ...foreign.map((c) => pushToCrossIsland(identity, c, rec)),
  ])
  return results.filter(Boolean).length
}
