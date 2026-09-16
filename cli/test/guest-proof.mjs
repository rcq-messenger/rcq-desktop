// The `rcq-guest-v1` proof bytes, offline, against the server's own vector.
//
// Why this gets a test of its own: `POST /auth/guest` verifies an Ed25519
// signature over bytes the island rebuilds itself (rcq-server-ref
// app/services/guest_proof.py). One byte of disagreement, a lowercase host the
// server does not lowercase or a key spelled unpadded where the server pads,
// and every guest join from this client is a 401 `bad_signature` on every
// island. cli/test/fixtures/guest-proof-v1.json is copied verbatim from
// rcq-server-ref/fixtures, and Android and iOS test against the same file.
// Everything here is production code from src/lib/guest-proof.ts.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GUEST_PROOF_PREFIX,
  GUEST_PROOF_VERSION,
  canonicalGuestHost,
  canonicalKeyB64,
  decodeKey32,
  ed25519,
  guestProofBytes,
} from '../dist/guest.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fx = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'guest-proof-v1.json'), 'utf8'))

let n = 0
const check = (label, fn) => {
  fn()
  n++
  console.log('  ok  ' + label)
}

const hex = (b) => Buffer.from(b).toString('hex')
const seed = Uint8Array.from(Buffer.from(fx.signing_seed_hex, 'hex'))
const signingPub = ed25519.getPublicKey(seed)
const identityPub = decodeKey32(fx.identity_key_b64_unpadded)

check('the layout constants match the fixture', () => {
  assert.equal(GUEST_PROOF_PREFIX, 'rcq-guest-v1')
  assert.equal(GUEST_PROOF_VERSION, fx.version)
})

check('host canonicalisation matches the server', () => {
  assert.equal(canonicalGuestHost(fx.host_input), fx.canonical_host)
  for (const spelling of fx.host_spellings_same_binding) {
    assert.equal(canonicalGuestHost(spelling), fx.canonical_host, spelling)
  }
  // A non-default port is part of the binding; brackets of an IPv6 literal stay.
  assert.equal(canonicalGuestHost('Island.Example:8443'), 'island.example:8443')
  assert.equal(canonicalGuestHost('[::1]:443'), '[::1]')
  assert.equal(canonicalGuestHost('[::1]:8443'), '[::1]:8443')
  assert.equal(canonicalGuestHost('  api.rcq.app..  '), 'api.rcq.app')
})

check('keys decode from any spelling and re-encode padded', () => {
  assert.ok(identityPub)
  assert.equal(canonicalKeyB64(identityPub), fx.identity_key_b64)
  assert.equal(hex(decodeKey32(fx.identity_key_b64)), hex(identityPub))
  assert.equal(canonicalKeyB64(signingPub), fx.signing_key_b64)
  assert.equal(decodeKey32('AAAA'), null)
  assert.equal(decodeKey32('not base64 at all!'), null)
})

check('proof bytes equal the fixture byte for byte', () => {
  const bytes = guestProofBytes(fx.host_input, fx.group_id, identityPub, signingPub, fx.challenge)
  assert.equal(hex(bytes), fx.proof_bytes_hex)
  assert.equal(Buffer.from(bytes).toString('utf8'), fx.proof_bytes_text)
  // No trailing newline, six lines.
  assert.equal(Buffer.from(bytes).toString('utf8').split('\n').length, 6)
  assert.notEqual(bytes[bytes.length - 1], 0x0a)
})

check('the signature equals the fixture and verifies', () => {
  const bytes = guestProofBytes(fx.host_input, fx.group_id, identityPub, signingPub, fx.challenge)
  const sig = ed25519.sign(bytes, seed)
  assert.equal(Buffer.from(sig).toString('base64'), fx.signature_b64)
  assert.equal(ed25519.verify(Buffer.from(fx.signature_b64, 'base64'), bytes, signingPub), true)
})

check('every host spelling binds the same bytes', () => {
  const want = fx.proof_bytes_hex
  for (const spelling of fx.host_spellings_same_binding) {
    assert.equal(hex(guestProofBytes(spelling, fx.group_id, identityPub, signingPub, fx.challenge)), want, spelling)
  }
})

check('a swapped room, key or island is different bytes', () => {
  const base = hex(guestProofBytes(fx.host_input, fx.group_id, identityPub, signingPub, fx.challenge))
  assert.notEqual(hex(guestProofBytes(fx.host_input, fx.group_id + 1, identityPub, signingPub, fx.challenge)), base)
  assert.notEqual(hex(guestProofBytes('is2.rcq.app', fx.group_id, identityPub, signingPub, fx.challenge)), base)
  const otherIk = Uint8Array.from(identityPub)
  otherIk[0] ^= 1
  assert.notEqual(hex(guestProofBytes(fx.host_input, fx.group_id, otherIk, signingPub, fx.challenge)), base)
})

check('input that cannot be one line of the layout is refused', () => {
  assert.throws(() => guestProofBytes(fx.host_input, 0, identityPub, signingPub, fx.challenge))
  assert.throws(() => guestProofBytes(fx.host_input, -4, identityPub, signingPub, fx.challenge))
  assert.throws(() => guestProofBytes(fx.host_input, 4.5, identityPub, signingPub, fx.challenge))
  assert.throws(() => guestProofBytes(fx.host_input, fx.group_id, identityPub.slice(0, 31), signingPub, fx.challenge))
  assert.throws(() => guestProofBytes(fx.host_input, fx.group_id, identityPub, signingPub, 'a\nb'))
  assert.throws(() => guestProofBytes(fx.host_input, fx.group_id, identityPub, signingPub, ''))
  assert.throws(() => guestProofBytes('api.rcq.app\nx', fx.group_id, identityPub, signingPub, fx.challenge))
})

console.log(`guest-proof: ok (${n} checks)`)
