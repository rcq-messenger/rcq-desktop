// The vault: opaque, versioned, client-sealed slots on the island.
//
// Stage 4 of the metadata plan moves the contact list off the island and onto
// the person's devices. Something still has to survive a reinstall, and the
// account's devices still have to agree with each other. The vault is both:
// PUT/GET/DELETE /vault/{slot}, where the island stores ciphertext and a
// version and holds neither a key nor a schema for what is inside.
//
// Derivation. Slot name and key both come from the account's long-term X25519
// identity private key, not from the 24-word seed: a browser linked from a
// phone, a legacy raw-key account and anyone who chose "forget the phrase"
// have no seed, while every device of an account holds identity_priv (the
// link blob carries it, and for a seed account it is itself HKDF(seed)). The
// shape is the one recovery.ts already proves byte-identical across iOS,
// Android and web: HKDF-SHA256, 32 zero bytes of salt, a fixed info string.
//
//   slot = hex( HKDF(identity_priv, zeros, "rcq.vault.slot.v1|" + name, 16) )
//   key  =      HKDF(identity_priv, zeros, "rcq.vault.key.v1|"  + slot, 32)
//   blob = 0x01 || nonce(12) || ChaCha20-Poly1305(key, nonce, plaintext,
//                                aad = "rcq.vault.v1|" + slot + "|" + version)
//
// The island sees a random-looking slot name rather than "contacts". The
// version is in the AAD so the island cannot relabel one version as another;
// a rollback to an older consistent (blob, version) pair is still possible and
// is caught by the caller remembering the last version it saw (readSlot
// refuses to go backwards).
//
// ⚠⚠ The #605 rule. A write names the version it was based on; the island
// advances it or answers 409 with the current one. `writeSlot` takes a MERGE
// function and loops: read, merge, write, and on 409 read again. Never write
// a slot from local state alone. Two devices that did that in August each
// silently un-published the other's backup island.
//
// ⚠ /auth/reissue rotates identity_priv, which rotates every slot name and
// key, and the island empties the account's vault in the same transaction.
// The client that rotates reads its slots BEFORE the call and writes them
// back under the new derivation AFTER it (not wired yet; the reissue path is
// a settings-only action today, and the contacts slot is a mirror of the
// server list that the next refresh rebuilds anyway).

import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { Api, ApiError } from './api'
import { bytesToB64, b64ToBytes, type WebIdentity } from './crypto'

const SALT = new Uint8Array(32)
const FORMAT_V1 = 0x01
const NONCE_LEN = 12
const enc = new TextEncoder()
const dec = new TextDecoder()

/// Names the first-party clients agree on. The island never sees these; it
/// sees `slotId(name)`.
export const VAULT_CONTACTS = 'contacts'

export function slotId(identity: WebIdentity, name: string): string {
  const id = hkdf(sha256, identity.identityPriv, SALT, enc.encode('rcq.vault.slot.v1|' + name), 16)
  return Array.from(id, (b) => b.toString(16).padStart(2, '0')).join('')
}

function slotKey(identity: WebIdentity, slot: string): Uint8Array {
  return hkdf(sha256, identity.identityPriv, SALT, enc.encode('rcq.vault.key.v1|' + slot), 32)
}

function aad(slot: string, version: number): Uint8Array {
  return enc.encode(`rcq.vault.v1|${slot}|${version}`)
}

/// Seal `plaintext` for `slot` as `version`. Padded to a 512-byte boundary
/// before sealing so the island learns the size class, not the size.
export function seal(identity: WebIdentity, slot: string, version: number, plaintext: Uint8Array): string {
  const padded = pad(plaintext)
  const nonce = new Uint8Array(NONCE_LEN)
  crypto.getRandomValues(nonce)
  const ct = chacha20poly1305(slotKey(identity, slot), nonce, aad(slot, version)).encrypt(padded)
  const out = new Uint8Array(1 + NONCE_LEN + ct.length)
  out[0] = FORMAT_V1
  out.set(nonce, 1)
  out.set(ct, 1 + NONCE_LEN)
  return bytesToB64(out)
}

/// Open a blob the island served as `version`. Throws on any mismatch: wrong
/// key (another account's identity), wrong slot, wrong version, tampering.
export function open(identity: WebIdentity, slot: string, version: number, blob: string): Uint8Array {
  const raw = b64ToBytes(blob)
  if (raw.length < 1 + NONCE_LEN + 16 || raw[0] !== FORMAT_V1) throw new VaultError('bad_format')
  const nonce = raw.subarray(1, 1 + NONCE_LEN)
  const ct = raw.subarray(1 + NONCE_LEN)
  let padded: Uint8Array
  try {
    padded = chacha20poly1305(slotKey(identity, slot), nonce, aad(slot, version)).decrypt(ct)
  } catch {
    throw new VaultError('bad_seal')
  }
  return unpad(padded)
}

// Plaintext framing: 4-byte big-endian length, the bytes, zero fill to the
// next 512-byte boundary (at least one full block).
function pad(p: Uint8Array): Uint8Array {
  const total = Math.max(512, Math.ceil((4 + p.length) / 512) * 512)
  const out = new Uint8Array(total)
  new DataView(out.buffer).setUint32(0, p.length)
  out.set(p, 4)
  return out
}

function unpad(b: Uint8Array): Uint8Array {
  if (b.length < 4) throw new VaultError('bad_format')
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0)
  if (4 + n > b.length) throw new VaultError('bad_format')
  return b.slice(4, 4 + n)
}

export class VaultError extends Error {
  constructor(public code: 'bad_format' | 'bad_seal' | 'rolled_back' | 'conflict_loop') {
    super(code)
  }
}

export interface SlotRead {
  /// null when the island has nothing under this slot (never written, or deleted).
  plaintext: Uint8Array | null
  /// The version to base the next write on: 0 for a slot that never existed,
  /// the tombstone's for a deleted one (the island never reuses a number
  /// within a slot, so a deleted-and-recreated slot keeps counting up).
  version: number
}

/// Read a slot and open it. `lastSeen` is the highest version this device has
/// seen for the slot; an island that answers with a LOWER one is serving an
/// old copy (a restored backup, or lying), and that is an error rather than
/// data, because acting on it would re-add what was deliberately removed.
export async function readSlot(identity: WebIdentity, slot: string, lastSeen = 0): Promise<SlotRead> {
  let res: { blob: string; version: number }
  try {
    res = await Api.vaultGet(identity, slot)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      // A 404 carries the version too: 0 when the slot never existed, the
      // tombstone's when it was deleted. Below the floor is a rollback
      // either way.
      const v = detailVersion(e) ?? 0
      if (v < lastSeen) throw new VaultError('rolled_back')
      return { plaintext: null, version: v }
    }
    throw e
  }
  if (res.version < lastSeen) throw new VaultError('rolled_back')
  return { plaintext: open(identity, slot, res.version, res.blob), version: res.version }
}

/// The island's list of this account's live slots and versions, no blobs.
/// One small request, meant for the socket (re)connect check: a
/// `vault_changed` nudge is pub/sub with no replay, so a device whose socket
/// was down when another device wrote never hears it, and compares this
/// against what it last saw instead.
export async function listSlots(identity: WebIdentity): Promise<Map<string, number>> {
  const r = await Api.vaultList(identity)
  return new Map(r.slots.map((s) => [s.slot, s.version]))
}

/// Read-merge-write with the #605 rule built in.
///
/// `merge(remote)` receives what the island holds right now (null when empty)
/// and returns what should be stored, or null to leave the slot as it is.
/// On 409 the island's current version is re-read and `merge` runs again on
/// the fresh copy. Resolves to the version written (or the version left in
/// place when merge returned null).
export async function writeSlot(
  identity: WebIdentity,
  slot: string,
  merge: (remote: Uint8Array | null, version: number) => Uint8Array | null,
  lastSeen = 0,
): Promise<number> {
  let seen = lastSeen
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await readSlot(identity, slot, seen)
    seen = cur.version
    const next = merge(cur.plaintext, cur.version)
    if (next === null) return cur.version
    const blob = seal(identity, slot, cur.version + 1, next)
    try {
      const r = await Api.vaultPut(identity, slot, blob, cur.version)
      return r.version
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Somebody else's write landed between our read and our write. The
        // island told us where it is now; go around with that.
        const v = staleVersion(e)
        if (v !== null) seen = Math.max(seen, v)
        continue
      }
      throw e
    }
  }
  throw new VaultError('conflict_loop')
}

/// Delete names the version it is based on, like a write: a stale delete is
/// 409 (re-read and decide again), a delete of what is already gone is 204.
export async function deleteSlot(identity: WebIdentity, slot: string, version: number): Promise<void> {
  await Api.vaultDelete(identity, slot, version)
}

function staleVersion(e: ApiError): number | null {
  return detailVersion(e)
}

function detailVersion(e: ApiError): number | null {
  try {
    const j = JSON.parse(e.body)
    const v = j?.detail?.version
    return typeof v === 'number' ? v : null
  } catch {
    return null
  }
}

/// The shape of a `vault_changed` socket frame: the island tells every
/// session of the account that a slot moved, with the new version (on a
/// delete, the tombstone's). The writer ignores the one it caused by
/// comparing versions.
export interface VaultChangedFrame {
  type: 'vault_changed'
  slot: string
  version: number
}

export function jsonBytes(v: unknown): Uint8Array {
  return enc.encode(JSON.stringify(v))
}

export function bytesJson<T>(b: Uint8Array): T {
  return JSON.parse(dec.decode(b)) as T
}
