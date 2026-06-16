// Proves the device survives a reload: A is serialized to IndexedDB and
// restored into a fresh WebSignalDevice (the REAL crypto-v2 + signal-persist
// code), then the restored A keeps decrypting — both a CONTINUING session
// (whisper) and a FRESH inbound from a new sender (prekey against A's persisted
// prekeys). If keys/sessions didn't persist, these would fail. Served at
// /persist-demo.html.

import { WebSignalDevice, type SignalBundle, type DeviceBlob } from './lib/crypto-v2'
import { idbSet, idbGet, idbDel } from './lib/signal-persist'
import { bytesToB64, type Envelope } from './lib/crypto'

const logEl = document.getElementById('log')!
const doneEl = document.getElementById('done')!
let fails = 0
const step = (m: string) => { const d = document.createElement('div'); d.className = 'step'; d.textContent = '› ' + m; logEl.appendChild(d) }
const check = (n: string, c: boolean) => { const d = document.createElement('div'); d.className = c ? 'pass' : 'fail'; d.textContent = `${c ? 'PASS' : 'FAIL'}  ${n}`; logEl.appendChild(d); if (!c) fails++ }

async function bundleOf(dev: WebSignalDevice): Promise<SignalBundle> {
  const up = await dev.buildBundle(5)
  return {
    uin: dev.uin, device_id: dev.deviceId, sealed_sender_pub: bytesToB64(dev.outerPub),
    registration_id: up.registration_id, signal_identity_key: up.signal_identity_key,
    signed_prekey: up.signed_prekey, kyber_prekey: up.kyber_prekey, one_time_prekey: up.one_time_prekeys[0],
  }
}

async function main() {
  await idbDel('persist-test')
  const A = await WebSignalDevice.create(1000, 1)
  const B = await WebSignalDevice.create(2000, 1)
  const C = await WebSignalDevice.create(3000, 1)
  const bundleA = await bundleOf(A) // A's published bundle (built once)

  step('B opens a session to A, sends a PreKey message; A decrypts')
  await B.establishSession(bundleA)
  const m1: Envelope = { kind: 'text', id: 'AAAA0000-0000-4000-8000-000000000001', text: 'msg1 before reload' }
  const got1 = await A.decrypt(await B.encryptTo(A.uin, A.deviceId, A.outerPub, m1))
  check('A decrypted msg1 (session established on A)', (got1.envelope as any).text === m1.text)

  step('serialize A → IndexedDB → restore into A2 (simulating a page reload)')
  const blob = await A.serialize()
  await idbSet('persist-test', blob)
  const saved = await idbGet<DeviceBlob>('persist-test')
  check('blob round-tripped through IndexedDB (Uint8Arrays intact)', !!saved && saved.idkp instanceof Uint8Array && saved.sessions.length === 1)
  const A2 = await WebSignalDevice.restore(saved!)

  step('restored A2 decrypts a CONTINUING message from B (whisper in the persisted session)')
  const m2: Envelope = { kind: 'text', id: 'AAAA0000-0000-4000-8000-000000000002', text: 'msg2 after reload, same session' }
  const got2 = await A2.decrypt(await B.encryptTo(A.uin, A.deviceId, A.outerPub, m2))
  check('A2 decrypted msg2 → session SURVIVED the reload', (got2.envelope as any).text === m2.text)

  step('restored A2 decrypts a FRESH PreKey from a NEW sender C (against A’s persisted prekeys)')
  await C.establishSession(bundleA)
  const m3: Envelope = { kind: 'text', id: 'AAAA0000-0000-4000-8000-000000000003', text: 'msg3 from a new contact' }
  const got3 = await A2.decrypt(await C.encryptTo(A.uin, A.deviceId, A.outerPub, m3))
  check('A2 decrypted msg3 → identity + prekeys SURVIVED the reload', (got3.envelope as any).text === m3.text)

  await idbDel('persist-test')
  doneEl.className = fails === 0 ? 'pass' : 'fail'
  doneEl.textContent = fails === 0 ? 'DEVICE PERSISTENCE WORKS — survives reload ✅' : `${fails} CHECK(S) FAILED ❌`
  console.log(fails === 0 ? 'PERSISTDEMO_OK' : 'PERSISTDEMO_FAIL')
}

main().catch((e) => { doneEl.className = 'fail'; doneEl.textContent = 'THREW: ' + (e?.message ?? String(e)); console.error('PERSISTDEMO_THREW', e) })
