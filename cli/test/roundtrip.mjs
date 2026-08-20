// Fully-offline crypto smoke test: two WebSignalDevices under Node, X3DH from
// a bundle, one v=2 message each way, plus a serialize/restore round — the
// same persistence shape the CLI writes between runs. Passing proves the
// pkg-node WASM alias and the node shims without touching any island.
//
// Run: npm run cli:test   (builds first — this imports the BUILT bundle)

import assert from 'node:assert/strict'
import { WebSignalDevice, bytesToB64 } from '../dist/crypto-v2.mjs'

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
