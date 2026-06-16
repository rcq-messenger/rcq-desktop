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

/// Fan the current signed record out to every (non-blocked) contact. Call this
/// AFTER a record change (add/remove backup, promote) — NOT on every boot
/// (that would re-send to everyone for nothing). Fully best-effort: a failed
/// contact just misses this push and re-learns the homes via the server gossip
/// mirror or the next push. Returns how many contacts accepted the deposit.
export async function pushHomeRecordToContacts(identity: WebIdentity): Promise<number> {
  const rec = await buildOwnRecord(identity)
  if (!rec) return 0
  let contacts: Contact[]
  try {
    contacts = await Api.contacts(identity)
  } catch {
    return 0
  }
  const targets = contacts.filter((c) => !c.blocked && c.uin !== identity.uin)
  const results = await Promise.all(targets.map((c) => pushToContact(identity, c, rec)))
  return results.filter(Boolean).length
}
