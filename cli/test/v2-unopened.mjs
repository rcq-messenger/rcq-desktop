// A v=2 message sealed to this device that the session here did not open
// (report 981, the client half).
//
// The WASM build of libsignal reports every failure as the same string, so
// WebSignalDevice.decrypt has to say itself which case it is: the outer layer
// was not ours (somebody else's copy, terminal), or it was ours and the
// ratchet did not open it. That second case used to read as null too, and the
// drains acked it away: a message lost for good on a tab whose session was a
// step behind the one another tab of the same install had persisted. Now it
// is a V2SessionError, and `opened` tells a copy already decrypted here (a
// re-served row, delivered the first time) from a message never read.
//
// Real libsignal, real sessions, no island.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import { WebSignalDevice, V2SessionError, bytesToB64 } from '../dist/crypto-v2.mjs'

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
const text = (id, t) => ({ kind: 'text', id, text: t })

const alice = await WebSignalDevice.create(100001, 1)
const bob = await WebSignalDevice.create(100002, 1)
const upload = await bob.buildBundle(4)
// What a second tab of Bob's install restored from disk before any session.
const bobBlobEarly = await bob.serialize()

await alice.establishSession(bundleOf(bob, upload))
const m1 = await alice.encryptTo(bob.uin, 1, bob.outerPub, text('AAAAAAAA-0000-4000-8000-000000000001', 'one'))
assert.equal((await bob.decrypt(m1)).envelope.text, 'one')
// Bob answers, so Alice's next messages are plain SignalMessages on the
// ratchet Bob's (this tab's) reply started.
await alice.decrypt(await bob.encryptTo(alice.uin, 1, alice.outerPub, text('BBBBBBBB-0000-4000-8000-000000000001', 'hi')))
const m2 = await alice.encryptTo(bob.uin, 1, bob.outerPub, text('AAAAAAAA-0000-4000-8000-000000000002', 'two'))

// 1. The stale tab: sealed to Bob's device, outer layer opens, the session
// is not there. Not a null any more.
const staleTab = await WebSignalDevice.restore(bobBlobEarly)
await assert.rejects(staleTab.decrypt(m2), (e) => {
  assert.ok(e instanceof V2SessionError, String(e))
  assert.equal(e.name, 'V2SessionError')
  assert.equal(e.opened, false, 'never opened here: a message unread, to be held')
  return true
})
console.log('  ok  a session a step behind throws V2SessionError, not opened')

// 2. The tab that holds the session opens it; a reload of the stale tab from
// what that one persisted opens it too. That is what holding it buys.
const bobBlobNow = await bob.serialize()
assert.equal((await bob.decrypt(m2)).envelope.text, 'two')
const reloaded = await WebSignalDevice.restore(bobBlobNow)
assert.equal((await reloaded.decrypt(m2)).envelope.text, 'two')
console.log('  ok  the same message opens on the session that holds it, and after a reload')

// 3. The same copy again on the device that opened it: a re-served row.
await assert.rejects(bob.decrypt(m2), (e) => {
  assert.ok(e instanceof V2SessionError)
  assert.equal(e.opened, true, 'opened here before: delivered, stays a null')
  return true
})
console.log('  ok  a copy this device already opened says so')

// 4. Somebody else's copy: the outer layer does not open. Not a session
// error at all, so it stays the terminal null it always was.
const carol = await WebSignalDevice.create(100003, 1)
await assert.rejects(carol.decrypt(m2), (e) => {
  assert.ok(!(e instanceof V2SessionError), String(e))
  return true
})
console.log('  ok  a copy sealed to another device is not a session error')

// 5. A PreKey message (a first contact), seen twice: the second is a
// re-served copy. A one-time prekey of its own: Alice's is spent.
const dave = await WebSignalDevice.create(100004, 1)
await dave.establishSession({ ...bundleOf(bob, upload), one_time_prekey: upload.one_time_prekeys[1] })
const p1 = await dave.encryptTo(bob.uin, 1, bob.outerPub, text('DDDDDDDD-0000-4000-8000-000000000001', 'pre'))
assert.equal((await bob.decrypt(p1)).envelope.text, 'pre')
await assert.rejects(bob.decrypt(p1), (e) => e instanceof V2SessionError && e.opened === true)
console.log('  ok  a PreKey message opened before reads as already opened')

// 6. A reload in between. The legacy queue and a room log re-serve every row
// behind a stuck one, and after a reload each of those used to read as never
// opened: a new hole of its own, holding the cursor for several drains. The
// fingerprints are saved with the ratchet that used up their keys.
const reloadedBob = await WebSignalDevice.restore(await bob.serialize())
await assert.rejects(reloadedBob.decrypt(m2), (e) => e instanceof V2SessionError && e.opened === true)
await assert.rejects(reloadedBob.decrypt(p1), (e) => e instanceof V2SessionError && e.opened === true)
// What a reload cannot open and never opened is still a hole: the stale tab's
// blob, saved before anything was opened, knows nothing of m2.
const staleAgain = await WebSignalDevice.restore(await staleTab.serialize())
await assert.rejects(staleAgain.decrypt(m2), (e) => e instanceof V2SessionError && e.opened === false)
// A blob written before the field existed restores as it always did.
const older = await bob.serialize()
delete older.opened
await assert.rejects((await WebSignalDevice.restore(older)).decrypt(m2), (e) => e instanceof V2SessionError && e.opened === false)
console.log('  ok  a copy opened before a reload still reads as opened after it')

console.log('v2 unopened ok: stale session held, reload opens it, re-served copy, other device, prekey repeat, opened across a reload')
