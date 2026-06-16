// Visible in-browser proof that web-chat's REAL v=2 modules (crypto-v2.ts +
// the vendored libsignal-WASM) can SEND and RECEIVE Double-Ratchet messages.
// Two devices (Alice, Bob) establish a PQXDH session and exchange envelopes;
// each receiver decrypts the v=2 wire and renders the plaintext. No backend —
// this proves the client crypto; the over-the-wire path is the next layer.
//
// Served by Vite at /v2demo.html.

import { WebSignalDevice, type SignalBundle } from './lib/crypto-v2'
import { bytesToB64, type Envelope } from './lib/crypto'

const aliceBox = document.getElementById('alice')!
const bobBox = document.getElementById('bob')!
const checksEl = document.getElementById('checks')!
const doneEl = document.getElementById('done')!

let fails = 0
function check(name: string, cond: boolean) {
  const d = document.createElement('div')
  d.className = cond ? 'pass' : 'fail'
  d.textContent = `${cond ? 'PASS' : 'FAIL'}  ${name}`
  checksEl.appendChild(d)
  if (!cond) fails++
}

function bubble(box: HTMLElement, who: string, text: string, incoming: boolean) {
  const b = document.createElement('div')
  b.className = 'bubble' + (incoming ? ' in' : '')
  b.innerHTML = `<div class="meta">${who}</div>${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))}`
  box.appendChild(b)
}

// Turn a device's published bundle into the fetch-shape SignalBundle a peer
// uses for X3DH (the backend does this; here we wire it directly).
async function bundleOf(dev: WebSignalDevice): Promise<SignalBundle> {
  const up = await dev.buildBundle(5)
  return {
    uin: dev.uin,
    device_id: dev.deviceId,
    sealed_sender_pub: bytesToB64(dev.outerPub),
    registration_id: up.registration_id,
    signal_identity_key: up.signal_identity_key,
    signed_prekey: up.signed_prekey,
    kyber_prekey: up.kyber_prekey,
    one_time_prekey: up.one_time_prekeys[0],
  }
}

async function main() {
  // Two devices, each with its own libsignal identity + X25519 sealed-sender key.
  const alice = await WebSignalDevice.create(1000, 1)
  const bob = await WebSignalDevice.create(2000, 1)
  check('two WebSignalDevices created (WASM instantiated in-browser)', true)

  // Bob publishes a bundle; Alice establishes a PQXDH session with Bob.
  const bobBundle = await bundleOf(bob)
  await alice.establishSession(bobBundle)
  check('Alice established a Double-Ratchet session with Bob (X3DH+Kyber)', true)

  // Alice -> Bob (first message rides a libsignal PreKey message inside v=2).
  const m1: Envelope = { kind: 'text', id: 'AAAA0000-0000-4000-8000-000000000001', text: 'Привет Боб! приём в браузере 🔒' }
  const p1 = await alice.encryptTo(bob.uin, bob.deviceId, bob.outerPub, m1)
  bubble(aliceBox, 'sent → Bob', m1.text, false)
  const got1 = await bob.decrypt(p1, alice.uin, alice.deviceId)
  bubble(bobBox, `from ${got1.senderUIN}`, (got1.envelope as any).text, true)
  check('Bob received + decrypted Alice’s message', got1.senderUIN === alice.uin && (got1.envelope as any).text === m1.text)

  // Bob -> Alice reply (now a normal ratchet Signal message).
  const m2: Envelope = { kind: 'text', id: 'AAAA0000-0000-4000-8000-000000000002', text: 'Дошло! отвечаю, ратчет крутится 🔁' }
  const p2 = await bob.encryptTo(alice.uin, alice.deviceId, alice.outerPub, m2)
  bubble(bobBox, 'sent → Alice', m2.text, false)
  const got2 = await alice.decrypt(p2, bob.uin, bob.deviceId)
  bubble(aliceBox, `from ${got2.senderUIN}`, (got2.envelope as any).text, true)
  check('Alice received + decrypted Bob’s reply', got2.senderUIN === bob.uin && (got2.envelope as any).text === m2.text)

  // A few more ratchet steps both ways.
  let ok = true
  for (let i = 0; i < 4; i++) {
    const t = `msg #${i} both-way ratchet`
    const pa = await alice.encryptTo(bob.uin, bob.deviceId, bob.outerPub, { kind: 'text', id: `BBBB0000-0000-4000-8000-00000000000${i}`, text: t })
    const ga = await bob.decrypt(pa, alice.uin, alice.deviceId)
    ok = ok && (ga.envelope as any).text === t
    const pb = await bob.encryptTo(alice.uin, alice.deviceId, alice.outerPub, { kind: 'text', id: `CCCC0000-0000-4000-8000-00000000000${i}`, text: t })
    const gb = await alice.decrypt(pb, bob.uin, bob.deviceId)
    ok = ok && (gb.envelope as any).text === t
  }
  check('8 more ratchet steps (4 each way) all round-trip', ok)

  doneEl.className = fails === 0 ? 'pass' : 'fail'
  doneEl.textContent = fails === 0 ? 'WEB-CHAT v=2 SEND/RECEIVE WORKS ✅' : `${fails} CHECK(S) FAILED ❌`
  console.log(fails === 0 ? 'V2DEMO_OK' : 'V2DEMO_FAIL')
}

main().catch((e) => {
  doneEl.className = 'fail'
  doneEl.textContent = 'THREW: ' + (e?.message ?? String(e))
  console.error('V2DEMO_THREW', e)
})
