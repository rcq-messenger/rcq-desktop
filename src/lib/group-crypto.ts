// Group send fan-out. Mirrors iOS `MessageService.sendGroupEnvelope`:
// the sender encrypts the same plaintext envelope ONCE PER MEMBER
// using each recipient's identity key, then ships the resulting
// `[{to_uin, payload}, ...]` list in one POST. Self is excluded —
// my own outgoing log lives in this browser session, no need to
// echo a copy back through the server.
//
// All v=1 (Stage 2) — same envelope format the 1:1 path uses.
// Stage 3 (libsignal) groups would ride a single Sender Key
// distribution, but that's deferred to phase-5 alongside
// libsignal-WASM.

import { b64ToBytes, bytesToB64, encryptV1, type Envelope, type WebIdentity } from './crypto'
import type { GroupMember } from './api'
import { sealGmsg } from './sender-keys'
import { advanceOwn, markDistributed, prepareOwnSend } from './sender-key-store'

export interface GroupPayload {
  to_uin: number
  payload: string
}

/// A member we couldn't encrypt to, with the reason. Returned so the
/// caller can surface "delivered to N of M" instead of silently
/// dropping people — and so a single bad key never sinks the whole
/// send (the failure mode the founder hit: a member with an empty /
/// zero identity_key threw out of `@noble/curves` x25519 and aborted
/// the entire group message).
export interface SkippedMember {
  uin: number
  reason: string
}

export interface GroupEncryptResult {
  payloads: GroupPayload[]
  skipped: SkippedMember[]
}

/// True only for a usable X25519 public key: base64 that decodes to
/// exactly 32 bytes that aren't all-zero. An empty or zero key is the
/// classic placeholder that makes `x25519.getSharedSecret` throw
/// "invalid private or public key received". We reject those up front
/// (and still try/catch the encrypt for low-order points noble guards
/// against internally).
function isUsableIdentityKey(b64: string): boolean {
  if (!b64) return false
  let bytes: Uint8Array
  try {
    bytes = b64ToBytes(b64)
  } catch {
    return false
  }
  if (bytes.length !== 32) return false
  // All-zero point — never a real key.
  return bytes.some((x) => x !== 0)
}


/// The fan-out arithmetic, two roads.
///
/// PREFERRED: a small Worker pool (below). One `encryptV1` is an X25519 +
/// ChaCha + Ed25519 step in JS; a room with a ~950-member legacy tail on a
/// slow Windows desktop is 5-10ms EACH, and even a politely yielding
/// main-thread loop reads as "приложение висит, часы" for many seconds
/// (31.08). Workers take it off the UI thread entirely and onto several
/// cores at once - the roster is sharded across the pool.
///
/// FALLBACK: the inline loop, yielding on a CLOCK. The item-count yield the
/// 29.08 fix used (every 24) was measured on a fast mac; on the reporter's
/// box 24 encryptions were a quarter second of held frames, which is where
/// the busy cursor lives. 8ms keeps every chunk under a frame. The fallback
/// serves three callers: Node (the CLI has no Worker and no frames to
/// hold), a WebView whose Worker construction failed, and small sends where
/// the worker hop costs more than it saves.
const INLINE_CHUNK_MS = 8
/// Below this many targets the pool is not worth waking: the postMessage
/// round trip plus structured-clone beats the crypto itself.
const OFFMAIN_MIN_TARGETS = 48
function uiYield(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

interface SealTarget {
  uin: number
  identityKey: string
  signingKey: string
}

interface SealBatch {
  payloads: GroupPayload[]
  skipped: SkippedMember[]
}

/// undefined = never built; null = tried and unavailable (Node, or the
/// WebView refused) - never retried this run except after a worker error,
/// which burns the pool back to undefined so the next send rebuilds it.
let sealPool: Worker[] | null | undefined
let sealReqSeq = 0

function getSealPool(): Worker[] | null {
  if (sealPool !== undefined) return sealPool
  try {
    if (typeof Worker === 'undefined') {
      sealPool = null
      return null
    }
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
    const n = Math.max(1, Math.min(4, cores - 1))
    sealPool = Array.from(
      { length: n },
      () => new Worker(new URL('./group-seal.worker.ts', import.meta.url), { type: 'module' }),
    )
  } catch {
    sealPool = null
  }
  return sealPool
}

function sealOnWorker(w: Worker, envelope: Envelope, sender: WebIdentity, targets: SealTarget[]): Promise<SealBatch> {
  const reqId = ++sealReqSeq
  return new Promise<SealBatch>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.reqId !== reqId) return // another send's answer on the shared pool
      cleanup()
      resolve({ payloads: e.data.payloads, skipped: e.data.skipped })
    }
    const onErr = (e: ErrorEvent) => {
      cleanup()
      reject(e.error ?? new Error(e.message || 'seal worker failed'))
    }
    const cleanup = () => {
      w.removeEventListener('message', onMsg)
      w.removeEventListener('error', onErr)
    }
    w.addEventListener('message', onMsg)
    w.addEventListener('error', onErr)
    w.postMessage({ reqId, envelope, sender, targets })
  })
}

/// Seal `envelope` to every target: the pool when it exists and the job is
/// big enough, the clock-yielding inline loop otherwise. Never throws for a
/// single bad member - those land in `skipped`, exactly as before.
async function sealToTargets(envelope: Envelope, sender: WebIdentity, targets: SealTarget[]): Promise<SealBatch> {
  const pool = getSealPool()
  if (pool && targets.length >= OFFMAIN_MIN_TARGETS) {
    const shard = Math.ceil(targets.length / pool.length)
    try {
      const parts = await Promise.all(
        pool.map((w, i) => {
          const slice = targets.slice(i * shard, (i + 1) * shard)
          if (slice.length === 0) return Promise.resolve<SealBatch>({ payloads: [], skipped: [] })
          return sealOnWorker(w, envelope, sender, slice)
        }),
      )
      return {
        payloads: parts.flatMap((p) => p.payloads),
        skipped: parts.flatMap((p) => p.skipped),
      }
    } catch (e) {
      // A dead worker must not lose a message: burn the pool (rebuilt on
      // the next send) and do this one on the main thread.
      console.warn('[group-send] seal pool failed, sealing inline:', e)
      for (const w of pool) {
        try {
          w.terminate()
        } catch {
          /* already gone */
        }
      }
      sealPool = undefined
    }
  }
  const payloads: GroupPayload[] = []
  const skipped: SkippedMember[] = []
  let chunkStart = Date.now()
  for (const m of targets) {
    if (Date.now() - chunkStart > INLINE_CHUNK_MS) {
      await uiYield()
      chunkStart = Date.now()
    }
    try {
      payloads.push({
        to_uin: m.uin,
        payload: encryptV1(envelope, sender, {
          uin: m.uin,
          identityKey: m.identityKey,
          signingKey: m.signingKey,
        }),
      })
    } catch (e) {
      skipped.push({ uin: m.uin, reason: e instanceof Error ? e.message : 'encrypt_failed' })
    }
  }
  return { payloads, skipped }
}

/// Build the per-member ciphertext list for a group send. Skips the
/// caller themselves (`sender.uin`) and any member whose identity key
/// is missing/invalid (collected in `skipped` rather than thrown) so
/// one bad member can't fail delivery to everyone else.
export async function encryptGroupEnvelope(
  envelope: Envelope,
  sender: WebIdentity,
  members: GroupMember[],
): Promise<GroupEncryptResult> {
  const skipped: SkippedMember[] = []
  const targets: SealTarget[] = []
  for (const m of members) {
    if (m.uin === sender.uin) continue
    if (!isUsableIdentityKey(m.identity_key)) {
      skipped.push({ uin: m.uin, reason: 'invalid_identity_key' })
      continue
    }
    targets.push({ uin: m.uin, identityKey: m.identity_key, signingKey: m.signing_key })
  }
  const sealed = await sealToTargets(envelope, sender, targets)
  const payloads = sealed.payloads
  skipped.push(...sealed.skipped)
  if (skipped.length > 0) {
    // Surface in the console so a recurring bad member is diagnosable
    // (which UIN, why) without blocking the send.
    console.warn('[group-send] skipped members with unusable keys:', skipped)
  }
  return { payloads, skipped }
}


/// One group send at a time per gid. Two quick sends used to be able to
/// interleave at the network awaits (and now at the uiYield points too):
/// both called prepareOwnSend before either committed, sealing two
/// different messages under the SAME chain step, which a receiver can
/// only read as a replay. The lock serializes build + POST + commit, so
/// the SKDM-before-gmsg ordering holds across sends as well.
const groupSendLocks = new Map<number, Promise<unknown>>()
export function withGroupSendLock<T>(gid: number, fn: () => Promise<T>): Promise<T> {
  const prev = groupSendLocks.get(gid) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  groupSendLocks.set(gid, run.catch(() => {}))
  return run
}

export interface GroupDualSend {
  /// base64(JSON gmsg wire) — ONE ciphertext for the whole group. Null when
  /// nobody in the group is sender-keys-capable (pure legacy send).
  broadcastPayload: string | null
  /// SKDMs to seal to capable members who don't yet hold this chain (rides
  /// /messages/group-sealed, envelope_type "skdm"). Empty once distributed.
  skdmPayloads: GroupPayload[]
  /// Per-member ciphertexts for NON-capable members (legacy fan-out). Empty
  /// when every member is capable.
  legacyPayloads: GroupPayload[]
  skipped: SkippedMember[]
  /// MUST be called after the broadcast POST succeeds: marks the SKDM
  /// recipients as distributed and ratchets the outbound chain one step.
  commit: () => void
}

/// Build the dual-send for a group message: encrypt ONCE for every capable
/// member (broadcast) + SKDMs for capable members still missing the chain +
/// the legacy per-member fan-out for non-capable members. Rotates the
/// outbound chain when a previously-distributed member is gone (forward
/// secrecy). `gid` is the SERVER group id (the chain is keyed by it).
export async function buildGroupDualSend(
  envelope: Envelope,
  sender: WebIdentity,
  gid: number,
  members: GroupMember[],
): Promise<GroupDualSend> {
  const skipped: SkippedMember[] = []
  const capable: GroupMember[] = []
  const legacy: GroupMember[] = []
  for (const m of members) {
    if (m.uin === sender.uin) continue
    if (!isUsableIdentityKey(m.identity_key)) {
      skipped.push({ uin: m.uin, reason: 'invalid_identity_key' })
      continue
    }
    if (m.sender_keys) capable.push(m)
    else legacy.push(m)
  }

  // Legacy fan-out (unchanged path) for everyone without the capability.
  const legacySealed = await sealToTargets(
    envelope,
    sender,
    legacy.map((m) => ({ uin: m.uin, identityKey: m.identity_key, signingKey: m.signing_key })),
  )
  const legacyPayloads = legacySealed.payloads
  skipped.push(...legacySealed.skipped)

  if (capable.length === 0) {
    return { broadcastPayload: null, skdmPayloads: [], legacyPayloads, skipped, commit: () => {} }
  }

  // Encrypt once under the outbound chain's current message key.
  const capableUins = capable.map((m) => m.uin)
  const step = prepareOwnSend(sender.uin, gid, capableUins)
  const gmsg = sealGmsg(envelope, sender, gid, step.kid, step.e, step.i, step.mk)
  const broadcastPayload = bytesToB64(new TextEncoder().encode(JSON.stringify(gmsg)))

  // SKDM to capable members who don't hold (kid, epoch) yet.
  const needSkdm = capable.filter((m) => step.needDistribution.includes(m.uin))
  const skdmSealed = await sealToTargets(
    { kind: 'skdm', gid, kid: step.kid, e: step.e, i: step.i, ck: step.ckAtI },
    sender,
    needSkdm.map((m) => ({ uin: m.uin, identityKey: m.identity_key, signingKey: m.signing_key })),
  )
  const skdmPayloads = skdmSealed.payloads
  const distributedNow = skdmSealed.payloads.map((p) => p.to_uin)
  for (const sk of skdmSealed.skipped) skipped.push({ uin: sk.uin, reason: 'skdm_failed' })

  return {
    broadcastPayload,
    skdmPayloads,
    legacyPayloads,
    skipped,
    commit: () => {
      if (distributedNow.length > 0) markDistributed(sender.uin, gid, distributedNow)
      advanceOwn(sender.uin, gid)
    },
  }
}
