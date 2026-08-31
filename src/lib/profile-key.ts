/// The profile key: your own face, sealed to your contacts.
///
/// `users.avatar_media_key` is the raw AES key of a profile photograph stored
/// on the island in the same row as the uin and the nickname, with the
/// ciphertext on the same disk behind an unauthenticated GET. A seized island
/// decrypts every face it holds. This module is the client half of taking that
/// key away from it (docs/profile-key-design.md).
///
/// Deliberately the group-state mechanism one level down: one AES-256-GCM key
/// per ACCOUNT instead of per room, distributed as an inner kind `pkey` riding
/// the OUTER type "skdm" — the carrier `gskey` already uses. Zero new envelope
/// types for the island, which matters: a new token would itself announce "this
/// account just changed its picture".
///
/// Recovery is `pkeyask` under outer "sknack", answered with an ordinary
/// `pkey`. Own devices read the key from the vault slot, same as room keys.

import { Api, peerBundleFrom } from './api'
import { encryptV1, bytesToB64, b64ToBytes, type Envelope, type WebIdentity } from './crypto'
import { readSlot, writeSlot, VaultError } from './vault'

/// The vault slot that carries our OWN key across our own installs.
export const VAULT_PKEY = 'pkey'

// ── stores ───────────────────────────────────────────────────────────────
// Two of them, and they answer different questions:
//   mine  — the key to MY picture, which I hand out.
//   theirs— peer uin -> their key, so I can open the picture they published.

let _uin: number | null = null
let mine: string | null = null
let theirs = new Map<number, string>()

const mineKey = (uin: number) => `rcq.web.pkey.${uin}`
const theirsKey = (uin: number) => `rcq.web.pkeys.${uin}`

export function loadProfileKeys(uin: number): void {
  _uin = uin
  mine = null
  theirs = new Map()
  try {
    mine = localStorage.getItem(mineKey(uin))
    const raw = localStorage.getItem(theirsKey(uin))
    if (raw) {
      for (const [peer, k] of Object.entries(JSON.parse(raw) as Record<string, string>)) {
        theirs.set(Number(peer), k)
      }
    }
  } catch {
    /* a browser with storage switched off still runs, it just re-asks */
  }
}

function persistTheirs(): void {
  if (_uin == null) return
  try {
    localStorage.setItem(theirsKey(_uin), JSON.stringify(Object.fromEntries(theirs)))
  } catch { /* nicety */ }
}

/// The key that opens `peer`'s avatar, or null when we were never given it.
/// Null is the lettered tile, exactly like "no picture at all" — the two must
/// stay indistinguishable or the tile becomes an oracle for "am I entitled".
export function peerProfileKey(peer: number): string | null {
  return theirs.get(peer) ?? null
}

/// The key MY OWN picture is sealed under, as this install knows it.
///
/// ⚠⚠ Every place that draws or forwards our own avatar has to come through
/// here. Under the profile-key model we PUT the media id ALONE and the island
/// clears the key column it used to keep, which is the whole point: it must not
/// hold the key to our face. So `me.avatar_media_key` from the island is null
/// forever after the first change, and anything reading it directly renders a
/// blank tile for its owner. Worse, `readOwnProfile` feeds the cross-island
/// profile SNAPSHOT, and a snapshot naming no picture reads on the far side as
/// "I removed mine" and deletes our face for every cross-island contact.
export function myProfileKey(): string | null {
  return mine
}

export function rememberPeerKey(peer: number, keyB64: string): void {
  if (!keyB64 || theirs.get(peer) === keyB64) return
  theirs.set(peer, keyB64)
  persistTheirs()
}

// ── my own key ───────────────────────────────────────────────────────────

/// My profile key, minted on first use. Read the vault BEFORE minting: a
/// second install of the same account must reuse the key its sibling already
/// handed out, or every contact's copy stops opening the new blob.
export async function ensureMyProfileKey(identity: WebIdentity): Promise<string> {
  if (mine) return mine
  try {
    const slot = await readSlot(identity, VAULT_PKEY)
    const fromVault = slot.plaintext ? new TextDecoder().decode(slot.plaintext) : null
    if (fromVault) {
      mine = fromVault
      try { localStorage.setItem(mineKey(identity.uin), fromVault) } catch { /* nicety */ }
      return fromVault
    }
  } catch (e) {
    if (!(e instanceof VaultError)) throw e
    // An island without the vault, or a locked one: mint locally rather than
    // refuse to set a picture. The mirror below will retry on the next change.
  }
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  const keyB64 = bytesToB64(raw)
  mine = keyB64
  try { localStorage.setItem(mineKey(identity.uin), keyB64) } catch { /* nicety */ }
  void mirrorMyKey(identity, keyB64)
  return keyB64
}

async function mirrorMyKey(identity: WebIdentity, keyB64: string): Promise<void> {
  // The merge keeps whatever a sibling install already published: two
  // installs minting at once must converge on ONE key, or half our contacts
  // hold a key that opens nothing.
  try {
    await writeSlot(identity, VAULT_PKEY, (remote) => (remote ? null : new TextEncoder().encode(keyB64)))
  } catch { /* best effort */ }
}

// ── distribution ─────────────────────────────────────────────────────────

/// Seal my key to one contact. Outer "skdm" for the same reason `gskey` uses
/// it: losing this leaves a face nobody can open, which is key-distribution
/// stakes, not chat.
export async function sendMyProfileKeyTo(
  identity: WebIdentity,
  peer: { uin: number; identity_key: string; signing_key?: string | null },
  keyB64: string,
): Promise<void> {
  const env: Envelope = { kind: 'pkey', key: keyB64 }
  const bundle = peerBundleFrom({
    uin: peer.uin,
    identity_key: peer.identity_key,
    signing_key: peer.signing_key ?? '',
  })
  await Api.sendSealed(identity, peer.uin, encryptV1(env, identity, bundle), 'skdm')
}

/// Hand the key to every contact, one at a time with a yield so a large roster
/// does not freeze the tab. Best effort per peer: one unreachable contact must
/// not cost everyone else their copy.
export async function fanOutMyProfileKey(
  identity: WebIdentity,
  contacts: Array<{ uin: number; identity_key?: string | null; signing_key?: string | null }>,
  keyB64: string,
): Promise<number> {
  let sent = 0
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i]
    if (!c.identity_key) continue
    try {
      await sendMyProfileKeyTo(identity, { uin: c.uin, identity_key: c.identity_key, signing_key: c.signing_key }, keyB64)
      sent += 1
    } catch { /* a peer we cannot reach today asks with pkeyask tomorrow */ }
    if (i % 16 === 15) await new Promise((r) => setTimeout(r, 0))
  }
  return sent
}

// ── receiving, and asking ────────────────────────────────────────────────

/// Handle an inbound `pkey`/`pkeyask`. Returns true when it was ours to eat.
/// ⚠ `from` is the SEALED sender identity the envelope was verified under, not
/// anything the wire claimed: a key is only ever filed against the person who
/// actually sealed it, or one account could publish a face as another.
export async function handleProfileKeyEnvelope(
  identity: WebIdentity,
  from: number,
  env: { kind?: string; key?: string },
): Promise<boolean> {
  if (env.kind === 'pkey') {
    if (typeof env.key === 'string' && env.key) rememberPeerKey(from, env.key)
    return true
  }
  if (env.kind === 'pkeyask') {
    // The vault fallback is what makes answering possible at all on an install
    // that never SET the picture: the CLI, a second browser, a fresh device.
    // Without it only the install that happened to mint the key could answer,
    // and a contact asking while you are at a terminal would simply never get
    // a face. The key is ours either way - the vault slot is our own.
    let k = mine
    if (!k) {
      try {
        const slot = await readSlot(identity, VAULT_PKEY)
        k = slot.plaintext ? new TextDecoder().decode(slot.plaintext) : null
        if (k) {
          mine = k
          try { localStorage.setItem(mineKey(identity.uin), k) } catch { /* nicety */ }
        }
      } catch { /* no vault on this island: nothing to answer with */ }
    }
    if (!k) return true
    try {
      const info = await Api.userInfo(identity, from)
      if (info?.identity_key) {
        await sendMyProfileKeyTo(
          identity,
          { uin: from, identity_key: info.identity_key, signing_key: info.signing_key },
          k,
        )
      }
    } catch { /* they ask again */ }
    return true
  }
  return false
}

/// Ask a peer for their key, throttled per peer so a contact list of faces we
/// are not entitled to does not turn into a poll.
const ASK_THROTTLE_MS = 6 * 60 * 60 * 1000
const askedAt = new Map<number, number>()

export async function askForProfileKey(
  identity: WebIdentity,
  peer: { uin: number; identity_key?: string | null; signing_key?: string | null },
): Promise<void> {
  if (!peer.identity_key) return
  const now = Date.now()
  const last = askedAt.get(peer.uin) ?? 0
  if (now - last < ASK_THROTTLE_MS) return
  askedAt.set(peer.uin, now)
  const env: Envelope = { kind: 'pkeyask' }
  const bundle = peerBundleFrom({
    uin: peer.uin,
    identity_key: peer.identity_key,
    signing_key: peer.signing_key ?? '',
  })
  // ⚠ Awaited, not fire-and-forget: the CLI proved this one (f721e4b) - a
  // process can die before an unawaited fetch leaves the machine.
  try {
    await Api.sendSealed(identity, peer.uin, encryptV1(env, identity, bundle), 'sknack')
  } catch { /* asked again after the throttle */ }
}

/// Byte helpers re-exported so callers do not reach past this module for the
/// one thing it exists to hand them.
export { b64ToBytes }
