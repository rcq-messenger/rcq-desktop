// App-level libsignal device service. Lazily turns the current web session into
// a real libsignal device of the account.
//
// ⚠ A Double Ratchet session belongs to ONE PAIR of devices, and an account has
// exactly one PRIMARY slot (POST /keys/bundle, deviceId 1). An install that
// claims that slot while another install already holds it does not share it —
// it EVICTS the other one: peers rebuild their session against whichever bundle
// was published last, and everything the other install sends from then on is
// undecryptable and dropped in silence. So an install that HAS a libsignal
// identity asks who owns the slot (GET /keys/me/status) before claiming
// anything, and registers as a SECONDARY device (POST /keys/devices, id
// assigned by the island) when the owner is somebody else. The id is persisted
// next to the libsignal store: it is half of the address peers encrypt to, and
// re-registering mints a new slot every time.
//
// ⚠ An install with NO libsignal identity of its own — a first run, a cleared
// browser, a restore on another machine — TAKES the slot instead, whoever holds
// it. It has no sessions to preserve and nothing to lose by taking it, and the
// install it displaces is a live one that notices: on its next provision the
// published key is no longer its own, and it re-registers as a secondary. The
// rule the other way round leaves a DEAD identity in the slot — the one this
// install just threw away — with every sender on an older build addressing it
// forever, and nobody left to notice. Healing towards the device somebody is
// holding right now is the direction that keeps them reachable.
//
// Exposes:
//   - getDevice(identity): provision-once + cache the WebSignalDevice
//   - myDeviceId / currentDeviceId: this install's libsignal device id
//   - decryptIncoming(identity, payload): decode an inbound sealed envelope
//     (v=2 via libsignal-WASM, v=1 via the legacy ECIES path). Sender UIN is
//     read from the envelope itself (sealed sender).
//   - sendV2(identity, peer, env): fan-out send to all of a peer's devices.

import { PRIMARY_DEVICE_ID, WebSignalDevice, type SignalBundle, type DeviceBlob } from './crypto-v2'
import { decryptV1, b64ToBytes, bytesToB64, messageClass, type Envelope, type WebIdentity } from './crypto'
import { idbDel, idbGet, idbGetFlat, idbSet } from './signal-persist'
import { clientLabel } from './client-name'
import { fetchServerInfo } from './server-info'
import * as depositAuth from './deposit-auth-store'

const _devices = new Map<number, Promise<WebSignalDevice>>()
const blobKey = (uin: number) => `signal-device:${uin}`
/// One-shot marker for [splitToOwnSlot]: survives the reload that carries the
/// migration, cleared only once the secondary registration lands.
const splitKey = (uin: number) => `rcq.web.signal-split.${uin}`
/// A device whose registration POST is in flight, or whose response never came
/// back. See registerSecondary.
const claimKey = (uin: number) => `signal-device-claim:${uin}`
/// The device this install answered to before it became a secondary. Kept, not
/// written over: see becomeSecondary.
const prevKey = (uin: number) => `signal-device-prev:${uin}`

/// How many one-time prekeys a published bundle carries.
const OPK_POOL = 20

/// How many of the account's device rows a registration whose response was lost
/// probes before giving up. The scan holds the cross-tab provisioning lock and
/// pays a bundle fetch per row, so it is bounded — the row this install just
/// minted is the newest one, and a handful of siblings past it is already more
/// than the search is worth.
const ADOPT_PROBE_LIMIT = 6

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

/// Claim the account's primary slot (deviceId 1) for this install, reusing the
/// device already on disk when there is one.
async function claimPrimary(identity: WebIdentity, saved?: DeviceBlob): Promise<WebSignalDevice> {
  const dev = saved
    ? await WebSignalDevice.restore(saved)
    : await WebSignalDevice.create(identity.uin, PRIMARY_DEVICE_ID, identity.identityPriv)
  const bundle = await dev.buildBundle(OPK_POOL)
  // ⚠ For a fresh mint, persist BEFORE the POST. A claim whose response is
  // lost (timeout after the island applied it) used to leave the slot holding
  // keys that existed nowhere on disk — and the next boot minted another set
  // over it, killing every session peers had built in between. With the blob
  // written first, that boot finds its own key in the slot and carries on; if
  // the island never applied the claim, the republish path retries with the
  // SAME keys. Only an explicit refusal below deletes the write-ahead.
  if (!saved) await idbSet(blobKey(identity.uin), await dev.serialize())
  let res: Response
  try {
    res = await fetchWithTimeout(`${identity.apiBase}/keys/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.jwt}` },
      body: JSON.stringify(bundle),
    })
  } catch (e) {
    // Ambiguous outcome — keep the write-ahead so a claim that DID land is
    // still openable next boot.
    throw e
  }
  if (!res.ok) {
    if (!saved) {
      // The island explicitly refused, so nothing of these keys exists there.
      await idbDel(blobKey(identity.uin)).catch(() => {})
      throw new Error(`keys/bundle upload failed: ${res.status}`)
    }
    // ⚠ A fresh restore, not `dev`: a blob written before the published bundle
    // was remembered has none to republish, so buildBundle minted new keys over
    // it in memory — and the ones the queued backlog was encrypted against are
    // the ones still on disk. The upload is retried on the next provision.
    return WebSignalDevice.restore(saved)
  }
  // Refresh the stored blob with the memoized bundle. Best-effort here: the
  // fresh path already wrote ahead, and a republish path has a valid blob on
  // disk — a failed rewrite must not fail the claim that already landed.
  await idbSet(blobKey(identity.uin), await dev.serialize()).catch((e) => {
    console.warn('device blob rewrite after claim failed:', e)
  })
  return dev
}

/// Register [dev] as a SECONDARY device and adopt the id the island assigns.
/// Unlike the primary slot this is not idempotent — every call mints another
/// device — so it runs once and the id is persisted with the store.
async function registerSecondary(identity: WebIdentity, dev: WebSignalDevice): Promise<void> {
  const bundle = await dev.buildBundle(OPK_POOL)
  // ⚠ Written BEFORE the POST. A response lost on the way back still leaves a
  // device row minted on the island, and these keys are the only thing that can
  // recognise it as ours (adoptRegisteredDevice). Without them the next
  // provision has no choice but to mint another row, and the one the peers may
  // already be addressing belongs to nobody.
  await idbSet(claimKey(identity.uin), await dev.serialize())
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

/// Find the device row the island already minted for [dev] — the one publishing
/// this device's identity key — and adopt its id. False when there is none, so
/// the registration never landed. Throws when the island cannot answer: "no row
/// of mine" and "cannot tell" differ by a duplicate device.
///
/// Runs only after a registration whose response was lost, which is why it can
/// afford a bundle fetch per device (each consumes one of that device's OPKs).
async function adoptRegisteredDevice(identity: WebIdentity, dev: WebSignalDevice): Promise<boolean> {
  const mine = dev.signalIdentityKeyB64()
  const list = (await apiGet(identity, `/keys/${identity.uin}/devices`)) as { devices?: Array<{ device_id: number }> }
  // Newest first: the island hands out rising ids, so the row this install was
  // minted is the last one — and every sibling probed on the way to it pays an
  // OPK for the privilege, with the provisioning lock held.
  const rows = (list.devices ?? [])
    .filter((d) => d.device_id > PRIMARY_DEVICE_ID)
    .sort((a, b) => b.device_id - a.device_id)
    .slice(0, ADOPT_PROBE_LIMIT)
  for (const d of rows) {
    const bundle = await fetchKeyBundle(identity, `/keys/${identity.uin}/devices/${d.device_id}/bundle`)
    if (bundle.signal_identity_key === mine) {
      dev.setDeviceId(d.device_id)
      return true
    }
  }
  return false
}

/// Become a device of this account in our own right, alongside whoever holds
/// the primary slot. [prev] is the device this install used until now, if any.
async function becomeSecondary(identity: WebIdentity, prev?: DeviceBlob): Promise<WebSignalDevice> {
  const claimed = await idbGet<DeviceBlob>(claimKey(identity.uin))
  const dev = claimed ? await WebSignalDevice.restore(claimed) : await WebSignalDevice.create(identity.uin)
  if (!claimed || !(await adoptRegisteredDevice(identity, dev))) {
    await registerSecondary(identity, dev)
  }
  // ⚠ Kept beside the new device, not written over. The queue still holds rows
  // addressed to the identity this install published as device 1, and every
  // peer that cached that bundle is still encrypting to it — those open with
  // the old keys or with nothing at all. decryptIncoming falls back to them.
  if (prev) {
    await idbSet(prevKey(identity.uin), prev)
    _prevDevices.delete(identity.uin)
  }
  await idbSet(blobKey(identity.uin), await dev.serialize())
  await idbDel(claimKey(identity.uin))
  return dev
}

/// Copy this account's device state (blob, unfinished claim, previous device)
/// out of the FLAT database into the scoped one, and return the blob if one was
/// found. Never overwrites a scoped record — the scoped copy is newer by
/// construction (the flat one could only have been written by an earlier,
/// unscoped page life). Best-effort: a failure to read flat is a plain miss.
async function adoptFlatDeviceState(uin: number): Promise<DeviceBlob | undefined> {
  try {
    const [blob, claim, prev] = await Promise.all([
      idbGetFlat<DeviceBlob>(blobKey(uin)),
      idbGetFlat<DeviceBlob>(claimKey(uin)),
      idbGetFlat<DeviceBlob>(prevKey(uin)),
    ])
    if (!blob && !claim && !prev) return undefined
    if (blob && !(await idbGet(blobKey(uin)))) await idbSet(blobKey(uin), blob)
    if (claim && !(await idbGet(claimKey(uin)))) await idbSet(claimKey(uin), claim)
    if (prev && !(await idbGet(prevKey(uin)))) await idbSet(prevKey(uin), prev)
    console.warn(`adopted device state for ${uin} from the flat database`)
    return blob
  } catch {
    return undefined
  }
}

/// What a fresh install does about the account's primary slot. 'auto' is the
/// web rule (take it — see the ★ comment in provision below). 'secondary'
/// forbids the claim outright: the console client runs headless on machines
/// nobody is watching, and a CLI that stole the slot would put every peer's
/// session onto keys the phone no longer answers for — the 2026-08-20 live
/// test showed what a surprise re-claim does to peers' sessions
/// (docs/console-client-design.md). Default 'auto' keeps web behaviour
/// byte-identical.
/// Пункт 13: a legacy session sharing the phone's slot 1 splits into a slot
/// of its own. One-shot and reload-carried: the flag survives the reload,
/// provision() sees it first and registers this install as a SECONDARY with
/// fresh keys (the shared blob is kept as the previous-device fallback, so
/// in-flight rows to the old identity still open). Peers pick the new slot
/// up on their next roster fetch; the phone keeps slot 1 to itself.
export function splitToOwnSlot(identity: WebIdentity): void {
  localStorage.setItem(splitKey(identity.uin), '1')
  location.reload()
}

export type ProvisionPolicy = 'auto' | 'secondary'
let _provisionPolicy: ProvisionPolicy = 'auto'
export function setProvisionPolicy(p: ProvisionPolicy): void {
  _provisionPolicy = p
}

// ⚠ Nothing the island says — or fails to say — is worth a device over. What
// this install already holds is what opens the backlog addressed to it, and a
// drain that runs without it acks that backlog away as undecryptable. So every
// failure below falls back to the persisted device, and only an install that
// has none can fail outright.
async function provision(identity: WebIdentity): Promise<WebSignalDevice> {
  // Пункт 13: a legacy session that rode the phone's slot 1 asked to split
  // into its own slot. Register as a SECONDARY with fresh keys, before any
  // restore below can resurrect the shared-slot blob — which is handed over
  // as `prev`, so queue rows still addressed to the old shared identity keep
  // decrypting. The flag clears only on success, so an offline boot retries
  // instead of half-migrating.
  if (localStorage.getItem(splitKey(identity.uin)) === '1') {
    const shared = await idbGet<DeviceBlob>(blobKey(identity.uin))
    const dev = await becomeSecondary(
      identity,
      shared && shared.deviceId === PRIMARY_DEVICE_ID ? shared : undefined,
    )
    localStorage.removeItem(splitKey(identity.uin))
    return dev
  }
  // Restore the SAME device across reloads (stable identity → peers' sessions
  // stay valid + prior conversations decrypt).
  let saved = await idbGet<DeviceBlob>(blobKey(identity.uin))
  if (!saved) {
    // Nothing under the scoped name — look in the FLAT database before minting
    // anything. A QR-link page lived its whole life unscoped (the link flow
    // used to be an SPA navigation, not a reload), so the device it published
    // sits under 'rcq-web' while this boot reads 'rcq-web-<uin>'. Minting here
    // re-claimed the primary slot with fresh keys and every peer with a
    // session kept sealing to the old ones — silently, forever (2026-08-20).
    // Adopt, never re-mint.
    saved = await adoptFlatDeviceState(identity.uin)
  }
  // An island-assigned id is final: asking again would register a second
  // device on every reload and leave the previous ones addressed by peers who
  // cached them.
  if (saved && saved.deviceId > PRIMARY_DEVICE_ID) return WebSignalDevice.restore(saved)

  if (!saved) {
    // A registration whose answer never came back left an identity of ours on
    // the island — a device row peers can already be addressing. Finishing it
    // is what makes that row reachable, so it comes before the claim below.
    const claimed = await idbGet<DeviceBlob>(claimKey(identity.uin))
    if (claimed) return becomeSecondary(identity)
    // A 'secondary' policy never reaches the claim below: whoever holds the
    // slot — a phone, or nobody yet — keeps it, and this install registers
    // alongside. See ProvisionPolicy above for why the console client must.
    if (_provisionPolicy === 'secondary') return becomeSecondary(identity)
    // ★ Nothing of ours on this machine: take the primary slot, whoever holds
    // it, and without asking. There are no sessions here to preserve, the
    // account key this device seals to is the one every sender already has, and
    // the install displaced — if any is still alive — re-registers itself as a
    // secondary the next time it looks. Asking first is what used to leave the
    // slot holding an identity nobody has any more.
    try {
      return await claimPrimary(identity)
    } catch (e) {
      // An island that will not hand the slot over still has room for a device
      // of our own, and a secondary is reachable where no device at all is not.
      // If that fails too, it is the claim's failure that says why.
      try {
        return await becomeSecondary(identity)
      } catch {
        throw e
      }
    }
  }

  const status = await keysStatus(identity)
  // The island cannot say who owns the slot. This install keeps the device it
  // already has: it is what opens the backlog addressed to it.
  if (!status) return WebSignalDevice.restore(saved)

  if (!status.has_bundle) {
    // Nobody holds the slot — the island lost the bundle this install
    // published, or never had it. Republish the SAME one.
    return claimPrimary(identity, saved)
  }

  const dev = await WebSignalDevice.restore(saved)
  // ⚠ ABSENT is not "somebody else's". `has_bundle` is true exactly when the
  // island has an identity key to report, so the two disagree only where the
  // field itself is missing: an island that predates multi-device, which has
  // one key slot and no device registry to register a second device in. There
  // this install keeps what it has rather than evicting a sibling it cannot
  // even see.
  const ownerUnknown = !status.signal_identity_key
  // The slot still carries OUR identity key, so it is still ours.
  if (ownerUnknown || status.signal_identity_key === dev.signalIdentityKeyB64()) return dev

  // It carries somebody else's. The sessions this install built while it was
  // device 1 are dead either way — peers hold them under an address that is now
  // the other install's — so it starts over as a secondary device.
  try {
    return await becomeSecondary(identity, saved)
  } catch {
    // Unregistered this round, but still the device everything queued for it
    // before the slot changed hands was encrypted to. The next provision tries
    // again, from the claim this one persisted.
    return dev
  }
}

/// Serialise provisioning across this account's tabs. Two of them booting at
/// once would each find no device of their own on the island and each POST
/// /keys/devices, which mints a row per call — one of them ends up addressed by
/// nobody. The second tab through the lock re-reads what the first persisted.
/// Web Locks releases on tab death; where it is missing (older webviews) the
/// claim record written before the POST is the remaining guard.
function withProvisionLock<T>(uin: number, fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as { locks?: { request?: (name: string, cb: () => Promise<T>) => Promise<T> } }).locks
  if (!locks?.request) return fn()
  return locks.request(`rcq-signal-provision:${uin}`, fn)
}

/// This install's libsignal device id, for callers that cannot await (the live
/// socket). 1 until provisioning has resolved, which is also what an
/// unprovisioned install is addressed as.
let _myDeviceId = PRIMARY_DEVICE_ID

/// Provision-once (per page load) and return this account's libsignal device.
export function getDevice(identity: WebIdentity): Promise<WebSignalDevice> {
  let p = _devices.get(identity.uin)
  if (!p) {
    p = withProvisionLock(identity.uin, () => provision(identity)).then(
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
/// and the addressee of the queue rows that are its own. Null when this install
/// cannot say which device it is.
///
/// ⚠ Never guess the primary id here. A registered secondary that asks the
/// island for device 1's queue is served device 1's copies — encrypted to a
/// ratchet that lives on another machine, so unreadable here — and its ack
/// then advances a cursor computed over another device's rows. Both halves of
/// that lose messages, and neither is visible from this side. When provisioning
/// cannot finish, the id already on disk is the true one; when there is none,
/// the caller has to wait rather than drain as somebody else.
export async function myDeviceId(identity: WebIdentity): Promise<number | null> {
  try {
    return (await getDevice(identity)).deviceId
  } catch {
    const saved = await idbGet<DeviceBlob>(blobKey(identity.uin)).catch(() => undefined)
    if (!saved) return null
    // The live socket filters on this too, and it has no way to await.
    _myDeviceId = saved.deviceId
    return saved.deviceId
  }
}

/// Same, without awaiting provisioning.
export function currentDeviceId(): number {
  return _myDeviceId
}

/// Persist a device's current state (sessions advance on every encrypt/
/// decrypt, so call after each). Best-effort.
async function persist(identity: WebIdentity, dev: WebSignalDevice, key = blobKey(identity.uin)): Promise<void> {
  try {
    await idbSet(key, await dev.serialize())
  } catch {
    /* IDB write failed — non-fatal */
  }
}

const _prevDevices = new Map<number, Promise<WebSignalDevice | null>>()

/// The device this install held before it became a secondary, if it kept one.
/// A peer that fetched our bundle while we were device 1 caches the session it
/// built from it and keeps encrypting to that identity — the copies it sends
/// are addressed to this account with no device on them, delivered here, and
/// openable by nothing else. Null once there is no such device.
function previousDevice(identity: WebIdentity): Promise<WebSignalDevice | null> {
  let p = _prevDevices.get(identity.uin)
  if (!p) {
    p = idbGet<DeviceBlob>(prevKey(identity.uin))
      .then((blob) => (blob ? WebSignalDevice.restore(blob) : null))
      .catch(() => null)
    _prevDevices.set(identity.uin, p)
  }
  return p
}

function wireVersion(payloadB64: string): number {
  try {
    return JSON.parse(new TextDecoder().decode(b64ToBytes(payloadB64))).v ?? 0
  } catch {
    return 0
  }
}

/// Thrown when a v=2 payload was never even ATTEMPTED, because this install has
/// no libsignal device yet (the island could not be reached to provision one).
/// ⚠ Not the same as undecryptable, and the difference is a whole backlog: a
/// caller that acks what it merely failed to READ tells the island to let go of
/// it, and it is gone. Everything here comes back on a later drain.
export class DeviceUnavailableError extends Error {}

/// Decode an inbound sealed envelope. Returns null for envelopes this device
/// can't read (e.g. a ciphertext fanned out to a DIFFERENT device) so callers
/// can silently skip them; throws DeviceUnavailableError for the ones it could
/// not try, which must be left where they are.
export async function decryptIncoming(
  identity: WebIdentity,
  payloadB64: string,
): Promise<{ senderUIN: number; senderDeviceId?: number; senderHost?: string; senderSigningKey?: string; envelope: Envelope } | null> {
  const v = wireVersion(payloadB64)
  if (v === 2) {
    let dev: WebSignalDevice
    try {
      dev = await getDevice(identity)
    } catch (e) {
      throw new DeviceUnavailableError(`no libsignal device: ${e instanceof Error ? e.message : e}`)
    }
    try {
      const out = await dev.decrypt(payloadB64) // sender UIN read from the envelope
      await persist(identity, dev) // ratchet advanced — snapshot
      return out // v=2 is same-island only; no senderHost
    } catch (e) {
      // Not ours to read — or ours to read with the identity this install
      // published before it became a secondary. Logged, never thrown: the
      // caller treats null as terminal and acks the row away, and a silent
      // null here is how a swallowed decrypt failure erases a message with
      // no trace to debug from (2026-08-20).
      console.warn('v2 decrypt failed (current device):', e instanceof Error ? e.message : e)
      const prev = await previousDevice(identity)
      if (!prev) return null
      try {
        const out = await prev.decrypt(payloadB64)
        await persist(identity, prev, prevKey(identity.uin)) // its ratchet advanced too
        return out
      } catch (e2) {
        console.warn('v2 decrypt failed (previous device):', e2 instanceof Error ? e2.message : e2)
        return null
      }
    }
  }
  if (v === 1) {
    try {
      return decryptV1(payloadB64, identity) // carries senderHost when cross-island
    } catch {
      return null
    }
  }
  return null
}

// Per-peer device targets, established once then reused. The libsignal session
// lives in the device's store after the first establish, so subsequent sends
// just encrypt — no bundle fetch (which also consumed a one-time prekey every
// time), no re-handshake. THIS is what makes a conversation feel instant after
// the first message.
interface PeerTarget {
  deviceId: number
  outerPub: Uint8Array
  /// When that device's bundle — and with it the key above — was read. Zeroed
  /// to force the next resolve to read it again.
  at: number
}
interface PeerTargets {
  /// When the device LIST was last read.
  at: number
  /// How long this particular entry is trusted (base +/- jitter, fixed at read
  /// time). Per entry so a room's worth of peers do not all expire on the same
  /// tick and re-read their lists in one thundering herd.
  ttl: number
  devices: PeerTarget[]
}
const _peerTargets = new Map<number, PeerTargets>()

/// How long a peer's device list is trusted, before a per-entry jitter. A
/// device the peer adds later has to become reachable without a reload, and a
/// revoked one has to stop being addressed; but the list is also invalidated
/// the moment we learn it is stale (a send or a bundle fetch to one of its
/// devices 404s, or an inbound v=2 names a device not on it), so the TTL is the
/// slow backstop, not the fast path. Fifteen minutes, NOT a day: a peer's newly
/// linked device would otherwise get no carbons for an hour, which was a real
/// report on 2026-08-19. Only the list is re-read: a target we already hold
/// keeps its session, because re-running X3DH against it would burn one of the
/// peer's one-time prekeys and restart the ratchet for nothing.
const TARGETS_TTL_BASE_MS = 15 * 60_000

/// The +/- jitter on each entry's TTL, so entries read together still expire
/// spread out.
const TARGETS_TTL_JITTER_MS = 3 * 60_000

/// A fresh TTL for one entry: 15 min +/- up to 3.
function targetsTtl(): number {
  return TARGETS_TTL_BASE_MS + Math.round((Math.random() * 2 - 1) * TARGETS_TTL_JITTER_MS)
}

/// How long a list that could NOT be read is left alone. Without it the failed
/// read leaves `at` where it was and every following send tries again — a round
/// trip per message, against an island that just said no.
const TARGETS_RETRY_MS = 30_000

/// How long a peer device's sealed-sender key is reused before its bundle is
/// read again. A key that never expires is a key that can only be wrong: the
/// peer republishes one whenever their install is replaced, and from here that
/// is invisible — the island accepts every copy sealed to the key they no
/// longer hold, and the device never opens one of them. The session behind it
/// survives the re-read; only the outer key is refreshed.
const OUTER_KEY_TTL_MS = 12 * 60 * 60_000

/// A target whose sealed-sender key is still young enough to send to.
function usable(t: PeerTarget | undefined): PeerTarget | undefined {
  return t && Date.now() - t.at < OUTER_KEY_TTL_MS ? t : undefined
}

// ---- Silence probe: notice a peer whose install was replaced under us. ----
//
// A replaced install (re-claimed primary slot, reinstall, restore onto a new
// machine) is INVISIBLE from the sending side: the island takes every copy
// sealed to the key the peer no longer holds, the receipt simply never comes,
// and an established session means the bundle — where the new identity would
// show — is not read again for OUTER_KEY_TTL_MS (12h). Messages sent in that
// window are lost without a trace (live-tested 2026-08-20).
//
// So sustained silence IS the signal: if this side keeps sending and the peer
// has answered nothing — no receipt, no message, nothing — for PEER_SILENCE_MS,
// the next send REBUILDS the sessions outright (fresh bundle read + X3DH per
// device). Not merely an ik comparison: the identity this side recorded may
// itself have been read only after the replacement, in which case it compares
// clean against a bundle the peer's dead session cannot open — a rebuild is
// the one move that works from any wrong state. An unchanged peer (merely
// offline) costs one prekey exchange per device per
// SILENCE_PROBE_MIN_INTERVAL_MS; their client reads both the old-session
// backlog and the new session fine.
// Tracked PER DEVICE, not per account. A peer's phone answering promptly says
// nothing about their linked browser whose session is dead — a per-account
// timer was cleared by the living sibling's receipts and the dead device never
// healed (live-tested 2026-08-20). Keys are "uin:deviceId".
/// Envelope kinds whose delivery a peer answers (with a receipt), and so the
/// only ones whose silence means anything. Mirrors Android's isCarbonable.
const PROBE_ARMING_KINDS = new Set(['text', 'photo', 'video', 'voice', 'file', 'location', 'poll'])
const PEER_SILENCE_MS = 2 * 60_000
const SILENCE_PROBE_MIN_INTERVAL_MS = 30 * 60_000
const _awaitingReplySince = new Map<string, number>()
const _lastSilenceProbeAt = new Map<string, number>()

/// A decrypted envelope from [uin]'s device [deviceId] — a message, a receipt,
/// anything — proves THAT install can read us: its silence probe stands down.
/// An envelope that does not name its device (v=1, or a pre-fan-out sender)
/// clears nothing: v=1 peers never arm the probe (it arms only on v=2 sends),
/// and crediting the primary for a copy that may have come from a sibling is
/// exactly the confusion that kept a dead device unhealed.
export function noteInboundFrom(uin: number, deviceId?: number): void {
  if (typeof deviceId !== 'number') return
  _awaitingReplySince.delete(`${uin}:${deviceId}`)
  // A v=2 message from a device that is NOT in the cached list means the list
  // is stale: the peer linked a device since we last read it, and that device
  // gets no carbons until we fan out to it. Drop the entry so the next send
  // re-resolves and picks it up, rather than waiting out the TTL (an hour of
  // missing carbons was the 2026-08-19 report).
  const cached = _peerTargets.get(uin)
  if (cached && !cached.devices.some((t) => t.deviceId === deviceId)) {
    _peerTargets.delete(uin)
    console.debug(`peer ${uin} device ${deviceId} not in cached roster; will re-resolve`)
  }
}

/// Forget how long every peer device has been quiet. Called when the socket
/// comes back: the probe measures a PEER's silence, and a stretch when THIS
/// side had no connection measures nothing — their replies may be sitting in
/// the queue this reconnect is about to drain. Counting our own outage as
/// their silence is how the first send after coming back would re-key against
/// a backlog that is still sealed to the session we hold.
export function resetSilenceProbes(): void {
  _awaitingReplySince.clear()
}

async function resolveTargets(
  identity: WebIdentity,
  dev: WebSignalDevice,
  peerUin: number,
  known: PeerTarget[],
  rebuildDevices: ReadonlySet<number> = new Set(),
): Promise<PeerTargets> {
  const byId = new Map(known.map((t) => [t.deviceId, t]))
  const list = (await apiGet(identity, `/keys/${peerUin}/devices`)) as { devices?: Array<{ device_id: number }> }
  const devices: PeerTarget[] = []
  for (const d of list.devices ?? []) {
    // The in-memory list first, then the session store — which outlives the
    // page load. Re-running X3DH against a device we already share a ratchet
    // with restarts that ratchet for nothing AND eats one of the peer's
    // one-time prekeys, a pool that only refills while their client runs. A
    // peer who lost their own store re-keys this side with the prekey message
    // their next send carries, which replaces the session under this address.
    // A rebuild trusts nothing CACHED — not the target, not the outer key —
    // and goes to the island for a fresh bundle. What it does with that bundle
    // is decided below: the published identity is the evidence, and an
    // unchanged one means the session stands.
    let rebuild = rebuildDevices.has(d.device_id)
    // ⚠ Ask the FREE question first. The device list carries each install's
    // published identity; a bundle read carries the same answer and consumes
    // one of the peer's one-time prekeys on the way. "Unchanged" is the answer
    // almost every time — a peer replying over v=1 never clears the probe at
    // all — so paying a prekey per probe drains a pool that only refills while
    // its owner is online, and every later X3DH with that account then loses
    // its one-time secret. The probe would erode what it defends.
    if (rebuild) {
      const publishedIk = (d as { signal_identity_key?: string }).signal_identity_key
      const heldIk = dev.knownTarget(peerUin, d.device_id)?.ik
      if (publishedIk && heldIk !== undefined && heldIk === publishedIk && (await dev.hasSession(peerUin, d.device_id))) {
        console.warn(`silence probe: ${peerUin}:${d.device_id} unchanged; session kept`)
        rebuild = false
      }
    }
    const cached = rebuild ? undefined : (usable(byId.get(d.device_id)) ?? sessionTarget(dev, peerUin, d.device_id))
    if (cached) {
      devices.push(cached)
      continue
    }
    // A bundle 404 for a device the LIST just named is the list going stale
    // under us: the device was revoked between the list read and this fetch.
    // Drop it from the roster we build instead of failing the whole resolve, so
    // the peer's other devices still get this send. The list is re-read on the
    // next resolve; nothing here is cached as reachable.
    let bundle: SignalBundle
    try {
      bundle = await fetchKeyBundle(identity, `/keys/${peerUin}/devices/${d.device_id}/bundle`)
    } catch (e) {
      if (e instanceof KeyLookupError && e.status === 404) {
        console.warn(`bundle 404 for ${peerUin}:${d.device_id}; dropped from roster`)
        continue
      }
      throw e
    }
    const outerPub = b64ToBytes(bundle.sealed_sender_pub)
    // Re-reading a bundle for a device we already talk to is usually about the
    // outer key alone: the ratchet is fine, and rebuilding it would cost the
    // peer a one-time prekey and this conversation its message order.
    //
    // Unless the IDENTITY behind that device changed — then the install we
    // share a ratchet with is gone (they reinstalled, or restored onto a new
    // phone) and every copy encrypted on the old session is unreadable to
    // them. Waiting for their next message to re-key this side only works if
    // they write first; if we do, those messages are lost. So a changed
    // identity key rebuilds the session here.
    const held = dev.knownTarget(bundle.uin, bundle.device_id)
    const sameIdentity = held?.ik !== undefined && held.ik === bundle.signal_identity_key
    // ⚠ A silence-probe rebuild is NOT exempt from this test. Silence is
    // evidence that something MIGHT be wrong, and re-reading the bundle is how
    // we find out; the bundle answering with the SAME identity is the answer
    // that nothing is — the peer is merely offline, asleep, or replying over
    // v=1, which names no device and so can never clear the probe. Handing
    // that peer a fresh handshake anyway spends one of their one-time prekeys
    // and restarts this conversation's ratchet every half hour, forever, for
    // no fault. (The narrow case this gives up — a dead session behind an
    // unchanged identity — is logged below, and their next message re-keys us
    // through its own prekey material.)
    if (sameIdentity && (await dev.hasSession(bundle.uin, bundle.device_id))) {
      if (rebuild) console.warn(`silence probe: ${bundle.uin}:${bundle.device_id} unchanged; session kept`)
      dev.noteTarget(bundle.uin, bundle.device_id, outerPub, bundle.signal_identity_key)
    } else if (!rebuild && held?.ik === undefined && (await dev.hasSession(bundle.uin, bundle.device_id))) {
      // First read since this cache learned to record identities: nothing to
      // compare against, so the session stands rather than being re-keyed for
      // a peer who may be perfectly fine.
      //
      // ⚠ And the identity is deliberately NOT recorded here. Recording it
      // would mean "the session was built from this identity" — which we do
      // not know. If this bundle is the peer's NEW identity while our session
      // is their OLD, dead one, writing it down makes every later comparison
      // read "unchanged" and the silence probe can never heal that session:
      // our messages would be accepted by the island and silently lost until
      // the peer happens to write first. Left unrecorded, the next probe sees
      // an unverified identity and does the handshake.
      dev.noteTarget(bundle.uin, bundle.device_id, outerPub)
    } else {
      if (rebuild) console.warn(`fresh X3DH with ${bundle.uin}:${bundle.device_id}`)
      // establishSession records the identity itself (crypto-v2 noteTarget at
      // the end of it), and that recording is the earned one: this session was
      // built FROM this identity, so comparing against it later means
      // something. Contrast the branch above, which deliberately leaves it
      // blank.
      await dev.establishSession(bundle)
    }
    devices.push({ deviceId: bundle.device_id, outerPub, at: Date.now() })
  }
  return { at: Date.now(), ttl: targetsTtl(), devices }
}

/// A peer device this install already holds both halves of a send for: the
/// session, and a sealed-sender key recent enough to seal to.
function sessionTarget(dev: WebSignalDevice, peerUin: number, deviceId: number): PeerTarget | undefined {
  const outer = dev.knownTarget(peerUin, deviceId)
  return outer ? usable({ deviceId, outerPub: outer.pub, at: outer.at }) : undefined
}

/// Thrown when a fan-out reached some of the peer's devices and not others. The
/// count alone cannot say it: a caller reading "1 device" as delivered leaves
/// the device that missed this copy with no other way to learn of it — the
/// fan-out is the only path there.
export class PartialFanOutError extends Error {}

/// Send an envelope to a peer over v=2, fanning out one ciphertext per device.
/// Returns the number of devices reached — 0 when the peer has no libsignal
/// bundle at all, which is the caller's signal to fall back to v=1. Throws
/// PartialFanOutError when SOME of them took the copy and the rest did not:
/// that is a failed send, not a smaller number.
export async function sendV2(identity: WebIdentity, peerUin: number, env: Envelope, envelopeType = 'message'): Promise<number> {
  const dev = await getDevice(identity)

  // Silence probe (see PEER_SILENCE_MS above): rebuild the session of every
  // peer DEVICE that has answered nothing since a previous send to it.
  const rebuildDevices = new Set<number>()
  {
    const now = Date.now()
    for (const t of _peerTargets.get(peerUin)?.devices ?? []) {
      const key = `${peerUin}:${t.deviceId}`
      const waitingSince = _awaitingReplySince.get(key)
      if (
        waitingSince !== undefined &&
        now - waitingSince > PEER_SILENCE_MS &&
        now - (_lastSilenceProbeAt.get(key) ?? 0) > SILENCE_PROBE_MIN_INTERVAL_MS
      ) {
        _lastSilenceProbeAt.set(key, now)
        rebuildDevices.add(t.deviceId)
      }
    }
    // Rare by design, so worth a permanent trace: this is the one footprint a
    // replaced peer install leaves anywhere.
    if (rebuildDevices.size) {
      console.warn(`silence probe: rebuilding sessions with ${peerUin}, devices [${[...rebuildDevices]}]`)
    }
  }

  let targets = _peerTargets.get(peerUin)
  if (rebuildDevices.size || !targets || Date.now() - targets.at > targets.ttl) {
    try {
      targets = await resolveTargets(identity, dev, peerUin, targets?.devices ?? [], rebuildDevices)
    } catch (e) {
      // A refresh that fails leaves the devices we already reached in place —
      // they were reachable a minute ago. With nothing cached there is no send
      // to make, and the caller falls back to v=1.
      //
      // ⚠ Loud, because this catch once swallowed the failure that kept a
      // probe-triggered rebuild from ever landing: the send then went out on
      // the very session the probe had just declared dead.
      console.warn('resolveTargets failed:', e instanceof Error ? e.message : e)
      if (!targets) throw e
      targets = { ...targets, at: Date.now() - targets.ttl + TARGETS_RETRY_MS }
    }
    // An empty list is never cached: the peer may publish a bundle at any time,
    // and until they do, every send has to ask again.
    if (targets.devices.length) _peerTargets.set(peerUin, targets)
    else _peerTargets.delete(peerUin)
  }

  let sent = 0
  const missed = new Set<number>()
  let stale = false
  for (const tgt of targets.devices) {
    try {
      const payload = await dev.encryptTo(peerUin, tgt.deviceId, tgt.outerPub, env)
      const res = await fetch(`${identity.apiBase}/messages/sealed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Which device this ciphertext is FOR: only that one holds the other half
        // of the ratchet, so the island hands the row to it alone. Omitted by
        // pre-fan-out senders, and then every device drains it. `cls` (Stage 2)
        // mirrors the island's own derivation from `envelope_type`.
        body: JSON.stringify({ to_uin: peerUin, envelope_type: envelopeType, cls: messageClass(envelopeType), payload, to_device_id: tgt.deviceId }),
      })
      if (res.ok) sent++
      else {
        missed.add(tgt.deviceId)
        if (res.status === 404) stale = true
      }
    } catch {
      // One device's copy does not get to take the copies behind it down with
      // it: each of them is the only path to the device it is addressed to.
      missed.add(tgt.deviceId)
    }
  }
  // A copy the island refuses to take means the targets we hold no longer
  // describe the peer (a device revoked under us, the account gone). Drop the
  // whole list so the next send resolves it again.
  if (stale) _peerTargets.delete(peerUin)
  if (missed.size) {
    // A copy that did not land is the one hint this side ever gets that what it
    // holds about that device may be out of date — the sealed-sender key most
    // of all, since a stale one fails silently. Expire it in memory AND in the
    // store that outlives the page, and re-read the list with it. The session
    // stays: this is a refresh, not a re-key.
    for (const t of targets.devices) if (missed.has(t.deviceId)) t.at = 0
    for (const id of missed) dev.forgetTarget(peerUin, id)
    targets.at = 0
  }
  if (sent > 0 || missed.size) await persist(identity, dev) // ratchet advanced / target expired — snapshot
  // Arm the silence probe per DEVICE a copy actually reached, on the first
  // send that device has not answered yet. A v=2 envelope from it clears the
  // timer (noteInboundFrom).
  //
  // ⚠ Only for an envelope that EARNS an answer — a stored message, which the
  // recipient receipts back. A receipt, a reaction or an edit owes nothing in
  // return, and since every message we RECEIVE makes us send a receipt of our
  // own, arming on those made "armed and never cleared" the steady state of
  // every conversation: a probe that fires on healthy sessions is a probe that
  // spends other people's prekeys for nothing.
  const earnsAnswer = PROBE_ARMING_KINDS.has(env.kind)
  for (const t of targets.devices) {
    if (!earnsAnswer || missed.has(t.deviceId)) continue
    const key = `${peerUin}:${t.deviceId}`
    if (!_awaitingReplySince.has(key)) {
      _awaitingReplySince.set(key, Date.now())
      console.debug(`silence probe armed for ${key}`)
    }
  }
  // Reaching some of the peer's devices is not delivery. A retry re-sends to
  // every device and the recipient's envelope-id dedup collapses the copies
  // that did land, so saying so costs a duplicate at worst.
  if (missed.size && sent > 0) throw new PartialFanOutError(`fan-out reached ${sent}/${sent + missed.size} devices`)
  return sent
}

/// Stage 3 of the core-metadata plan: whether this island serves the three key
/// lookups without a session token AND issues the anonymous deposit tokens a
/// bundle fetch pays with. Both must be true. A request that carries neither a
/// session token nor a deposit token only gets a bundle stripped of its
/// one-time prekey, so a half-anonymous request is never sent: an island short
/// either flag stays on the authenticated path. A guest clone on a foreign
/// island stays there too, as it does on Android.
///
/// The answer rides server-info's run-long cache, so this costs a network
/// round trip once per island; a null answer (island down, older than the
/// flags, or not fetched yet) reads false and keeps the legacy request.
async function anonKeyMode(identity: WebIdentity): Promise<boolean> {
  if (identity.guest) return false
  const caps = (await fetchServerInfo(identity.apiBase))?.capabilities
  return caps?.anon_keys === true && caps?.deposit_auth === true
}

/// A key GET that failed, carrying the status so a caller can tell a 404 (the
/// device or bundle is gone: invalidate the cached list) from a transient
/// error (keep what we have and retry).
class KeyLookupError extends Error {
  constructor(public status: number, path: string) {
    super(`GET ${path} -> ${status}`)
  }
}

// Timed out like every other call here: adoptRegisteredDevice runs these with
// the cross-tab provisioning lock held, and a fetch that black-holes would keep
// every other tab of this account from provisioning at all.
//
// A GET that consumes nothing: the device list, or the settings screen's own
// list. On a Stage 3 island it carries no session token (reading a list takes
// no prekey, so it needs none and the island never learns who asked);
// authenticated everywhere else.
async function apiGet(identity: WebIdentity, path: string): Promise<any> {
  const headers: Record<string, string> = {}
  if (!(await anonKeyMode(identity))) headers.Authorization = `Bearer ${identity.jwt}`
  const res = await fetchWithTimeout(`${identity.apiBase}${path}`, { headers })
  if (!res.ok) throw new KeyLookupError(res.status, path)
  return res.json()
}

/// The always-authenticated key GET: the legacy path, and the fallback a
/// Stage 3 bundle fetch takes when no deposit token can be spent.
async function apiGetAuthed(identity: WebIdentity, path: string): Promise<any> {
  const res = await fetchWithTimeout(`${identity.apiBase}${path}`, { headers: { Authorization: `Bearer ${identity.jwt}` } })
  if (!res.ok) throw new KeyLookupError(res.status, path)
  return res.json()
}

/// A bundle lookup the way the island wants it: anonymous with a single-use
/// deposit token on a Stage 3 island, the session token otherwise. Mirrors
/// Android's RcqApi.fetchBundle.
///
/// One token per fetch. The island answers 200 (token spent, one_time_prekey
/// filled), 403 (a bad, spent or wrong-epoch token, or an island that stopped
/// issuing: the epoch most likely rotated under the cached params), or 404 (no
/// such bundle/device; the verifier never saw the token, so it goes back to the
/// reserve). On 403 the cached params and reserve are dropped, a fresh token is
/// minted and the fetch is tried once more; a second 403, or no token to be had
/// at all, falls back to the session-token path for THIS fetch so a send is
/// never blocked on the mint.
async function fetchKeyBundle(identity: WebIdentity, path: string): Promise<SignalBundle> {
  if (!(await anonKeyMode(identity))) return (await apiGetAuthed(identity, path)) as SignalBundle
  let token = await depositAuth.takeToken(identity.apiBase)
  let retried = false
  while (token) {
    const res = await fetchWithTimeout(`${identity.apiBase}${path}`, {
      headers: { 'X-Deposit-Token': depositAuth.headerValue(token) },
    })
    if (res.ok) return (await res.json()) as SignalBundle
    if (res.status === 403) {
      depositAuth.forget(identity.apiBase)
      if (retried) break
      retried = true
      token = await depositAuth.takeToken(identity.apiBase)
      continue
    }
    if (res.status === 404) depositAuth.giveBack(identity.apiBase, token)
    throw new KeyLookupError(res.status, path)
  }
  return (await apiGetAuthed(identity, path)) as SignalBundle
}

/// The key slots of OUR OWN account, for the settings screen (#643). This is
/// the cryptographic device list — every install that can read v=2 holds a
/// slot here, which makes it the one list a phrase login cannot stay out of.
export async function myAccountDevices(
  identity: WebIdentity,
): Promise<Array<{ device_id: number; label: string | null }>> {
  const list = (await apiGet(identity, `/keys/${identity.uin}/devices`)) as {
    devices?: Array<{ device_id: number; label?: string | null }>
  }
  return (list.devices ?? []).map((d) => ({ device_id: d.device_id, label: d.label ?? null }))
}
