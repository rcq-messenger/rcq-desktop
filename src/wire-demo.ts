// END-TO-END over the REAL local backend (:8000): two accounts, a provisioned
// web device, fan-out send, and queue-based receive + decrypt — all from the
// browser using web-chat's actual crypto-v2 modules. Proves the web chat
// receives v=2 messages over the wire (not just client-local).
//
// Served by Vite at /wire-demo.html. Backend must be running on :8000.

import { x25519, ed25519 } from '@noble/curves/ed25519'
import { WebSignalDevice, type SignalBundle } from './lib/crypto-v2'
import { bytesToB64, b64ToBytes, type Envelope } from './lib/crypto'

const API = 'http://127.0.0.1:8000'
const logEl = document.getElementById('log')!
const aliceBox = document.getElementById('alice')!
const bobBox = document.getElementById('bob')!
const doneEl = document.getElementById('done')!

let fails = 0
function step(msg: string) { const d = document.createElement('div'); d.className = 'step'; d.textContent = '› ' + msg; logEl.appendChild(d); console.log('[wire]', msg) }
function check(name: string, cond: boolean) { const d = document.createElement('div'); d.className = cond ? 'pass' : 'fail'; d.textContent = `${cond ? 'PASS' : 'FAIL'}  ${name}`; logEl.appendChild(d); if (!cond) fails++ }
function bubble(box: HTMLElement, who: string, text: string, incoming: boolean) {
  const b = document.createElement('div'); b.className = 'bubble' + (incoming ? ' in' : '')
  b.innerHTML = `<div class="meta">${who}</div>${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))}`
  box.appendChild(b)
}

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<any> {
  const headers: Record<string, string> = {}
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(API + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined })
  const txt = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${txt}`)
  return txt ? JSON.parse(txt) : null
}

async function registerAccount(nickname: string): Promise<{ uin: number; token: string; xPriv: Uint8Array }> {
  const xPriv = x25519.utils.randomPrivateKey()
  const edPriv = ed25519.utils.randomPrivateKey()
  const out = await api('POST', '/auth/register', {
    body: { nickname, identity_key: bytesToB64(x25519.getPublicKey(xPriv)), signing_key: bytesToB64(ed25519.getPublicKey(edPriv)) },
  })
  return { uin: out.uin, token: out.token, xPriv }
}

async function fanOutSend(sender: WebSignalDevice, senderToken: string, toUin: number, env: Envelope): Promise<number> {
  const list = await api('GET', `/keys/${toUin}/devices`, { token: senderToken })
  let sent = 0
  for (const d of list.devices as Array<{ device_id: number }>) {
    const bundle = (await api('GET', `/keys/${toUin}/devices/${d.device_id}/bundle`, { token: senderToken })) as SignalBundle
    await sender.establishSession(bundle)
    const payload = await sender.encryptTo(toUin, bundle.device_id, b64ToBytes(bundle.sealed_sender_pub), env)
    await api('POST', '/messages/sealed', { body: { to_uin: toUin, envelope_type: 'message', payload } }) // sealed sender: no auth
    sent++
  }
  return sent
}

async function drainAndDecrypt(me: WebSignalDevice, myToken: string, senderUin: number, senderDeviceId: number): Promise<Envelope[]> {
  const rows = (await api('GET', '/messages/queue', { token: myToken })) as Array<{ payload: string }>
  const out: Envelope[] = []
  for (const r of rows) {
    try { out.push((await me.decrypt(r.payload, senderUin, senderDeviceId)).envelope) }
    catch (e) { console.warn('skip undecryptable', e) } // a device ignores ciphertext for other devices
  }
  return out
}

async function main() {
  step('registering Alice + Bob on the backend')
  const A = await registerAccount('Alice-web')
  const B = await registerAccount('Bob-web')
  check('two accounts registered (got UINs + tokens)', !!A.uin && !!B.uin && A.uin !== B.uin)

  // Alice = device-1 sender; her outer key IS her account identity key.
  const alice = await WebSignalDevice.create(A.uin, 1, A.xPriv)
  // Alice publishes her primary libsignal bundle so Bob can reply.
  await api('POST', '/keys/bundle', { token: A.token, body: await alice.buildBundle(10) })
  step(`Alice is device 1 (uin ${A.uin}), primary bundle published`)

  // Bob's WEB device: generates its OWN identity + outer key, registers as a secondary device.
  const bob = await WebSignalDevice.create(B.uin, 1)
  const bobUpload = await bob.buildBundle(10)
  const reg = await api('POST', '/keys/devices', { token: B.token, body: { ...bobUpload, sealed_sender_pub: bytesToB64(bob.outerPub), label: 'Web (demo)' } })
  bob.setDeviceId(reg.device_id)
  check(`Bob's web registered as a secondary device (id ${reg.device_id} >= 2)`, reg.device_id >= 2)

  // Alice -> Bob, over the wire.
  step('Alice fans out to Bob’s devices + POST /messages/sealed')
  const m1: Envelope = { kind: 'text', id: 'D1D1D1D1-0000-4000-8000-000000000001', text: 'Привет Боб! это пришло ПО ПРОВОДУ через локальный бэкенд 🔒' }
  const nSent = await fanOutSend(alice, A.token, B.uin, m1)
  bubble(aliceBox, `sent → ${B.uin}`, m1.text, false)
  check('Alice sent one ciphertext per Bob device', nSent === 1)

  step('Bob drains GET /messages/queue + decrypts')
  const bobGot = await drainAndDecrypt(bob, B.token, A.uin, alice.deviceId)
  if (bobGot[0]) bubble(bobBox, `from ${A.uin}`, (bobGot[0] as any).text, true)
  check('Bob received Alice’s message over the wire + decrypted it', bobGot.length === 1 && (bobGot[0] as any).text === m1.text)

  // Bob -> Alice reply, over the wire.
  step('Bob replies; Alice drains + decrypts')
  const m2: Envelope = { kind: 'text', id: 'D2D2D2D2-0000-4000-8000-000000000002', text: 'Дошло! отвечаю с веб-устройства 🔁' }
  await fanOutSend(bob, B.token, A.uin, m2)
  bubble(bobBox, `sent → ${A.uin}`, m2.text, false)
  const aliceGot = await drainAndDecrypt(alice, A.token, B.uin, bob.deviceId)
  if (aliceGot[0]) bubble(aliceBox, `from ${B.uin}`, (aliceGot[0] as any).text, true)
  check('Alice received Bob’s reply over the wire + decrypted it', aliceGot.length === 1 && (aliceGot[0] as any).text === m2.text)

  doneEl.className = fails === 0 ? 'pass' : 'fail'
  doneEl.textContent = fails === 0 ? 'WEB-CHAT RECEIVES v=2 OVER THE WIRE ✅' : `${fails} CHECK(S) FAILED ❌`
  console.log(fails === 0 ? 'WIREDEMO_OK' : 'WIREDEMO_FAIL')
}

main().catch((e) => { doneEl.className = 'fail'; doneEl.textContent = 'THREW: ' + (e?.message ?? String(e)); console.error('WIREDEMO_THREW', e) })
