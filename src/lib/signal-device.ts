// App-level libsignal device service. Lazily turns the current web account
// into a real libsignal device (PRIMARY, deviceId 1 — a "Create account" web
// session is its own device, so it publishes its bundle via POST /keys/bundle
// and a sender reaches it through the existing GET /keys/{uin}/bundle path; no
// multi-device registry needed for a standalone web account).
//
// Exposes:
//   - getDevice(identity): provision-once + cache the WebSignalDevice
//   - decryptIncoming(identity, payload): decode an inbound sealed envelope
//     (v=2 via libsignal-WASM, v=1 via the legacy ECIES path). Sender UIN is
//     read from the envelope itself (sealed sender).
//   - sendV2(identity, peer, env): fan-out send to all of a peer's devices.
//
// ⚠ In-memory for now: the libsignal stores live only for this page load, so a
// reload re-provisions (new keys). Durable IndexedDB persistence of the device
// + sessions is the next step (the chosen WASM wrapper needs app-side key
// tracking or a wrapper-level whole-store serialize — see the plan).

import { WebSignalDevice, type SignalBundle, type DeviceBlob } from './crypto-v2'
import { decryptV1, b64ToBytes, type Envelope, type WebIdentity } from './crypto'
import { idbGet, idbSet } from './signal-persist'

const _devices = new Map<number, Promise<WebSignalDevice>>()
const blobKey = (uin: number) => `signal-device:${uin}`

async function provision(identity: WebIdentity): Promise<WebSignalDevice> {
  // Restore the SAME device across reloads (stable identity → peers' sessions
  // stay valid + prior conversations decrypt). Only publish a bundle on first
  // provision.
  const saved = await idbGet<DeviceBlob>(blobKey(identity.uin))
  if (saved) return WebSignalDevice.restore(saved)

  // First time: the web account IS its own primary device; its outer
  // (sealed-sender) key is the account X25519 identity key it already holds.
  const dev = await WebSignalDevice.create(identity.uin, 1, identity.identityPriv)
  const bundle = await dev.buildBundle(20)
  const res = await fetch(`${identity.apiBase}/keys/bundle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.jwt}` },
    body: JSON.stringify(bundle),
  })
  if (!res.ok) throw new Error(`keys/bundle upload failed: ${res.status}`)
  await idbSet(blobKey(identity.uin), await dev.serialize())
  return dev
}

/// Provision-once (per page load) and return this account's libsignal device.
export function getDevice(identity: WebIdentity): Promise<WebSignalDevice> {
  let p = _devices.get(identity.uin)
  if (!p) {
    p = provision(identity)
    _devices.set(identity.uin, p)
  }
  return p
}

/// Persist the device's current state (sessions advance on every encrypt/
/// decrypt, so call after each). Best-effort.
async function persist(identity: WebIdentity, dev: WebSignalDevice): Promise<void> {
  try {
    await idbSet(blobKey(identity.uin), await dev.serialize())
  } catch {
    /* IDB write failed — non-fatal */
  }
}

function wireVersion(payloadB64: string): number {
  try {
    return JSON.parse(new TextDecoder().decode(b64ToBytes(payloadB64))).v ?? 0
  } catch {
    return 0
  }
}

/// Decode an inbound sealed envelope. Returns null for envelopes this device
/// can't read (e.g. a ciphertext fanned out to a DIFFERENT device) so callers
/// can silently skip them.
export async function decryptIncoming(
  identity: WebIdentity,
  payloadB64: string,
): Promise<{ senderUIN: number; senderHost?: string; senderSigningKey?: string; envelope: Envelope } | null> {
  try {
    const v = wireVersion(payloadB64)
    if (v === 2) {
      const dev = await getDevice(identity)
      const out = await dev.decrypt(payloadB64) // sender UIN read from the envelope
      await persist(identity, dev) // ratchet advanced — snapshot
      return out // v=2 is same-island only; no senderHost
    }
    if (v === 1) {
      return decryptV1(payloadB64, identity) // carries senderHost when cross-island
    }
    return null
  } catch {
    return null
  }
}

// Per-peer device targets, established once (this page load) then reused. The
// libsignal session lives in the device's store after the first establish, so
// subsequent sends just encrypt — no /devices fetch, no bundle fetch (which
// also consumed a one-time prekey every time), no re-handshake. THIS is what
// makes a conversation feel instant after the first message.
const _peerTargets = new Map<number, Array<{ deviceId: number; outerPub: Uint8Array }>>()

/// Send an envelope to a peer over v=2, fanning out one ciphertext per device.
/// Returns the number of devices reached.
export async function sendV2(identity: WebIdentity, peerUin: number, env: Envelope): Promise<number> {
  const dev = await getDevice(identity)

  let targets = _peerTargets.get(peerUin)
  if (!targets) {
    // First send to this peer this session: fetch its devices, establish a
    // session per device (X3DH), and cache the address + outer key.
    targets = []
    const list = await apiGet(identity, `/keys/${peerUin}/devices`)
    for (const d of (list.devices as Array<{ device_id: number }>)) {
      const bundle = (await apiGet(identity, `/keys/${peerUin}/devices/${d.device_id}/bundle`)) as SignalBundle
      await dev.establishSession(bundle)
      targets.push({ deviceId: bundle.device_id, outerPub: b64ToBytes(bundle.sealed_sender_pub) })
    }
    if (targets.length) _peerTargets.set(peerUin, targets)
  }

  let sent = 0
  for (const tgt of targets) {
    const payload = await dev.encryptTo(peerUin, tgt.deviceId, tgt.outerPub, env)
    const res = await fetch(`${identity.apiBase}/messages/sealed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_uin: peerUin, envelope_type: 'message', payload }),
    })
    if (res.ok) sent++
  }
  if (sent > 0) await persist(identity, dev) // ratchet advanced — snapshot
  return sent
}

async function apiGet(identity: WebIdentity, path: string): Promise<any> {
  const res = await fetch(`${identity.apiBase}${path}`, { headers: { Authorization: `Bearer ${identity.jwt}` } })
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return res.json()
}
