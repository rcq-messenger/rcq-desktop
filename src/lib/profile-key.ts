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
import { contactsCache, snapshotFor } from './contacts-cache'
import { theirCard } from './guest-card'
import { encryptV1, bytesToB64, b64ToBytes, type Envelope, type WebIdentity } from './crypto'
import { readSlot, slotId, writeSlot, VaultError } from './vault'

/// The vault slot that carries our OWN key across our own installs.
///
/// ⚠⚠ THIS IS THE NAME, NOT THE SLOT. The island only ever accepts a slot of
/// 32 lower-case hex characters (`^[0-9a-f]{32}$` in its route), and the name
/// has to go through `slotId` first — that hash is the whole reason the island
/// cannot tell a profile key from a contact list. Sending the literal is not a
/// slot the island ignores, it is a 422 before the handler runs: every avatar
/// upload from the web and the desktop failed on it with a flat "could not
/// upload the picture", while Android (which derives it) worked. Report #1031,
/// proved on the island's own access log (`GET /vault/pkey 422`).
export const VAULT_PKEY = 'pkey'

/// The slot the island is asked for. Same 16 bytes Android derives from the
/// same literal (crypto/Vault.kt, `Vault.PKEY`), so a phone and a browser on
/// one account share ONE key: mint a rival and half your contacts end up
/// holding a key that opens nothing.
function pkeySlot(identity: WebIdentity): string {
  return slotId(identity, VAULT_PKEY)
}

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
  bump()
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

/// The own key of ANY account this browser holds, by number.
///
/// One screen needs it: the account switcher, whose rows belong to accounts
/// that are not the active one. They are the only own-face rows in the app that
/// cannot go through `myProfileKey()`, and without this they drew a flower over
/// a picture that is perfectly openable. The key is already stored per account
/// under `rcq.web.pkey.<uin>` — this only reads it.
export function profileKeyOfAccount(uin: number): string | null {
  if (_uin === uin && mine) return mine
  try {
    return localStorage.getItem(mineKey(uin))
  } catch {
    return null
  }
}

export function rememberPeerKey(peer: number, keyB64: string): void {
  if (!keyB64 || theirs.get(peer) === keyB64) return
  theirs.set(peer, keyB64)
  persistTheirs()
  bump()
}

// ── who is watching ──────────────────────────────────────────────────────
//
// ⚠⚠ THE STORES ABOVE ARE PLAIN MAPS AND NOTHING WAS SUBSCRIBED TO THEM. An
// avatar with no key draws the lettered tile and asks its owner for one; the
// answer arrives a second later, `rememberPeerKey` files it, and every avatar
// already on screen keeps its stale effect deps and never looks again. The
// face appeared only when the component happened to remount, so the ask-back
// path the whole design leans on did nothing within a session. The counter is
// what a caller puts in its deps (or reads through useSyncExternalStore) so a
// key that arrives repaints the tile it was asked for.

let version = 0
const watchers = new Set<() => void>()

function bump(): void {
  version += 1
  watchers.forEach((w) => { try { w() } catch { /* one bad listener is not the others' problem */ } })
}

/// Subscribe to "some profile key changed". Returns the unsubscribe.
export function subscribeProfileKeys(fn: () => void): () => void {
  watchers.add(fn)
  return () => { watchers.delete(fn) }
}

/// The current version, for `useSyncExternalStore` or an effect dep.
export function profileKeysVersion(): number {
  return version
}

// ── my own key ───────────────────────────────────────────────────────────

/// My profile key, minted on first use. Read the vault BEFORE minting: a
/// second install of the same account must reuse the key its sibling already
/// handed out, or every contact's copy stops opening the new blob.
export async function ensureMyProfileKey(identity: WebIdentity): Promise<string> {
  if (mine) return mine
  try {
    const slot = await readSlot(identity, pkeySlot(identity))
    const fromVault = slot.plaintext ? new TextDecoder().decode(slot.plaintext).trim() : null
    if (fromVault) return adopt(identity, fromVault)
  } catch (e) {
    // ⚠ Only a vault the island does not have, or one whose blob we cannot
    // open. Anything else (5xx, a rate limit, a dead connection) is rethrown
    // ON PURPOSE: it means we do not KNOW whether a key is published, and
    // minting a rival one under that doubt is permanent damage — two installs
    // handing out different keys leaves half a person's contacts looking at a
    // face that will never open. A retry costs one tap.
    if (!(e instanceof VaultError)) throw e
  }
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  const minted = bytesToB64(raw)
  // ⚠⚠ AWAITED, and the winner is whatever is actually in the slot. This used
  // to fire and forget: two installs minting at once both returned their own
  // key, sealed a blob under it and fanned it out, and the merge below quietly
  // kept only one of them. Publishing first wins, and the loser adopts.
  return adopt(identity, await mirrorMyKey(identity, minted))
}

/// The account's key as it is ALREADY PUBLISHED, read only: never mints, never
/// writes to the vault.
///
/// ⚠⚠ Why a read-only twin exists, and why it runs at sign-in. `mine` was only
/// ever filled by `ensureMyProfileKey`, which runs when somebody PICKS a
/// picture. An install that never picked one has nothing on disk: a browser
/// linked from a phone, a second browser, the desktop after a fresh install, a
/// reinstall. On those the account's own face stayed a flower — and worse, the
/// cross-island profile SNAPSHOT went out naming an avatar id with no key,
/// which the far side reads as "I removed my picture" and acts on. Android has
/// carried the same read-only twin since the model shipped
/// (data/ProfileKeyVault.publishedKey).
///
/// ⚠ It must NEVER mint. Minting from a start-up path would publish a rival
/// key on any island hiccup, and a rival key is permanent damage: half a
/// person's contacts end up holding one that opens nothing.
export async function loadPublishedProfileKey(identity: WebIdentity): Promise<string | null> {
  if (mine) return mine
  try {
    const slot = await readSlot(identity, pkeySlot(identity))
    const found = (slot.plaintext ? new TextDecoder().decode(slot.plaintext).trim() : '') || null
    return found ? adopt(identity, found) : null
  } catch {
    // No vault on this island, a blob we cannot open, or the island did not
    // answer. Nothing to adopt and nothing to mint: the next attempt asks again.
    return null
  }
}

/// Pin `keyB64` as this install's copy of the account's key.
function adopt(identity: WebIdentity, keyB64: string): string {
  if (mine === keyB64) return keyB64
  mine = keyB64
  try { localStorage.setItem(mineKey(identity.uin), keyB64) } catch { /* nicety */ }
  bump()
  return keyB64
}

/// Publish `keyB64` unless a sibling install already published one, and return
/// whichever key the account actually has. Falls back to the minted key when
/// the island has no vault at all: a picture only this install can open is
/// still better than refusing to set one, and the next change retries.
async function mirrorMyKey(identity: WebIdentity, keyB64: string): Promise<string> {
  let published: string | null = null
  try {
    await writeSlot(identity, pkeySlot(identity), (remote) => {
      const found = remote ? new TextDecoder().decode(remote).trim() : ''
      if (found) {
        published = found
        return null
      }
      return new TextEncoder().encode(keyB64)
    })
  } catch { /* best effort */ }
  return published ?? keyB64
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
  contacts: Array<{ uin: number; identity_key?: string | null; signing_key?: string | null; blocked?: boolean; host?: string | null }>,
  keyB64: string,
): Promise<number> {
  let sent = 0
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i]
    if (!c.identity_key) continue
    // ⚠ Blocked is not an audience. The key never rotates, so one fan-out to
    // somebody blocked hands them every picture the account will ever publish.
    if (c.blocked) continue
    // ⚠ A row with a host belongs to ANOTHER island's numbering space, and
    // `sendSealed` addresses OUR island — the same digits there are a
    // different person. Cross-island contacts get the key in the §5e profile
    // envelope deposited to their island, not from here.
    if (c.host) continue
    try {
      await sendMyProfileKeyTo(identity, { uin: c.uin, identity_key: c.identity_key, signing_key: c.signing_key }, keyB64)
      sent += 1
    } catch { /* a peer we cannot reach today asks with pkeyask tomorrow */ }
    if (i % 16 === 15) await new Promise((r) => setTimeout(r, 0))
  }
  return sent
}

// ── receiving, and asking ────────────────────────────────────────────────

/// One answer per asker per six hours, the same window Android keeps. A
/// question that costs us a vault read and a sealed send is a question worth
/// rate-limiting even from somebody entitled to the answer.
const ANSWER_THROTTLE_MS = 6 * 60 * 60 * 1000
const answeredAt = new Map<number, number>()

/// May `asker` be handed the key to my face?
///
/// Accepted contacts on THIS island, and nobody else. Read from the roster this
/// device already holds rather than from the island: the question is "did I
/// accept them", and the island is not the authority on that under stage 4 —
/// the roster is. A device with no roster yet answers no, which is the safe
/// half of a wrong answer.
///
/// ⚠ Same-island rows only. The key store is keyed by bare number, and a
/// cross-island contact wearing the same digits as a local one is a different
/// person; `host` set means the row is not about the number that just asked.
///
/// ⚠ And not somebody blocked. Blocking is "I want nothing more from you", and
/// handing over the key that opens every future picture is the opposite of it.
export function entitledToMyProfileKey(ownUin: number, asker: number): boolean {
  const roster = contactsCache.get(ownUin)?.contacts ?? snapshotFor(ownUin)?.contacts
  if (!roster || !roster.length) return false
  return roster.some((c) => c.uin === asker && !c.host && !c.blocked)
}


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
    // ⚠⚠ ONLY AN ACCEPTED CONTACT. This branch used to answer whoever asked.
    // The key is account-wide and deliberately never rotates, so one sealed
    // question from any account that knows my number bought the key to every
    // picture I will ever publish — and removing or blocking that person took
    // nothing back, because they already hold it. The design doc is not vague
    // about this: "Every accepted contact ... Nobody else. That IS the
    // visibility rule, enforced by key possession rather than by a server
    // check." iOS enforced it; the web did not.
    //
    // ⚠ Fail CLOSED. No roster on this device yet is not a reason to hand out
    // a key; they ask again after the throttle, and by then the roster is in.
    if (!entitledToMyProfileKey(identity.uin, from)) return true
    const nowAsk = Date.now()
    if (nowAsk - (answeredAt.get(from) ?? 0) < ANSWER_THROTTLE_MS) return true
    answeredAt.set(from, nowAsk)
    const k = mine ?? (await loadPublishedProfileKey(identity))
    if (!k) return true
    try {
      const info = await Api.userInfo(identity, from, theirCard(from))
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

/// A contact moved to a new UIN: keep the key that opens their face.
///
/// This map is the only copy — the island stopped holding the key column under
/// the profile-key model, which is the whole point of it — so a key left filed
/// under the number they walked away from is a contact whose picture turns into
/// a lettered tile and stays one until they happen to hand the key out again.
/// Indistinguishable, from the outside, from "they removed their picture".
///
/// Both halves are moved: the live map and the copy on disk. Returns true when
/// there was something to move.
export function carryPeerProfileKey(oldUin: number, newUin: number): boolean {
  if (oldUin === newUin) return false
  const k = theirs.get(oldUin)
  theirs.delete(oldUin)
  if (k == null) {
    persistTheirs()
    return false
  }
  // Never overwrite: a key already filed under the new number came from the
  // new number, and is the one that opens what is published there now.
  if (!theirs.has(newUin)) theirs.set(newUin, k)
  persistTheirs()
  return true
}
