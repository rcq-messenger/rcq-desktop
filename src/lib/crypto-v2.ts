// RCQ v=2 sealed-sender codec for the web (Double Ratchet via libsignal-WASM).
//
// Wire format is pinned from iOS CryptoService.swift + Android SealedSender.kt
// (byte-identical between them) — see docs/web-multidevice-plan.md. v=2 reuses
// the SAME outer ECIES as v=1 (crypto.ts), changing only:
//   - HKDF info "RCQ-1to1-v1" -> "RCQ-1to1-v2"
//   - inner {from,spub,sig,env}  ->  {from, kind:"prekey"|"signal", msg:b64(libsignal ct),
//     dev?:<sender device id, omitted when 1>}
//     (no Ed25519 sig — the libsignal session authenticates the sender)
//
// `WebSignalDevice` is the per-device session/store manager: it owns this
// device's libsignal identity + prekey stores + its X25519 sealed-sender key,
// and exposes register / establish-session / encrypt / decrypt. Stores are
// in-memory for now; they're libsignal-serializable, so IndexedDB persistence
// is an additive follow-up (export/import the stores). Proven by the Node
// prototype crypto-wasm-spike/v2-codec.mjs + v2-roundtrip.mjs.

import init, {
  WasmPrivateKey,
  WasmPublicKey,
  WasmIdentityKeyPair,
  WasmProtocolAddress,
  WasmInMemIdentityKeyStore,
  WasmInMemSessionStore,
  WasmInMemPreKeyStore,
  WasmInMemSignedPreKeyStore,
  WasmInMemKyberPreKeyStore,
  generatePreKeys,
  generateSignedPreKey,
  generateKyberPreKey,
  generateRegistrationId,
  processPreKeyBundle,
  encryptMessage,
  decryptMessage,
} from './signalwasm/signal_wasm.js'
import { x25519 } from '@noble/curves/ed25519'
import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { randomBytes } from '@noble/ciphers/webcrypto'
import { bytesToB64, b64ToBytes, concat, encodeEnvelopeBytes, padInnerBytes, shouldPadKind, type Envelope } from './crypto'

const HKDF_INFO_V2 = new TextEncoder().encode('RCQ-1to1-v2')
const WIRE_VERSION_V2 = 2

/// libsignal deviceId of an account's PRIMARY device — the one whose bundle
/// lives in the account's single `POST /keys/bundle` slot. Secondary devices
/// are numbered by the island, from 2 up.
export const PRIMARY_DEVICE_ID = 1

// Memoised one-time WASM instantiation. Safe to await many times.
let _wasmReady: Promise<void> | null = null
export function ensureWasm(): Promise<void> {
  if (!_wasmReady) _wasmReady = init().then(() => undefined)
  return _wasmReady
}

// -----------------------------------------------------------
// Outer ECIES layer (pure @noble; identical algorithm to v=1, info v2).
// `recipientOuterPub` is the recipient device's X25519 sealed-sender pubkey.
// -----------------------------------------------------------

export function outerWrapV2(innerBytes: Uint8Array, recipientOuterPub: Uint8Array): string {
  if (recipientOuterPub.length !== 32) throw new Error('recipient outer pub not 32 bytes')
  const ephPriv = x25519.utils.randomPrivateKey()
  const ephPub = x25519.getPublicKey(ephPriv)
  const shared = x25519.getSharedSecret(ephPriv, recipientOuterPub)
  const salt = concat(ephPub, recipientOuterPub)
  const aeadKey = hkdf(sha256, shared, salt, HKDF_INFO_V2, 32)
  const nonce = randomBytes(12)
  const ctWithTag = chacha20poly1305(aeadKey, nonce, ephPub).encrypt(innerBytes) // aad = ek
  const combined = concat(nonce, ctWithTag)
  const wire = { v: WIRE_VERSION_V2, ek: bytesToB64(ephPub), ct: bytesToB64(combined) }
  return bytesToB64(new TextEncoder().encode(JSON.stringify(wire)))
}

interface InnerV2 {
  from: number
  kind: 'prekey' | 'signal'
  msg: string
  /// Which of the SENDER's devices holds the other half of this ratchet. The
  /// receiver addresses the session by it. Omitted for device 1: every build in
  /// the field reads an absent `dev` as the primary device.
  dev?: number
}

export function outerUnwrapV2(payloadB64: string, myOuterPriv: Uint8Array, myOuterPub: Uint8Array): InnerV2 {
  const wire = JSON.parse(new TextDecoder().decode(b64ToBytes(payloadB64)))
  if (wire.v !== WIRE_VERSION_V2) throw new Error(`not v2 (v=${wire.v})`)
  const ek = b64ToBytes(wire.ek)
  const combined = b64ToBytes(wire.ct)
  if (ek.length !== 32) throw new Error('malformed ek')
  if (combined.length < 12 + 16) throw new Error('malformed ct')
  const shared = x25519.getSharedSecret(myOuterPriv, ek)
  const salt = concat(ek, myOuterPub)
  const aeadKey = hkdf(sha256, shared, salt, HKDF_INFO_V2, 32)
  const nonce = combined.subarray(0, 12)
  const ctWithTag = combined.subarray(12)
  const innerBytes = chacha20poly1305(aeadKey, nonce, ek).decrypt(ctWithTag)
  return JSON.parse(new TextDecoder().decode(innerBytes)) as InnerV2
}

// -----------------------------------------------------------
// Peer bundle shape — mirrors the backend BundleOut (GET /keys/{uin}/...).
// `sealed_sender_pub` is the recipient device's X25519 outer key (b64). For
// the primary device this is the UIN identity_key; for a secondary device it
// is that device's own key (multi-device design, Option Y).
// -----------------------------------------------------------

export interface SignalBundle {
  uin: number
  device_id: number
  /// X25519 sealed-sender (outer ECIES) pubkey of this device, b64. Encrypt
  /// the outer envelope to this when sending to the device.
  sealed_sender_pub: string
  registration_id: number
  signal_identity_key: string
  signed_prekey: { id: number; public: string; signature: string }
  kyber_prekey: { id: number; public: string; signature: string }
  one_time_prekey?: { id: number; public: string } | null
}

/// The payload this device publishes to register its libsignal bundle
/// (POST /keys/bundle for primary, POST /keys/devices for secondary).
export interface BundleUpload {
  signal_identity_key: string
  registration_id: number
  signed_prekey: { id: number; public: string; signature: string }
  kyber_prekey: { id: number; public: string; signature: string }
  one_time_prekeys: Array<{ id: number; public: string }>
}

/// A peer device's sealed-sender key, and when its bundle was read. The key is
/// not a fact forever — the peer publishes a new one when their install is
/// replaced — and a wrong one is invisible from this side: the island takes the
/// ciphertext all the same and the device simply never opens it. So the age
/// travels with the key, and the caller decides how old is too old.
export interface OuterKey {
  pub: Uint8Array
  at: number
  /// The identity key that device published alongside this outer key.
  ///
  /// Kept so a re-read of the bundle can tell a rotated sealed-sender key
  /// (refresh the key, leave the ratchet alone) from a REPLACED INSTALL
  /// (the peer reinstalled; the session we hold is against an identity that
  /// no longer exists, and every copy sent on it is unreadable). Without it
  /// the two look identical from here, and the second one loses messages
  /// until the peer happens to write first.
  ik?: string
}

// -----------------------------------------------------------
// Per-device session/store manager.
// -----------------------------------------------------------

export class WebSignalDevice {
  readonly uin: number
  deviceId: number
  /// X25519 sealed-sender (outer-layer) keypair for THIS device.
  readonly outerPriv: Uint8Array
  readonly outerPub: Uint8Array

  private idkp: WasmIdentityKeyPair
  private regId: number
  // Not readonly: establishSession rebuilds it when the TOFU memory refuses a
  // deliberate identity replacement (see there). Never reassigned elsewhere.
  identityStore: WasmInMemIdentityKeyStore
  readonly sessionStore: WasmInMemSessionStore
  readonly preKeyStore: WasmInMemPreKeyStore
  readonly signedStore: WasmInMemSignedPreKeyStore
  readonly kyberStore: WasmInMemKyberPreKeyStore
  private localAddr: WasmProtocolAddress

  // Captured prekey records (for persistence) + the peer addresses we hold a
  // session with, so serialize() can export exactly those sessions. The value
  // is that peer device's sealed-sender key when we have seen its bundle:
  // holding it is what lets a later send skip the bundle fetch entirely.
  private signedRec?: { id: number; rec: Uint8Array }
  private kyberRec?: { id: number; rec: Uint8Array }
  private prekeyRecs: Array<{ id: number; rec: Uint8Array }> = []
  private sessionPeers = new Map<string, OuterKey | undefined>() // "uin:device" -> outer key
  /// The bundle this device published, kept so a republish is the SAME bundle.
  private bundle?: BundleUpload

  private constructor(uin: number, deviceId: number, outerPriv: Uint8Array, idkp?: WasmIdentityKeyPair, regId?: number) {
    this.uin = uin
    this.deviceId = deviceId
    this.outerPriv = outerPriv
    this.outerPub = x25519.getPublicKey(outerPriv)
    if (idkp) {
      this.idkp = idkp
    } else {
      const sPriv = WasmPrivateKey.generate()
      this.idkp = new WasmIdentityKeyPair(sPriv.getPublicKey(), sPriv)
    }
    this.regId = regId ?? generateRegistrationId()
    this.identityStore = new WasmInMemIdentityKeyStore(this.idkp, this.regId)
    this.sessionStore = new WasmInMemSessionStore()
    this.preKeyStore = new WasmInMemPreKeyStore()
    this.signedStore = new WasmInMemSignedPreKeyStore()
    this.kyberStore = new WasmInMemKyberPreKeyStore()
    this.localAddr = new WasmProtocolAddress(String(uin), deviceId)
  }

  /// Create a fresh device identity. Generates a new libsignal identity +
  /// a new X25519 sealed-sender keypair (unless one is supplied, e.g. the
  /// primary device reusing the UIN identity key).
  static async create(uin: number, deviceId = 1, outerPriv?: Uint8Array): Promise<WebSignalDevice> {
    await ensureWasm()
    return new WebSignalDevice(uin, deviceId, outerPriv ?? x25519.utils.randomPrivateKey())
  }

  private markSession(uin: number, deviceId: number, outer?: OuterKey): void {
    const key = `${uin}:${deviceId}`
    // An encrypt/decrypt knows the address but not the peer's outer key, so it
    // must not erase one a bundle fetch already recorded.
    this.sessionPeers.set(key, outer ?? this.sessionPeers.get(key))
  }

  /// The peer device's sealed-sender key, when this device already holds a
  /// session with it. A sender that has both needs neither the bundle (fetching
  /// one consumes a one-time prekey of the peer) nor a second X3DH.
  knownTarget(uin: number, deviceId: number): OuterKey | undefined {
    return this.sessionPeers.get(`${uin}:${deviceId}`)
  }

  /// Record a peer device's sealed-sender key on its own, leaving the session
  /// alone. Re-reading a bundle to pick up a rotated key must not drag the
  /// ratchet along: X3DH again would restart it and eat one of the peer's
  /// one-time prekeys for a key exchange that already happened.
  noteTarget(uin: number, deviceId: number, pub: Uint8Array, ik?: string): void {
    if (pub.length === 32) this.markSession(uin, deviceId, { pub, at: Date.now(), ik })
  }

  /// Forget a peer device's sealed-sender key, keeping the session. The next
  /// send to that device reads its bundle again.
  forgetTarget(uin: number, deviceId: number): void {
    const key = `${uin}:${deviceId}`
    if (this.sessionPeers.has(key)) this.sessionPeers.set(key, undefined)
  }


  /// Whether this device already holds a libsignal session with a peer device.
  hasSession(uin: number, deviceId: number): Promise<boolean> {
    return this.sessionStore.has_session(this.addr(uin, deviceId))
  }

  private addr(uin: number, deviceId: number): WasmProtocolAddress {
    return new WasmProtocolAddress(String(uin), deviceId)
  }

  /// A secondary device's deviceId is assigned by the server at registration
  /// (POST /keys/devices). Call this once with the assigned id so this
  /// device's own libsignal address matches what peers address it by.
  setDeviceId(deviceId: number): void {
    this.deviceId = deviceId
    this.localAddr = new WasmProtocolAddress(String(this.uin), deviceId)
  }

  /// This device's libsignal identity public key, base64. Same value published
  /// in the bundle's `signal_identity_key` and used as the safety-number key.
  /// Federation (Layer B) uses it as the `ik` of a signed home-island record.
  signalIdentityKeyB64(): string {
    return bytesToB64(this.idkp.public_key.serialize())
  }

  /// This device's published bundle (signed + kyber prekey + an OPK pool).
  /// Side effect on the FIRST call: the keys are saved into this device's
  /// stores so it can answer X3DH from peers.
  ///
  /// ⚠ Built once and then remembered, because the prekey ids are fixed (1, and
  /// 1..n for the pool). Building it again mints different keys under those
  /// same ids, and a peer holding the bundle published earlier then opens its
  /// X3DH against an id whose key this device no longer has: the message is
  /// undecryptable and the sender never learns it. A republish — the primary
  /// slot being re-claimed — has to be the SAME bundle peers already hold.
  async buildBundle(opkCount = 20): Promise<BundleUpload> {
    if (this.bundle) return this.bundle
    const spk = await generateSignedPreKey(1, this.idkp, this.signedStore)
    const kpk = await generateKyberPreKey(1, this.idkp, this.kyberStore)
    const opks = await generatePreKeys(1, opkCount, this.preKeyStore)
    this.signedRec = { id: spk.id, rec: spk.record }
    this.kyberRec = { id: kpk.id, rec: kpk.record }
    this.prekeyRecs = opks.map((p) => ({ id: p.id, rec: p.record }))
    this.bundle = {
      signal_identity_key: bytesToB64(this.idkp.public_key.serialize()),
      registration_id: this.regId,
      signed_prekey: { id: spk.id, public: bytesToB64(spk.public_key), signature: bytesToB64(spk.signature) },
      kyber_prekey: { id: kpk.id, public: bytesToB64(kpk.public_key), signature: bytesToB64(kpk.signature) },
      one_time_prekeys: opks.map((p) => ({ id: p.id, public: bytesToB64(p.public_key) })),
    }
    return this.bundle
  }

  /// Establish an outbound session with a peer device from its fetched bundle
  /// (X3DH + Kyber / PQXDH). Idempotent-ish: libsignal no-ops if a session
  /// already exists for the address.
  async establishSession(peer: SignalBundle): Promise<void> {
    const peerAddr = this.addr(peer.uin, peer.device_id)
    const opk = peer.one_time_prekey
    const process = () =>
      processPreKeyBundle(
        peerAddr,
        this.localAddr,
        peer.registration_id,
        WasmPublicKey.deserialize(b64ToBytes(peer.signal_identity_key)),
        peer.signed_prekey.id,
        WasmPublicKey.deserialize(b64ToBytes(peer.signed_prekey.public)),
        b64ToBytes(peer.signed_prekey.signature),
        opk ? opk.id : undefined,
        opk ? b64ToBytes(opk.public) : undefined,
        peer.kyber_prekey.id,
        b64ToBytes(peer.kyber_prekey.public),
        b64ToBytes(peer.kyber_prekey.signature),
        this.sessionStore,
        this.identityStore,
      )
    try {
      await process()
    } catch (e) {
      // The in-memory TOFU store refuses an identity that differs from the one
      // it remembers for this address — correct for a passive decrypt, wrong
      // here: every call to THIS method is already the deliberate decision to
      // accept the peer's current identity (an ik mismatch on a bundle re-read,
      // or a silence-probe rebuild). The store has no per-address override, so
      // rebuild it from our own key pair — it holds nothing persistent anyway
      // (peer identities never survive a reload) — and run the exchange again.
      // Without this, a peer whose install was replaced stayed unreachable
      // FOREVER: the probe fired, the rebuild threw right here, the swallowed
      // failure left the dead session in place (live-tested 2026-08-20).
      console.warn(`identity replaced for ${peer.uin}:${peer.device_id}, re-keying:`, e instanceof Error ? e.message : e)
      const old = this.identityStore
      this.identityStore = new WasmInMemIdentityKeyStore(this.idkp, this.regId)
      try {
        old.free()
      } catch {
        /* already freed */
      }
      await process()
    }
    // Legacy rows can carry an empty sealed_sender_pub; only a real key is
    // worth remembering, the rest re-read the bundle.
    this.noteTarget(peer.uin, peer.device_id, b64ToBytes(peer.sealed_sender_pub || ''), peer.signal_identity_key)
    this.markSession(peer.uin, peer.device_id)
  }

  /// Encrypt an envelope to a peer device: libsignal inner + ECIES outer to
  /// the peer's X25519 sealed-sender key. Returns the `payload` for
  /// POST /messages/sealed.
  async encryptTo(peerUin: number, peerDeviceId: number, peerOuterPub: Uint8Array, env: Envelope): Promise<string> {
    const envBytes = encodeEnvelopeBytes(env)
    const ct = await encryptMessage(envBytes, this.addr(peerUin, peerDeviceId), this.localAddr, this.sessionStore, this.identityStore)
    this.markSession(peerUin, peerDeviceId)
    const inner: InnerV2 = { from: this.uin, kind: ct.message_type === 3 ? 'prekey' : 'signal', msg: bytesToB64(ct.body) }
    if (this.deviceId !== PRIMARY_DEVICE_ID) inner.dev = this.deviceId
    // Stage 2: pad the inner plaintext to a size bucket for content kinds (same
    // scheme + buckets as v=1). The libsignal ct inside `msg` hides the message
    // but not its LENGTH; `_pad` lands the sealed blob on a bucket. Transparent
    // to old receivers, which read InnerV2 by named keys and ignore `_pad`.
    const innerBytes = shouldPadKind(env.kind)
      ? padInnerBytes(inner as unknown as Record<string, unknown>)
      : new TextEncoder().encode(JSON.stringify(inner))
    return outerWrapV2(innerBytes, peerOuterPub)
  }

  /// Decrypt an inbound v=2 payload addressed to THIS device. The sender's UIN
  /// is read from the unwrapped inner envelope (`inner.from`) — the receiver
  /// doesn't need to know it in advance (sealed sender). So is the sender's
  /// DEVICE (`inner.dev`, absent = 1): a ratchet belongs to one pair of
  /// devices, so a session addressed as (uin, 1) for a message the peer's
  /// second device sent has no state to decrypt with. Both may be passed to
  /// override/pin them.
  async decrypt(payloadB64: string, senderUin?: number, senderDeviceId?: number): Promise<{ senderUIN: number; senderDeviceId: number; envelope: Envelope }> {
    const inner = outerUnwrapV2(payloadB64, this.outerPriv, this.outerPub)
    const from = senderUin ?? inner.from
    const fromDevice = senderDeviceId ?? inner.dev ?? PRIMARY_DEVICE_ID
    const type = inner.kind === 'prekey' ? 3 : 2
    const plaintext = await decryptMessage(
      b64ToBytes(inner.msg),
      type,
      this.addr(from, fromDevice),
      this.localAddr,
      this.sessionStore,
      this.identityStore,
      this.preKeyStore,
      this.signedStore,
      this.kyberStore,
    )
    this.markSession(from, fromDevice)
    const envelope = JSON.parse(new TextDecoder().decode(plaintext)) as Envelope
    // The sending DEVICE, not just the account: the silence probe needs to know
    // which of the peer's installs is provably alive, because one of them
    // answering says nothing about a sibling whose session is dead.
    return { senderUIN: inner.from, senderDeviceId: fromDevice, envelope }
  }

  /// Snapshot this device's full libsignal state for persistence (IndexedDB).
  /// Exports the tracked sessions (which advance on every encrypt/decrypt, so
  /// re-snapshot after each). Uint8Array fields survive IndexedDB structured
  /// clone, so no base64 needed.
  async serialize(): Promise<DeviceBlob> {
    const sessions: DeviceBlob['sessions'] = []
    for (const [key, outer] of this.sessionPeers) {
      const [u, d] = key.split(':').map(Number)
      const rec = await this.sessionStore.export_session(this.addr(u, d))
      if (rec) sessions.push({ uin: u, device: d, rec, outer: outer?.pub, outerAt: outer?.at })
    }
    return {
      uin: this.uin,
      deviceId: this.deviceId,
      regId: this.regId,
      outerPriv: this.outerPriv,
      idkp: this.idkp.serialize(),
      signed: this.signedRec,
      kyber: this.kyberRec,
      prekeys: this.prekeyRecs,
      bundle: this.bundle,
      sessions,
    }
  }

  /// Rebuild a device from a persisted snapshot — SAME identity + prekeys +
  /// sessions, so peers' sessions stay valid and prior conversations decrypt.
  static async restore(blob: DeviceBlob): Promise<WebSignalDevice> {
    await ensureWasm()
    const idkp = WasmIdentityKeyPair.deserialize(blob.idkp)
    const dev = new WebSignalDevice(blob.uin, blob.deviceId, blob.outerPriv, idkp, blob.regId)
    if (blob.signed) await dev.signedStore.import_signed_pre_key(blob.signed.id, blob.signed.rec)
    if (blob.kyber) await dev.kyberStore.import_kyber_pre_key(blob.kyber.id, blob.kyber.rec)
    for (const p of blob.prekeys) await dev.preKeyStore.import_pre_key(p.id, p.rec)
    for (const s of blob.sessions) {
      await dev.sessionStore.import_session(dev.addr(s.uin, s.device), s.rec)
      // A blob written before the key carried its age says nothing about how
      // old this one is, and an outer key of unknown age is one to re-read.
      dev.markSession(s.uin, s.device, s.outer && s.outerAt ? { pub: s.outer, at: s.outerAt } : undefined)
    }
    dev.signedRec = blob.signed
    dev.kyberRec = blob.kyber
    dev.prekeyRecs = blob.prekeys
    dev.bundle = blob.bundle
    return dev
  }
}

/// Persisted device snapshot (stored in IndexedDB via signal-persist).
export interface DeviceBlob {
  uin: number
  deviceId: number
  regId: number
  outerPriv: Uint8Array
  idkp: Uint8Array
  signed?: { id: number; rec: Uint8Array }
  kyber?: { id: number; rec: Uint8Array }
  prekeys: Array<{ id: number; rec: Uint8Array }>
  /// The bundle this device published, so a republish is not a re-key. Absent
  /// in blobs written before it was kept.
  bundle?: BundleUpload
  /// `outer` is that peer device's sealed-sender key, `outerAt` when its bundle
  /// was read. Absent in blobs written before they were kept, and in sessions
  /// this device only ever received on — a send to those resolves the bundle
  /// once, as it always did.
  sessions: Array<{ uin: number; device: number; rec: Uint8Array; outer?: Uint8Array; outerAt?: number }>
}
