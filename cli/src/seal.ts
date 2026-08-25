// State at rest, sealed under a passphrase.
//
// Everything the CLI holds — the identity and its private keys, the libsignal
// ratchets, the history of every conversation — has lived in ~/.config/rcq as
// plain files with 0600 on them. That is the right answer for a laptop nobody
// is after and the wrong one for the person this project exists for: a stolen
// machine, a copied disk, a backup that went somewhere it should not, and the
// whole thing reads without a password. The phones have had a PIN vault for
// months; the console had nothing.
//
// ⚠ THIS IS NOT A LOGIN. There is no server involved and nothing to ask: the
// passphrase is the only input to the key, so forgetting it is the same as
// deleting the directory. `rcq lock` says so in as many words before it does
// anything.
//
// Shape of a sealed value: version byte, 12-byte nonce, then AES-256-GCM
// ciphertext with its tag. Base64 when it has to live on one line (history is
// JSONL and stays appendable, one envelope per line, each with its own nonce).

import crypto from 'node:crypto'

/// scrypt, because it is in Node's standard library and Argon2 is not: a
/// native dependency in a client whose whole distribution story is "one file
/// you unpack" is a trade we do not make. N=2^16 costs ~100ms and 64 MB on a
/// laptop of 2026, which is a wall a GPU farm still has to climb per guess.
const KDF = { N: 1 << 16, r: 8, p: 1, keyLen: 32, maxmem: 128 * 1024 * 1024 } as const
const VERSION = 1
const NONCE_LEN = 12

export interface VaultMeta {
  v: number
  kdf: 'scrypt'
  N: number
  r: number
  p: number
  /// Base64. Random per vault, so two people with the same passphrase do not
  /// share a key, and a rainbow table has nothing to be a table of.
  salt: string
  /// A sealed known string. Lets `unlock` say "wrong passphrase" instead of
  /// handing back a key that produces garbage several files later.
  check: string
}

export function newSalt(): Buffer {
  return crypto.randomBytes(16)
}

export function deriveKey(passphrase: string, salt: Buffer, meta?: Pick<VaultMeta, 'N' | 'r' | 'p'>): Buffer {
  const N = meta?.N ?? KDF.N
  const r = meta?.r ?? KDF.r
  const p = meta?.p ?? KDF.p
  return crypto.scryptSync(passphrase.normalize('NFKC'), salt, KDF.keyLen, { N, r, p, maxmem: KDF.maxmem })
}

export function seal(key: Buffer, plaintext: Buffer | string): Buffer {
  const nonce = crypto.randomBytes(NONCE_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([
    cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    cipher.final(),
  ])
  return Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()])
}

/// Null when this is not one of ours or the tag does not verify. Callers treat
/// that as "unreadable", never as "empty": silently starting from scratch on a
/// file that failed to open is how an account gets replaced by a fresh one.
export function open(key: Buffer, blob: Buffer): Buffer | null {
  if (blob.length < 1 + NONCE_LEN + 16 || blob[0] !== VERSION) return null
  const nonce = blob.subarray(1, 1 + NONCE_LEN)
  const tag = blob.subarray(blob.length - 16)
  const body = blob.subarray(1 + NONCE_LEN, blob.length - 16)
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(body), d.final()])
  } catch {
    return null
  }
}

export function sealToBase64(key: Buffer, plaintext: string): string {
  return seal(key, plaintext).toString('base64')
}

export function openFromBase64(key: Buffer, b64: string): string | null {
  let blob: Buffer
  try {
    blob = Buffer.from(b64, 'base64')
  } catch {
    return null
  }
  const out = open(key, blob)
  return out ? out.toString('utf8') : null
}

export function makeMeta(key: Buffer, salt: Buffer): VaultMeta {
  return {
    v: VERSION,
    kdf: 'scrypt',
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    salt: salt.toString('base64'),
    check: sealToBase64(key, 'rcq-state-v1'),
  }
}

export function checkPasses(key: Buffer, meta: VaultMeta): boolean {
  return openFromBase64(key, meta.check) === 'rcq-state-v1'
}
