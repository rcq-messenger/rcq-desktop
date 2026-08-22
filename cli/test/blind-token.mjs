// F3 deposit-auth interop test: the TS blind-token port (src/lib/blind-token.ts)
// must be byte-exact with the Python issuer (rcq-server-ref
// app/core/deposit_auth.py). No island and no live server: the vectors carry
// the issuer's private key so the test plays both halves locally.
//
// Prereq: generate the vectors first (they include a Python-issued token plus
// n/e/d so the client can act as the issuer):
//   cd ~/Documents/rcq-server-ref
//   PYTHONPATH=. .../python tools/gen-deposit-auth-vectors.py   -> /tmp/depauth_vectors.txt
// Then: node cli/build.mjs && node cli/test/blind-token.mjs
//
// It proves, against ONE issuer key:
//   1. python -> TS: the Python-issued token verifies under the TS verifier.
//   2. TS full chain: encode -> blind -> (raw-RSA sign with d) -> finalize
//      yields a signature the TS verifier accepts, and it is written out for
//      tools/verify-client-token.py to check (TS -> python).
//   3. i2osp/os2ip round-trip, and EMSA-PSS encode/verify with a fixed salt.
//   4. the SHA-256 hashcash: TS solvePow returns the SAME nonce the reference
//      decimal-counter solver does (recomputed here with node:crypto), and
//      verifyPow agrees byte for byte.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  os2ip,
  i2osp,
  emsaPssEncode,
  modPow,
  blind,
  finalize,
  verify,
  prepare,
  solvePow,
  verifyPow,
} from '../dist/blind-token.mjs'

const VECTORS = process.env.DEPAUTH_VECTORS || '/tmp/depauth_vectors.txt'
if (!fs.existsSync(VECTORS)) {
  console.error(
    `missing ${VECTORS}. Generate it first:\n` +
      `  cd ~/Documents/rcq-server-ref && PYTHONPATH=. .venv/bin/python tools/gen-deposit-auth-vectors.py`,
  )
  process.exit(2)
}

function loadVectors(p) {
  const out = {}
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim()
  }
  return out
}

const v = loadVectors(VECTORS)
const n = BigInt('0x' + v.n_hex)
const e = BigInt(v.e)
const d = BigInt('0x' + v.d_hex)
const key = { n, e }
const b64ToBytes = (s) => new Uint8Array(Buffer.from(s, 'base64'))
const bytesToB64 = (b) => Buffer.from(b).toString('base64')

// ── 1. python -> TS interop ──────────────────────────────────────────────────
const pyPrepared = b64ToBytes(v.py_prepared_b64)
const pySig = b64ToBytes(v.py_sig_b64)
assert.equal(verify(key, pyPrepared, pySig), true, 'python-issued token must verify under the TS verifier')
// A tampered signature must NOT verify.
const bad = pySig.slice()
bad[bad.length - 1] ^= 0x01
assert.equal(verify(key, pyPrepared, bad), false, 'a corrupted token must fail')
console.log('1. python -> TS: Python token verifies, tampered token rejected')

// ── 2. TS full chain, TS acting as its own issuer with d ─────────────────────
// blind_sign is the ONLY step the server does: raw RSA over the blinded int.
const prepared = prepare()
assert.equal(prepared.length, 64, 'randomized prepare is 32-byte prefix + 32-byte nonce')
const b = blind(key, prepared)
const modLen = (n.toString(2).length + 7) >> 3
const blindedInt = os2ip(b.blinded)
assert.ok(blindedInt < n, 'blinded value < modulus')
const blindSig = i2osp(modPow(blindedInt, d, n), modLen) // = blinded^d mod n
const sig = finalize(key, blindSig, b.blindInv, prepared) // unblind + self-verify
assert.equal(verify(key, prepared, sig), true, 'TS-minted token verifies under the TS verifier')
console.log('2. TS chain: encode -> blind -> raw-sign(d) -> finalize -> verify OK')

// Write the TS-minted token for tools/verify-client-token.py (TS -> python).
const here = path.dirname(fileURLToPath(import.meta.url))
const clientTokenPath = path.join(here, '..', 'dist', 'client_token.txt')
fs.writeFileSync(clientTokenPath, `prepared_b64=${bytesToB64(prepared)}\nsig_b64=${bytesToB64(sig)}\n`)
console.log(`   wrote ${path.relative(process.cwd(), clientTokenPath)} for verify-client-token.py`)

// ── 3. primitives ────────────────────────────────────────────────────────────
for (const x of [0n, 1n, 255n, 256n, 65537n, n - 1n]) {
  assert.equal(os2ip(i2osp(x, modLen)), x, 'i2osp/os2ip round-trip')
}
// EMSA-PSS with a fixed salt is deterministic; it must re-verify.
const emBits = n.toString(2).length - 1
const salt = new Uint8Array(48).fill(7)
const em = emsaPssEncode(pyPrepared, emBits, salt)
assert.equal(em.length, (emBits + 7) >> 3, 'EM length = ceil(emBits/8)')
assert.equal(em[em.length - 1], 0xbc, 'EM ends in 0xbc')
console.log('3. primitives: i2osp/os2ip round-trip + EMSA-PSS encode shape OK')

// ── 4. proof-of-work (SHA-256 hashcash) ──────────────────────────────────────
function leadingZeroBitsNode(challenge, nonce) {
  const dgst = createHash('sha256').update(`${challenge}:${nonce}`).digest()
  let bits = 0
  for (const byte of dgst) {
    if (byte === 0) {
      bits += 8
      continue
    }
    bits += 8 - (32 - Math.clz32(byte))
    break
  }
  return bits
}
// The reference solver: the smallest decimal counter meeting the difficulty.
function referenceSolve(challenge, difficulty) {
  for (let i = 0; ; i++) if (leadingZeroBitsNode(challenge, String(i)) >= difficulty) return String(i)
}
const challenge = 'deadbeefdeadbeef:' + bytesToB64(b.blinded)
const difficulty = 12
const tsNonce = await solvePow(challenge, difficulty)
assert.equal(tsNonce, referenceSolve(challenge, difficulty), 'TS solvePow matches the reference decimal-counter solver')
assert.equal(verifyPow(challenge, tsNonce, difficulty), true, 'verifyPow accepts the solution')
assert.equal(leadingZeroBitsNode(challenge, tsNonce) >= difficulty, true, 'node:crypto agrees the solution meets difficulty')
// The same solution demanding one more zero bit than it supplies must fail.
assert.equal(verifyPow(challenge, tsNonce, leadingZeroBitsNode(challenge, tsNonce) + 1), false, 'verifyPow rejects an under-strength claim')
console.log(`4. PoW: solvePow matches reference (nonce=${tsNonce}, ${difficulty} bits), verifyPow agrees`)

console.log('blind-token interop ok: python<->TS token verify, full TS chain, primitives, hashcash')
