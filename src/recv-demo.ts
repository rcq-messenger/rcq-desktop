// Verifies the REAL app receive service (src/lib/signal-device.ts +
// incoming-store) against the live local backend (:8000): account A provisions
// itself as a primary libsignal device, B sends it a v=2 message via the
// service's fan-out, and A's MessageReceiver-style drain decrypts it through
// decryptIncoming — sender UIN derived from the sealed envelope, exactly as the
// app does. Served by Vite at /recv-demo.html.

import { x25519, ed25519 } from '@noble/curves/ed25519'
import { getDevice, decryptIncoming, sendV2 } from './lib/signal-device'
import { addIncoming } from './lib/incoming-store'
import { bytesToB64, type Envelope, type WebIdentity } from './lib/crypto'

const API = 'http://127.0.0.1:8000'
const inbox = document.getElementById('inbox')!
const logEl = document.getElementById('log')!
const doneEl = document.getElementById('done')!
let fails = 0
const step = (m: string) => { const d = document.createElement('div'); d.className = 'step'; d.textContent = '› ' + m; logEl.appendChild(d) }
const check = (n: string, c: boolean) => { const d = document.createElement('div'); d.className = c ? 'pass' : 'fail'; d.textContent = `${c ? 'PASS' : 'FAIL'}  ${n}`; logEl.appendChild(d); if (!c) fails++ }

async function register(nickname: string): Promise<WebIdentity> {
  const identityPriv = x25519.utils.randomPrivateKey()
  const signingPriv = ed25519.utils.randomPrivateKey()
  const res = await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, identity_key: bytesToB64(x25519.getPublicKey(identityPriv)), signing_key: bytesToB64(ed25519.getPublicKey(signingPriv)) }),
  })
  const out = await res.json()
  return { uin: out.uin, jwt: out.token, apiBase: API, identityPriv, identityPub: x25519.getPublicKey(identityPriv), signingPriv, signingPub: ed25519.getPublicKey(signingPriv) }
}

async function main() {
  step('register A + B; provision both as libsignal devices (real signal-device.getDevice)')
  const A = await register('Acc-A')
  const B = await register('Acc-B')
  await getDevice(A) // publishes A's primary bundle via POST /keys/bundle
  await getDevice(B)
  check('A + B provisioned (bundles published)', A.uin !== B.uin)

  step('B sends A a v=2 message via signal-device.sendV2 (fan-out over A’s devices)')
  const msg: Envelope = { kind: 'text', id: 'E1E1E1E1-0000-4000-8000-000000000001', text: 'Принято настоящим сервисом приложения 🔒' }
  const n = await sendV2(B, A.uin, msg)
  check('B reached exactly 1 device of A (its primary)', n === 1)

  step('A drains GET /messages/queue + decryptIncoming (sender UIN read from envelope)')
  const rows = await (await fetch(`${API}/messages/queue`, { headers: { Authorization: `Bearer ${A.jwt}` } })).json() as Array<{ payload: string }>
  for (const r of rows) {
    const got = await decryptIncoming(A, r.payload)
    if (got) {
      addIncoming(got.senderUIN, got.envelope) // same call the app's MessageReceiver makes
      const b = document.createElement('div'); b.className = 'bubble'
      b.innerHTML = `<div class="meta">from ${got.senderUIN}</div>${(got.envelope as any).text}`
      inbox.appendChild(b)
    }
  }
  check('A decrypted B’s message; sender UIN matches B', rows.length === 1)

  doneEl.className = fails === 0 ? 'pass' : 'fail'
  doneEl.textContent = fails === 0 ? 'APP RECEIVE SERVICE WORKS ✅' : `${fails} CHECK(S) FAILED ❌`
  console.log(fails === 0 ? 'RECVDEMO_OK' : 'RECVDEMO_FAIL')
}

main().catch((e) => { doneEl.className = 'fail'; doneEl.textContent = 'THREW: ' + (e?.message ?? String(e)); console.error('RECVDEMO_THREW', e) })
