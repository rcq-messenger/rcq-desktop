// Fully-offline crypto smoke test: two WebSignalDevices under Node, X3DH from
// a bundle, one v=2 message each way, plus a serialize/restore round — the
// same persistence shape the CLI writes between runs. Passing proves the
// pkg-node WASM alias and the node shims without touching any island.
//
// Run: npm run cli:test   (builds first — this imports the BUILT bundle)

import assert from 'node:assert/strict'
import { x25519, ed25519 } from '@noble/curves/ed25519'
import {
  WebSignalDevice,
  bytesToB64,
  encryptV1,
  decryptV1,
  bucketFor,
  padInnerBytes,
  shouldPadKind,
  BUCKETS,
} from '../dist/crypto-v2.mjs'

// The SignalBundle shape GET /keys/{uin}/devices/{id}/bundle serves, built
// locally from the device's own upload.
function bundleOf(dev, upload) {
  return {
    uin: dev.uin,
    device_id: dev.deviceId,
    sealed_sender_pub: bytesToB64(dev.outerPub),
    registration_id: upload.registration_id,
    signal_identity_key: upload.signal_identity_key,
    signed_prekey: upload.signed_prekey,
    kyber_prekey: upload.kyber_prekey,
    one_time_prekey: upload.one_time_prekeys[0],
  }
}

const alice = await WebSignalDevice.create(100001, 1)
const bob = await WebSignalDevice.create(100002, 1)
const bobUpload = await bob.buildBundle(4)

await alice.establishSession(bundleOf(bob, bobUpload))

const hello = { kind: 'text', id: 'AAAAAAAA-1111-4222-8333-444444444444', text: 'привет из консоли' }
const wire1 = await alice.encryptTo(bob.uin, bob.deviceId, bob.outerPub, hello)
const got1 = await bob.decrypt(wire1)
assert.equal(got1.senderUIN, alice.uin)
assert.equal(got1.senderDeviceId, 1)
assert.equal(got1.envelope.kind, 'text')
assert.equal(got1.envelope.text, hello.text)

// Bob replies over a RESTORED copy of himself: the ratchet must survive the
// serialize/restore cycle the CLI's file KV performs on every run.
const bob2 = await WebSignalDevice.restore(await bob.serialize())
const reply = { kind: 'text', id: 'BBBBBBBB-1111-4222-8333-444444444444', text: 'reply survives restore' }
const wire2 = await bob2.encryptTo(alice.uin, alice.deviceId, alice.outerPub, reply)
const got2 = await alice.decrypt(wire2)
assert.equal(got2.senderUIN, bob.uin)
assert.equal(got2.envelope.text, reply.text)

console.log('roundtrip ok: v2 X3DH + encrypt/decrypt both ways + serialize/restore under node')

// -----------------------------------------------------------
// Stage 2 (core-metadata plan): inner-plaintext size padding.
//
// The scheme pads the INNER sealed-sender JSON up to a size bucket before the
// AEAD seal. It must be transparent to the UNMODIFIED decoder (the sig is over
// ek||env, receivers ignore `_pad`), and every message in a bucket must seal to
// a blob of identical LENGTH, the only thing a wire observer can measure. The
// v2 `hello` above is a `text`, i.e. already a padded kind, so its round-trip
// proved v2 transparency; the block below proves v=1 transparency + the bucket
// arithmetic + indistinguishability.
// -----------------------------------------------------------

function mkV1Identity(uin) {
  const identityPriv = x25519.utils.randomPrivateKey()
  const signingPriv = ed25519.utils.randomPrivateKey()
  return {
    uin,
    jwt: '',
    apiBase: 'https://api.rcq.app',
    identityPriv,
    identityPub: x25519.getPublicKey(identityPriv),
    signingPriv,
    signingPub: ed25519.getPublicKey(signingPriv),
  }
}

const v1Sender = mkV1Identity(200001)
const v1Recip = mkV1Identity(200002)
const recipBundle = {
  uin: v1Recip.uin,
  identityKey: bytesToB64(v1Recip.identityPub),
  signingKey: bytesToB64(v1Recip.signingPub),
}

// [1] A padded content envelope opens on the unmodified decryptV1, byte-exact,
//     across sizes that fall in different buckets.
for (const n of [1, 200, 3000, 40000]) {
  const text = 'x'.repeat(n)
  const env = { kind: 'text', id: 'AAAAAAAA-1111-4222-8333-444444444444', text }
  const got = decryptV1(encryptV1(env, v1Sender, recipBundle), v1Recip)
  assert.equal(got.envelope.kind, 'text')
  assert.equal(got.envelope.text, text, `padded v1 text len=${n} must survive decrypt`)
}

// [2] padInnerBytes lands exactly on its bucket, and the padded JSON still
//     parses with every original field intact plus `_pad`.
for (const n of [0, 50, 300, 1000, 5000, 70000]) {
  const inner = { from: 200001, from_host: 'api.rcq.app', spub: 'S', sig: 'G', env: 'z'.repeat(n) }
  const unpadded = new TextEncoder().encode(JSON.stringify(inner)).length
  const padded = padInnerBytes(inner)
  assert.equal(padded.length, bucketFor(unpadded + 10), `inner len ${unpadded} must pad to its bucket`)
  const parsed = JSON.parse(new TextDecoder().decode(padded))
  assert.equal(parsed.env, 'z'.repeat(n))
  assert.equal(typeof parsed._pad, 'string')
}

// [3] Buckets are exactly the published ladder, then multiples of 65536.
assert.deepEqual([...BUCKETS], [256, 1024, 4096, 16384, 65536])
assert.equal(bucketFor(1), 256)
assert.equal(bucketFor(65536), 65536)
assert.equal(bucketFor(65537), 131072)
assert.equal(bucketFor(131072), 131072)
assert.equal(bucketFor(131073), 196608)

// [4] Indistinguishability: two different content messages whose inner lands in
//     the same bucket seal to blobs of IDENTICAL length.
const blobA = encryptV1({ kind: 'text', id: 'AAAAAAAA-1111-4222-8333-444444444444', text: 'hi' }, v1Sender, recipBundle)
const blobB = encryptV1(
  { kind: 'text', id: 'AAAAAAAA-1111-4222-8333-444444444444', text: 'a slightly longer message body' },
  v1Sender,
  recipBundle,
)
assert.equal(blobA.length, blobB.length, 'same-bucket messages must seal to equal-length blobs')

// [5] A non-content kind is NOT padded (sender-only policy), and still opens.
assert.equal(shouldPadKind('text'), true)
assert.equal(shouldPadKind('read'), false)
assert.equal(shouldPadKind('reaction'), false)
const receipt = { kind: 'read', targetIDs: ['AAAAAAAA-1111-4222-8333-444444444444'] }
assert.equal(decryptV1(encryptV1(receipt, v1Sender, recipBundle), v1Recip).envelope.kind, 'read')

console.log('padding ok: v1 padded seal opens on unmodified decrypt + exact buckets + equal-length blobs')
