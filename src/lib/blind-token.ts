// F3 deposit-auth client crypto: RFC 9474 RSA blind signatures (RSABSSA-SHA384-
// PSS, randomized), the client half of `rcq-server-ref app/core/deposit_auth.py`
// and a port of Android's `net/BlindToken.kt`.
//
// A deposit token lets an island rate-limit a request WITHOUT learning who made
// it: we blind a random nonce, the island blind-signs it (we pay proof-of-work),
// we unblind to a standard RSA-PSS signature and later spend it. The island
// verifies a plain RSA-PSS signature and remembers it as spent; the blinding
// makes the spend unlinkable to the issuance. Stage 3 of the core-metadata plan
// spends one of these on a peer's prekey bundle (`X-Deposit-Token`), so the
// island no longer learns "A is about to talk to B" from A's key lookup.
//
// Pure: BigInt arithmetic plus the synchronous SHA-256/SHA-384 from
// @noble/hashes (already a dependency), so the SAME code runs in the browser,
// in the Tauri webview and in the CLI under node, and a unit test can check it
// byte for byte against vectors the Python issuer emits
// (`tools/gen-deposit-auth-vectors.py`). Base64 and HTTP live in
// deposit-auth-store.ts. Mirrors the Python exactly: SHA-384 / MGF1-SHA-384 /
// salt 48, em_bits = modBits - 1, a randomized 32-byte prefix.
//
// ⚠ Nothing here is constant-time. It does not need to be: every value is
// either public (n, e, the blinded integer) or single-use random (r, the salt,
// the nonce), and no long-lived secret is ever an operand.

import { sha256, sha384 } from '@noble/hashes/sha2'

const SALT_LEN = 48
const H_LEN = 48 // SHA-384
const RANDOM_PREFIX_LEN = 32
const NONCE_LEN = 32

// ── integer <-> octet string (RFC 8017 §4) ──────────────────────────────────

/// I2OSP: `x` as exactly `len` big-endian unsigned bytes.
export function i2osp(x: bigint, len: number): Uint8Array {
  if (x < 0n) throw new Error('i2osp: negative')
  const out = new Uint8Array(len)
  let v = x
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  if (v !== 0n) throw new Error('i2osp: integer too large')
  return out
}

/// OS2IP: bytes as a non-negative integer.
export function os2ip(b: Uint8Array): bigint {
  let v = 0n
  for (let i = 0; i < b.length; i++) v = (v << 8n) | BigInt(b[i])
  return v
}

function bitLength(x: bigint): number {
  return x === 0n ? 0 : x.toString(2).length
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((acc, a) => acc + a.length, 0))
  let off = 0
  for (const a of arrays) {
    out.set(a, off)
    off += a.length
  }
  return out
}

// ── modular arithmetic ──────────────────────────────────────────────────────

/// base^exp mod m by square-and-multiply. The exponents here are the public e
/// (17 bits) and, in the unit test only, a private d (2048 bits).
export function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  if (m === 1n) return 0n
  let result = 1n
  let b = base % m
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m
    e >>= 1n
    b = (b * b) % m
  }
  return result
}

/// a^-1 mod m by the extended Euclidean algorithm; null when gcd(a, m) != 1.
export function modInverse(a: bigint, m: bigint): bigint | null {
  let [oldR, r] = [((a % m) + m) % m, m]
  let [oldS, s] = [1n, 0n]
  while (r !== 0n) {
    const q = oldR / r
    ;[oldR, r] = [r, oldR - q * r]
    ;[oldS, s] = [s, oldS - q * s]
  }
  if (oldR !== 1n) return null
  return ((oldS % m) + m) % m
}

// ── EMSA-PSS (RFC 8017 §9.1) ────────────────────────────────────────────────

/// MGF1 with SHA-384 (RFC 8017 §B.2.1).
function mgf1(seed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let off = 0
  for (let counter = 0; off < length; counter++) {
    const block = sha384(concat(seed, i2osp(BigInt(counter), 4)))
    const n = Math.min(block.length, length - off)
    out.set(block.subarray(0, n), off)
    off += n
  }
  return out
}

/// EMSA-PSS-ENCODE (RFC 8017 §9.1.1), SHA-384 / MGF1-SHA-384 / sLen=48. The
/// blind-signing client does this itself (the issuer only raw-RSA-signs the
/// blinded integer), so it has to match RFC 8017 exactly or the standard PSS
/// verify on the island rejects the unblinded token. `salt` is injectable for
/// the unit test; production callers leave it random.
export function emsaPssEncode(msg: Uint8Array, emBits: number, salt: Uint8Array = randomBytes(SALT_LEN)): Uint8Array {
  const emLen = Math.ceil(emBits / 8)
  if (emLen < H_LEN + SALT_LEN + 2) throw new Error('emsa-pss: modulus too small')
  if (salt.length !== SALT_LEN) throw new Error('emsa-pss: bad salt length')
  const mHash = sha384(msg)
  const h = sha384(concat(new Uint8Array(8), mHash, salt))
  const db = concat(new Uint8Array(emLen - SALT_LEN - H_LEN - 2), Uint8Array.of(0x01), salt)
  const dbMask = mgf1(h, emLen - H_LEN - 1)
  const maskedDb = db.map((x, i) => x ^ dbMask[i])
  // Clear the leftmost (8 * emLen - emBits) bits of maskedDB so EM < 2^emBits < n.
  const clear = 8 * emLen - emBits
  if (clear > 0) maskedDb[0] &= 0xff >> clear
  return concat(maskedDb, h, Uint8Array.of(0xbc))
}

/// EMSA-PSS-VERIFY (RFC 8017 §9.1.2) for the same parameters. Returns whether
/// `em` encodes `msg`.
function emsaPssVerify(msg: Uint8Array, em: Uint8Array, emBits: number): boolean {
  const emLen = Math.ceil(emBits / 8)
  if (em.length !== emLen || emLen < H_LEN + SALT_LEN + 2) return false
  if (em[emLen - 1] !== 0xbc) return false
  const maskedDb = em.subarray(0, emLen - H_LEN - 1)
  const h = em.subarray(emLen - H_LEN - 1, emLen - 1)
  const clear = 8 * emLen - emBits
  if (clear > 0 && (maskedDb[0] & ~(0xff >> clear) & 0xff) !== 0) return false
  const dbMask = mgf1(h, emLen - H_LEN - 1)
  const db = maskedDb.map((x, i) => x ^ dbMask[i])
  if (clear > 0) db[0] &= 0xff >> clear
  const psLen = emLen - H_LEN - SALT_LEN - 2
  for (let i = 0; i < psLen; i++) if (db[i] !== 0) return false
  if (db[psLen] !== 0x01) return false
  const salt = db.subarray(psLen + 1)
  const hPrime = sha384(concat(new Uint8Array(8), sha384(msg), salt))
  let diff = 0
  for (let i = 0; i < H_LEN; i++) diff |= h[i] ^ hPrime[i]
  return diff === 0
}

// ── prepare / blind / finalize / verify ─────────────────────────────────────

/// A fresh randomized prepared message: 32 random prefix bytes followed by a
/// 32-byte random token nonce (RFC 9474 §4.1, randomized variant).
export function prepare(): Uint8Array {
  return randomBytes(RANDOM_PREFIX_LEN + NONCE_LEN)
}

/// The issuer's public key as published by `GET /deposit-auth/params`.
export interface IssuerKey {
  n: bigint
  e: bigint
}

/// Blinding result. `blinded` goes to the issuer; `blindInv` and `prepared`
/// stay local until the blind signature comes back.
export interface Blinded {
  blinded: Uint8Array
  blindInv: bigint
  prepared: Uint8Array
}

/// CLIENT: blind a prepared message. blinded = m * r^e mod n, where
/// m = OS2IP(EMSA-PSS-ENCODE(prepared)). The issuer sees `blinded` alone.
export function blind(key: IssuerKey, prepared: Uint8Array): Blinded {
  const { n, e } = key
  const modBits = bitLength(n)
  const modLen = Math.ceil(modBits / 8)
  const m = os2ip(emsaPssEncode(prepared, modBits - 1))
  if (m >= n) throw new Error('blind: encoded message not < modulus')
  // r in [1, n) coprime to n. A random value of n's width fails the coprime
  // test with negligible probability (it would factor n), so the loop is a
  // formality that mirrors the reference.
  let r: bigint
  let rInv: bigint | null
  for (;;) {
    r = os2ip(randomBytes(modLen)) % n
    if (r < 1n) continue
    rInv = modInverse(r, n)
    if (rInv !== null) break
  }
  const x = (m * modPow(r, e, n)) % n
  return { blinded: i2osp(x, modLen), blindInv: rInv, prepared }
}

/// CLIENT: unblind the issuer's blind signature into a standard RSA-PSS
/// signature: s = blindSig * r^-1 mod n. Throws when the result does not
/// verify, which means the issuer signed under a key other than the one we
/// blinded for (an epoch rotated mid-mint) or handed back garbage.
export function finalize(key: IssuerKey, blindSig: Uint8Array, blindInv: bigint, prepared: Uint8Array): Uint8Array {
  const modLen = Math.ceil(bitLength(key.n) / 8)
  const s = (os2ip(blindSig) * blindInv) % key.n
  const sig = i2osp(s, modLen)
  if (!verify(key, prepared, sig)) throw new Error('finalize: produced an invalid signature')
  return sig
}

/// Whether `sig` is a valid RSA-PSS (SHA-384, salt 48) signature over
/// `prepared` under `key`. What the island checks when the token is spent;
/// here it is the interop oracle for the unit test and the finalize guard.
export function verify(key: IssuerKey, prepared: Uint8Array, sig: Uint8Array): boolean {
  const modBits = bitLength(key.n)
  const modLen = Math.ceil(modBits / 8)
  if (sig.length !== modLen) return false
  const s = os2ip(sig)
  if (s >= key.n) return false
  const emBits = modBits - 1
  const em = i2osp(modPow(s, key.e, key.n), Math.ceil(emBits / 8))
  return emsaPssVerify(prepared, em, emBits)
}

// ── proof-of-work (SHA-256 hashcash) ────────────────────────────────────────

function leadingZeroBits(d: Uint8Array): number {
  let bits = 0
  for (const v of d) {
    if (v === 0) {
      bits += 8
      continue
    }
    bits += Math.clz32(v) - 24 // 8 - bit_length(v)
    break
  }
  return bits
}

/// SHA-256(challenge || ':' || nonce) must carry at least `difficultyBits`
/// leading zero bits. Byte-identical on the island and every client.
export function verifyPow(challenge: string, nonce: string, difficultyBits: number): boolean {
  return leadingZeroBits(sha256(new TextEncoder().encode(`${challenge}:${nonce}`))) >= difficultyBits
}

/// How long one slice of the solver runs before handing the thread back. A
/// frame is 16 ms; this leaves the page most of each one.
const POW_SLICE_MS = 6

/// Hand the thread back for one turn of the event loop, through a channel the
/// browser does NOT throttle in a hidden tab.
///
/// ⚠ Not setTimeout. Chrome aligns timers in a background tab to once a second
/// and, for a chain nested this deep, to once a MINUTE after five minutes
/// hidden; WebKit (the Tauri webview on macOS) aligns to a second. A mint is
/// some forty slices, so a token minted behind a tab that had been in the
/// background a while would have taken forty seconds to forty minutes, and the
/// delivery receipt waiting on it (sent on arrival, whether or not the tab is
/// visible) with it. scheduler.yield where the browser has it (it keeps the
/// task's own priority), setImmediate under node, a MessageChannel message
/// everywhere else: none of the three is timer-aligned. setTimeout stays as
/// the last resort for a runtime that has none of them.
function yieldSlice(): Promise<void> {
  const g = globalThis as {
    scheduler?: { yield?: () => Promise<void> }
    setImmediate?: (cb: () => void) => unknown
  }
  if (typeof g.scheduler?.yield === 'function') return g.scheduler.yield()
  if (typeof g.setImmediate === 'function') return new Promise<void>((resolve) => g.setImmediate!(resolve))
  if (typeof MessageChannel === 'function') {
    return new Promise<void>((resolve) => {
      const ch = new MessageChannel()
      ch.port1.onmessage = () => {
        ch.port1.close()
        resolve()
      }
      ch.port2.postMessage(0)
    })
  }
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/// Solve the hashcash bound to `challenge` (= "{epoch_id}:{blinded_b64}"): the
/// decimal counter the reference solver uses, so the nonce is a short ASCII
/// string the island accepts as-is.
///
/// Runs in slices of POW_SLICE_MS with a yield between them (yieldSlice), so
/// the browser repaints and handles input while 2^difficulty hashes go by, and
/// keeps hashing at full speed when the tab is hidden. The hashing itself is
/// the synchronous SHA-256 from @noble/hashes on every runtime, the CLI
/// included: a WebCrypto digest is asynchronous per call, and 260k awaited
/// digests would cost more in scheduling than in hashing. The hash state after
/// the fixed prefix is computed once and cloned per nonce, which is the
/// difference between a token costing a second and costing a fraction of one:
/// the challenge spans several SHA-256 blocks, the nonce one.
export async function solvePow(challenge: string, difficultyBits: number): Promise<string> {
  const enc = new TextEncoder()
  const base = sha256.create().update(enc.encode(`${challenge}:`))
  let counter = 0
  for (;;) {
    const sliceEnd = Date.now() + POW_SLICE_MS
    do {
      const nonce = String(counter)
      if (leadingZeroBits(base.clone().update(enc.encode(nonce)).digest()) >= difficultyBits) return nonce
      counter++
      // The clock is read once per few hundred hashes: it costs about as much
      // as a hash does.
    } while ((counter & 0x1ff) !== 0 || Date.now() < sliceEnd)
    await yieldSlice()
  }
}
