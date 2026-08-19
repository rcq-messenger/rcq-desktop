// App-level libsignal device service. Lazily turns the current web session into
// a real libsignal device of the account.
//
// ⚠ A Double Ratchet session belongs to ONE PAIR of devices, and an account has
// exactly one PRIMARY slot (POST /keys/bundle, deviceId 1). An install that
// claims that slot while another install already holds it does not share it —
// it EVICTS the other one: peers rebuild their session against whichever bundle
// was published last, and everything the other install sends from then on is
// undecryptable and dropped in silence. So this install asks who owns the slot
// (GET /keys/me/status) before claiming anything, and registers as a SECONDARY
// device (POST /keys/devices, id assigned by the island) when the owner is
// somebody else. The id is persisted next to the libsignal store: it is half of
// the address peers encrypt to, and re-registering mints a new slot every time.
//
// Exposes:
//   - getDevice(identity): provision-once + cache the WebSignalDevice
//   - myDeviceId / currentDeviceId: this install's libsignal device id
//   - decryptIncoming(identity, payload): decode an inbound sealed envelope
//     (v=2 via libsignal-WASM, v=1 via the legacy ECIES path). Sender UIN is
//     read from the envelope itself (sealed sender).
//   - sendV2(identity, peer, env): fan-out send to all of a peer's devices.

import { PRIMARY_DEVICE_ID, WebSignalDevice, type SignalBundle, type DeviceBlob } from './crypto-v2'
import { decryptV1, b64ToBytes, bytesToB64, type Envelope, type WebIdentity } from './crypto'
import { idbGet, idbSet } from './signal-persist'
import { clientLabel } from './client-name'

const _devices = new Map<number, Promise<WebSignalDevice>>()
const blobKey = (uin: number) => `signal-device:${uin}`

/// How many one-time prekeys a published bundle carries.
const OPK_POOL = 20

/// The owner-facing view of the account's key state (GET /keys/me/status).
interface KeysStatus {
  has_bundle: boolean
  /// Identity key of whoever currently holds the PRIMARY slot; null/absent
  /// while no device has published a bundle.
  signal_identity_key?: string | null
}

// A provisioning request that black-holes (a middlebox that eats the response)
// must not pin the caller: the queue drain waits for this device's id before it
// can ask for the rows addressed to it. Plain AbortController — AbortSignal
// .timeout is still missing from older webviews this page runs in.
function fetchWithTimeout(url: string, init: RequestInit, ms = 15_000): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer))
}

/// Ask the island who owns the primary slot. Null when it cannot answer — a
/// guess here is a device id, and the wrong one either evicts another install
/// or leaves this one unreachable.
async function keysStatus(identity: WebIdentity): Promise<KeysStatus | null> {
  try {
    const res = await fetchWithTimeout(`${identity.apiBase}/keys/me/status`, {
      headers: { Authorization: `Bearer ${identity.jwt}` },
    })
    if (!res.ok) return null
    return (await res.json()) as KeysStatus
  } catch {
    return null
  }
}

/// Claim the account's primary slot for [dev] (deviceId 1).
async function publishPrimary(identity: WebIdentity, dev: WebSignalDevice): Promise<void> {
  const bundle = await dev.buildBundle(OPK_POOL)
  const res = await fetchWithTimeout(`${identity.apiBase}/keys/bundle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.jwt}` },
    body: JSON.stringify(bundle),
  })
  if (!res.ok) throw new Error(`keys/bundle upload failed: ${res.status}`)
}

/// Register [dev] as a SECONDARY device and adopt the id the island assigns.
/// Unlike the primary slot this is not idempotent — every call mints another
/// device — so it runs once and the id is persisted with the store.
async function registerSecondary(identity: WebIdentity, dev: WebSignalDevice): Promise<void> {
  const bundle = await dev.buildBundle(OPK_POOL)
  const res = await fetchWithTimeout(`${identity.apiBase}/keys/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.jwt}` },
    body: JSON.stringify({ ...bundle, label: await clientLabel(), sealed_sender_pub: bytesToB64(dev.outerPub) }),
  })
  if (!res.ok) throw new Error(`keys/devices register failed: ${res.status}`)
  const { device_id: assigned } = (await res.json()) as { device_id: number }
  if (!Number.isInteger(assigned) || assigned <= PRIMARY_DEVICE_ID) {
    throw new Error(`keys/devices returned device_id ${assigned}`)
  }
  dev.setDeviceId(assigned)
}

async function provision(identity: WebIdentity): Promise<WebSignalDevice> {
  // Restore the SAME device across reloads (stable identity → peers' sessions
  // stay valid + prior conversations decrypt).
  const saved = await idbGet<DeviceBlob>(blobKey(identity.uin))
  // An island-assigned id is final: asking again would register a second
  // device on every reload and leave the previous ones addressed by peers who
  // cached them.
  if (saved && saved.deviceId > PRIMARY_DEVICE_ID) return WebSignalDevice.restore(saved)

  const status = await keysStatus(identity)
  if (!status) {
    if (saved) return WebSignalDevice.restore(saved)
    throw new Error('keys/me/status unavailable')
  }

  if (!status.has_bundle) {
    // Nobody holds the slot: this install is the account's first device, and
    // its outer (sealed-sender) key is the account X25519 identity key it
    // already holds.
    const dev = saved
      ? await WebSignalDevice.restore(saved)
      : await WebSignalDevice.create(identity.uin, PRIMARY_DEVICE_ID, identity.identityPriv)
    await publishPrimary(identity, dev)
    await idbSet(blobKey(identity.uin), await dev.serialize())
    return dev
  }

  if (saved) {
    const dev = await WebSignalDevice.restore(saved)
    // The slot still carries OUR identity key, so it is still ours.
    if (status.signal_identity_key === dev.signalIdentityKeyB64()) return dev
    // It carries somebody else's. The sessions this install built while it was
    // device 1 are dead either way — peers hold them under an address that is
    // now the other install's — so it starts over as a secondary device.
  }

  const dev = await WebSignalDevice.create(identity.uin)
  await registerSecondary(identity, dev)
  await idbSet(blobKey(identity.uin), await dev.serialize())
  return dev
}

/// This install's libsignal device id, for callers that cannot await (the live
/// socket). 1 until provisioning has resolved, which is also what an
/// unprovisioned install is addressed as.
let _myDeviceId = PRIMARY_DEVICE_ID

/// Provision-once (per page load) and return this account's libsignal device.
export function getDevice(identity: WebIdentity): Promise<WebSignalDevice> {
  let p = _devices.get(identity.uin)
  if (!p) {
    p = provision(identity).then(
      (dev) => {
        _myDeviceId = dev.deviceId
        return dev
      },
      (e) => {
        // Provisioning needs the island to answer, so it can fail on a hiccup.
        // A cached rejection would disable v=2 for the rest of the page load.
        _devices.delete(identity.uin)
        throw e
      },
    )
    _devices.set(identity.uin, p)
  }
  return p
}

/// This install's libsignal device id: the `dev` its outbound envelopes state,
/// and the addressee of the queue rows that are its own. Falls back to the
/// primary id, which is what a row with no addressee is meant for anyway.
export async function myDeviceId(identity: WebIdentity): Promise<number> {
  try {
    return (await getDevice(identity)).deviceId
  } catch {
    return PRIMARY_DEVICE_ID
  }
}

/// Same, without awaiting provisioning.
export function currentDeviceId(): number {
  return _myDeviceId
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

// Per-peer device targets, established once then reused. The libsignal session
// lives in the device's store after the first establish, so subsequent sends
// just encrypt — no bundle fetch (which also consumed a one-time prekey every
// time), no re-handshake. THIS is what makes a conversation feel instant after
// the first message.
interface PeerTarget {
  deviceId: number
  outerPub: Uint8Array
}
interface PeerTargets {
  /// When the device LIST was last read.
  at: number
  devices: PeerTarget[]
}
const _peerTargets = new Map<number, PeerTargets>()

/// How long a peer's device list is trusted. A device the peer adds later has
/// to become reachable without a reload, and a revoked one has to stop being
/// addressed. Only the list is re-read — a target we already hold keeps its
/// session, because re-running X3DH against it would burn one of the peer's
/// one-time prekeys and restart the ratchet for nothing.
const TARGETS_TTL_MS = 5 * 60_000

async function resolveTargets(
  identity: WebIdentity,
  dev: WebSignalDevice,
  peerUin: number,
  known: PeerTarget[],
): Promise<PeerTargets> {
  const byId = new Map(known.map((t) => [t.deviceId, t]))
  const list = (await apiGet(identity, `/keys/${peerUin}/devices`)) as { devices?: Array<{ device_id: number }> }
  const devices: PeerTarget[] = []
  for (const d of list.devices ?? []) {
    const cached = byId.get(d.device_id)
    if (cached) {
      devices.push(cached)
      continue
    }
    const bundle = (await apiGet(identity, `/keys/${peerUin}/devices/${d.device_id}/bundle`)) as SignalBundle
    await dev.establishSession(bundle)
    devices.push({ deviceId: bundle.device_id, outerPub: b64ToBytes(bundle.sealed_sender_pub) })
  }
  return { at: Date.now(), devices }
}

/// Send an envelope to a peer over v=2, fanning out one ciphertext per device.
/// Returns the number of devices reached — 0 when the peer has no libsignal
/// bundle at all, which is the caller's signal to fall back to v=1.
export async function sendV2(identity: WebIdentity, peerUin: number, env: Envelope, envelopeType = 'message'): Promise<number> {
  const dev = await getDevice(identity)

  let targets = _peerTargets.get(peerUin)
  if (!targets || Date.now() - targets.at > TARGETS_TTL_MS) {
    try {
      targets = await resolveTargets(identity, dev, peerUin, targets?.devices ?? [])
    } catch (e) {
      // A refresh that fails leaves the devices we already reached in place —
      // they were reachable a minute ago. With nothing cached there is no send
      // to make, and the caller falls back to v=1.
      if (!targets) throw e
    }
    // An empty list is never cached: the peer may publish a bundle at any time,
    // and until they do, every send has to ask again.
    if (targets.devices.length) _peerTargets.set(peerUin, targets)
    else _peerTargets.delete(peerUin)
  }

  let sent = 0
  let stale = false
  for (const tgt of targets.devices) {
    const payload = await dev.encryptTo(peerUin, tgt.deviceId, tgt.outerPub, env)
    const res = await fetch(`${identity.apiBase}/messages/sealed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Which device this ciphertext is FOR: only that one holds the other half
      // of the ratchet, so the island hands the row to it alone. Omitted by
      // pre-fan-out senders, and then every device drains it.
      body: JSON.stringify({ to_uin: peerUin, envelope_type: envelopeType, payload, to_device_id: tgt.deviceId }),
    })
    if (res.ok) sent++
    else if (res.status === 404) stale = true
  }
  // A copy the island refuses to take means the targets we hold no longer
  // describe the peer (a device revoked under us, the account gone). Drop the
  // whole list so the next send resolves it again.
  if (stale) _peerTargets.delete(peerUin)
  if (sent > 0) await persist(identity, dev) // ratchet advanced — snapshot
  return sent
}

async function apiGet(identity: WebIdentity, path: string): Promise<any> {
  const res = await fetch(`${identity.apiBase}${path}`, { headers: { Authorization: `Bearer ${identity.jwt}` } })
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return res.json()
}
