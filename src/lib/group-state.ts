/// Sealed room identity, the client half (stage 6 phase 2).
///
/// The island stores an opaque blob and does version arithmetic
/// (`PATCH /groups/{id}/state`, the vault's #605 rule); everything readable
/// lives here. The room state key (RSK) is one AES-256-GCM key per room:
/// members receive it sealed 1:1 (inner kind `gskey` riding the outer type
/// "skdm", which the island already files as critical), a joiner by link
/// reads it from the URL fragment, and a member who lost it asks anyone
/// (`gsknack` riding "sknack"). Design: rcq-docs/group-state-seal-design.md.
///
/// The blob is JSON -> raw deflate -> AES-256-GCM, 12-byte nonce prefixed.
/// Raw deflate ("deflate-raw") is the one framing all four clients share:
/// Android's Deflater(nowrap=true) and Apple's COMPRESSION_ZLIB both speak
/// it, and the browser has it natively in CompressionStream.

import { Api, peerBundleFrom } from './api'
import type { GroupMember, RCQGroup } from './api'
import { encryptV1, bytesToB64, b64ToBytes, type Envelope, type WebIdentity } from './crypto'
import { readSlot, writeSlot, slotId, lastSeenVersion, rememberVersion, VaultError } from './vault'

// ── the key store ────────────────────────────────────────────────────────
// Per-account, gid -> {k: b64 key, v: version}. localStorage survives the
// tab; the vault mirror (follow-up) survives the browser.

let _uin: number | null = null
let keys = new Map<number, { k: string; v: number }>()

const storeKey = (uin: number) => `rcq.web.gskeys.${uin}`

export function loadRoomKeys(uin: number): void {
  _uin = uin
  keys = new Map()
  try {
    const raw = localStorage.getItem(storeKey(uin))
    if (raw) {
      for (const [gid, e] of Object.entries(JSON.parse(raw) as Record<string, { k: string; v: number }>)) {
        keys.set(Number(gid), e)
      }
    }
  } catch {
    /* an unreadable store is an empty one */
  }
}

function persist(): void {
  if (_uin == null) return
  try {
    localStorage.setItem(storeKey(_uin), JSON.stringify(Object.fromEntries(keys)))
  } catch {
    /* best effort */
  }
}

export function roomKey(gid: number): { k: string; v: number } | null {
  return keys.get(gid) ?? null
}

/// Store a key. Monotonic: an older version never overwrites a newer one,
/// so a slow gskey crossing paths with a rotation cannot roll a room back.
export function putRoomKey(
  gid: number,
  ver: number,
  keyB64: string,
  opts: { replaceEqual?: boolean } = {},
): boolean {
  const cur = keys.get(gid)
  // Monotonic - with one live-caught exception. Two mints can carry the SAME
  // version (the owner lost an unmirrored key and minted again; both fanned
  // as v1), and a strict >= wedged every receiver on whichever copy arrived
  // first, forever. A gskey passes the roster gate before it gets here, so
  // for equal versions the LATEST member-sent key may replace the stored one
  // when the caller says so; an older version still never rolls anyone back.
  if (cur && (cur.v > ver || (cur.v === ver && (!opts.replaceEqual || cur.k === keyB64)))) return false
  keys.set(gid, { k: keyB64, v: ver })
  persist()
  return true
}

// ── blob crypto ──────────────────────────────────────────────────────────

export interface SealedRoomState {
  v: 1
  name: string
  description?: string
  avatar_media_id?: string
  avatar_media_key?: string
  pinned_text?: string
  pinned_at?: string
  pinned_by?: number
}

async function pipeThrough(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const src = new Blob([bytes as BlobPart]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(src).arrayBuffer())
}

/// Blob layout: [0x02][keyVer u32 BE][nonce 12][ciphertext]. The key VERSION
/// rides in the open on purpose - it is the one fact a client with no key
/// needs: which key to ask for, and, for an owner who lost theirs, what the
/// replacement's version must EXCEED. Without it a re-mint after a loss came
/// out as v1 again, and monotonic receivers wedged on whichever v1 landed
/// first (caught live, web against CLI, 30.08). The island learns a small
/// integer that only ever counts rotations; it already sees state_ver beside
/// it counting writes.
const BLOB_V2 = 0x02

export async function sealRoomState(state: SealedRoomState, keyB64: string, keyVer: number): Promise<string> {
  const plain = new TextEncoder().encode(JSON.stringify(state))
  const deflated = await pipeThrough(plain, new CompressionStream('deflate-raw'))
  const key = await crypto.subtle.importKey('raw', b64ToBytes(keyB64) as BufferSource, 'AES-GCM', false, ['encrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, deflated as BufferSource),
  )
  const out = new Uint8Array(5 + nonce.length + ct.length)
  out[0] = BLOB_V2
  new DataView(out.buffer).setUint32(1, keyVer >>> 0)
  out.set(nonce, 5)
  out.set(ct, 5 + nonce.length)
  return bytesToB64(out)
}

/// The key version a blob was sealed under, readable WITHOUT the key.
/// Null for the pre-versioned format (a handful of test blobs).
export function sealedKeyVer(blobB64: string): number | null {
  try {
    const b = b64ToBytes(blobB64)
    if (b.length < 18 || b[0] !== BLOB_V2) return null
    return new DataView(b.buffer, b.byteOffset).getUint32(1)
  } catch {
    return null
  }
}

export async function openRoomState(blobB64: string, keyB64: string): Promise<SealedRoomState | null> {
  try {
    const blob = b64ToBytes(blobB64)
    if (blob.length < 13) return null
    // v2 carries [tag][keyVer u32] before the nonce; the first format put the
    // nonce at offset 0.
    const off = blob[0] === BLOB_V2 && blob.length >= 18 ? 5 : 0
    const key = await crypto.subtle.importKey('raw', b64ToBytes(keyB64) as BufferSource, 'AES-GCM', false, ['decrypt'])
    const deflated = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: blob.slice(off, off + 12) as BufferSource },
        key,
        blob.slice(off + 12) as BufferSource,
      ),
    )
    const plain = await pipeThrough(deflated, new DecompressionStream('deflate-raw'))
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as SealedRoomState
    return parsed && parsed.v === 1 && typeof parsed.name === 'string' ? parsed : null
  } catch {
    // A key from before a rotation, a truncated blob - either way there is
    // nothing to render, and the caller falls back to the open columns.
    return null
  }
}

// ── applying what the island cannot read ────────────────────────────────

/// Overlay the sealed identity onto a group we hold the key for. Falls back
/// to the row exactly as served (the open columns) when there is no blob, no
/// key, or the key does not fit - old clients and new rooms look the same.
export async function applySealedState<T extends RCQGroup>(g: T): Promise<T> {
  if (!g.state_blob || !g.id) return g
  const k = roomKey(g.id)
  if (!k) return g
  const state = await openRoomState(g.state_blob, k.k)
  if (!state) return g
  return {
    ...g,
    name: state.name || g.name,
    description: state.description ?? g.description,
    avatar_media_id: state.avatar_media_id ?? g.avatar_media_id,
    avatar_media_key: state.avatar_media_key ?? g.avatar_media_key,
    pinned_text: state.pinned_text ?? g.pinned_text,
    pinned_at: state.pinned_at ?? g.pinned_at,
    pinned_by: state.pinned_by ?? g.pinned_by,
  }
}

export async function applySealedStateAll<T extends RCQGroup>(groups: T[]): Promise<T[]> {
  return Promise.all(groups.map((g) => applySealedState(g)))
}

// ── handing the key to members ──────────────────────────────────────────

/// Yield cadence for a member fan-out on the main thread - same rhythm the
/// group send loops use (the H6 lesson: 2000 seals without a breath is a
/// frozen window).
const YIELD_EVERY = 24
const uiYield = () => new Promise<void>((r) => setTimeout(r, 0))

/// Seal `gskey` to one member, outer type "skdm" (critical class: losing
/// this key makes the room unreadable, the same stakes as a sender chain).
async function sendKeyTo(
  identity: WebIdentity,
  member: { uin: number; identity_key: string; signing_key?: string | null },
  gid: number,
  ver: number,
  keyB64: string,
): Promise<void> {
  const env: Envelope = { kind: 'gskey', gid, ver, key: keyB64 }
  const bundle = peerBundleFrom({
    uin: member.uin,
    identity_key: member.identity_key,
    signing_key: member.signing_key ?? '',
  })
  const wire = encryptV1(env, identity, bundle)
  await Api.sendSealed(identity, member.uin, wire, 'skdm')
}

/// Make sure this room has a key, minting and distributing one when it does
/// not. Returns the key either way. Minting fans the key to every member
/// with an identity key, self excluded; failures are per-member best-effort
/// (a member who missed it asks back with gsknack).
export async function ensureRoomKey(
  identity: WebIdentity,
  gid: number,
  members: GroupMember[],
  existingBlobB64?: string | null,
): Promise<{ k: string; v: number }> {
  const existing = roomKey(gid)
  if (existing) return existing
  // Before minting, look in the vault: "no key locally" and "no key" are
  // different claims, and the second mint of the same version is exactly the
  // wedge the live web-vs-CLI test caught.
  try {
    await syncRoomKeysWithVault(identity)
  } catch {
    /* offline - the mint below still does the right thing via the blob ver */
  }
  const recovered = roomKey(gid)
  if (recovered) return recovered
  // A blob already exists: its open prefix says which key generation sealed
  // it, and the replacement must be a ROTATION above it, or every holder of
  // the old key ignores the new one as stale.
  const ver = existingBlobB64 ? (sealedKeyVer(existingBlobB64) ?? 0) + 1 : 1
  const fresh = bytesToB64(crypto.getRandomValues(new Uint8Array(32)))
  putRoomKey(gid, ver, fresh)
  let n = 0
  for (const m of members) {
    if (m.uin === identity.uin || !m.identity_key) continue
    try {
      await sendKeyTo(identity, m, gid, ver, fresh)
    } catch {
      /* they will gsknack */
    }
    if (++n % YIELD_EVERY === 0) await uiYield()
  }
  return { k: fresh, v: ver }
}

/// Answer a member who asked for the key (gsknack). The caller has already
/// checked the asker is in the room's roster.
export async function answerKeyAsk(
  identity: WebIdentity,
  asker: { uin: number; identity_key: string; signing_key?: string | null },
  gid: number,
): Promise<void> {
  const k = roomKey(gid)
  if (!k) return
  await sendKeyTo(identity, asker, gid, k.v, k.k)
}

// ── asking for a key we do not hold ─────────────────────────────────────

/// Once per room per six hours: a blob we cannot open is worth one ask, not
/// a drumbeat. Persisted so a reload does not reset the clock.
const ASK_EVERY_MS = 6 * 3600 * 1000
const askKey = (uin: number) => `rcq.web.gsknack.${uin}`

function shouldAsk(uin: number, gid: number): boolean {
  try {
    const m = JSON.parse(localStorage.getItem(askKey(uin)) || '{}') as Record<string, number>
    if (Date.now() - (m[gid] ?? 0) < ASK_EVERY_MS) return false
    m[gid] = Date.now()
    localStorage.setItem(askKey(uin), JSON.stringify(m))
    return true
  } catch {
    return true
  }
}

/// Seal a `gsknack` to the members most likely to hold the key: the owner
/// first (they minted it), then up to two admins. Fire-and-forget - any one
/// answer is enough, and the reply lands as an ordinary gskey.
///
/// Asks not only when we hold NO key, but when the key we hold does not
/// open the blob - the live web-vs-CLI wedge was exactly a stored key of
/// the right version and the wrong bytes, and without this second trigger
/// nothing would ever have repaired it.
export async function askForRoomKey(identity: WebIdentity, g: RCQGroup): Promise<void> {
  if (!g.state_blob || !g.members?.length) return
  const held = roomKey(g.id)
  if (held && (await openRoomState(g.state_blob, held.k)) !== null) return
  if (!shouldAsk(identity.uin, g.id)) return
  const holders = [
    g.members.find((m) => m.uin === g.owner_uin),
    ...g.members.filter((m) => m.role === 'admin' && m.uin !== g.owner_uin).slice(0, 2),
  ].filter((m): m is GroupMember => !!m?.identity_key && m.uin !== identity.uin)
  for (const h of holders) {
    try {
      const env: Envelope = { kind: 'gsknack', gid: g.id }
      const wire = encryptV1(env, identity, peerBundleFrom({
        uin: h.uin,
        identity_key: h.identity_key,
        signing_key: h.signing_key ?? '',
      }))
      void Api.sendSealed(identity, h.uin, wire, 'sknack').catch(() => undefined)
    } catch {
      /* the next six-hour window tries again */
    }
  }
}

// ── rotation ────────────────────────────────────────────────────────────

/// After a kick: mint version+1, re-seal the blob under it, and fan the new
/// key to the REMAINING roster. The evicted member knew the old name anyway;
/// what rotation protects is everything the room becomes after them. On a
/// voluntary leave this is deliberately NOT automatic (the design doc says
/// why); the owner forces it by kicking nobody - i.e. this function is the
/// whole mechanism either way.
export async function rotateRoomKey(
  identity: WebIdentity,
  g: RCQGroup,
  remaining: GroupMember[],
): Promise<void> {
  const cur = roomKey(g.id)
  if (!cur) return
  const ver = cur.v + 1
  const fresh = bytesToB64(crypto.getRandomValues(new Uint8Array(32)))
  putRoomKey(g.id, ver, fresh)
  let n = 0
  for (const m of remaining) {
    if (m.uin === identity.uin || !m.identity_key) continue
    try {
      await sendKeyTo(identity, m, g.id, ver, fresh)
    } catch {
      /* gsknack covers stragglers */
    }
    if (++n % YIELD_EVERY === 0) await uiYield()
  }
  await writeSealedState(identity, g)
}

// ── writing the sealed identity ─────────────────────────────────────────

/// Build the blob from the group's current identity fields and write it
/// under the #605 rule. On a 409 the island tells us the version it holds;
/// one re-read + retry, then give up quietly (the next settings save tries
/// again). Never called for catalog rooms: their identity is public on
/// purpose.
export async function writeSealedState(identity: WebIdentity, g: RCQGroup): Promise<boolean> {
  const k = roomKey(g.id)
  if (!k) return false
  const state: SealedRoomState = {
    v: 1,
    name: g.name,
    description: g.description ?? undefined,
    avatar_media_id: g.avatar_media_id ?? undefined,
    avatar_media_key: g.avatar_media_key ?? undefined,
    pinned_text: g.pinned_text ?? undefined,
    pinned_at: g.pinned_at ?? undefined,
    pinned_by: g.pinned_by ?? undefined,
  }
  const blob = await sealRoomState(state, k.k, k.v)
  const attempt = (ver: number) => Api.patchGroupState(identity, g.id, blob, ver)
  try {
    await attempt((g.state_ver ?? 0) + 1)
    return true
  } catch {
    try {
      const fresh = await Api.group(identity, g.id)
      await attempt((fresh.state_ver ?? 0) + 1)
      return true
    } catch {
      return false
    }
  }
}

// ── the vault mirror ────────────────────────────────────────────────────
// Room keys must outlive one browser: a second device and a recovery drain
// the same vault slot the contacts mirror uses (stage 4a machinery). The
// slot holds {gid: {k, v}}; merging is a per-gid version max, so two
// devices writing concurrently lose nothing and a rotation always wins.

export const VAULT_GSKEYS = 'gskeys'

function mergeKeyMaps(
  a: Record<string, { k: string; v: number }>,
  b: Record<string, { k: string; v: number }>,
): Record<string, { k: string; v: number }> {
  const out = { ...a }
  for (const [gid, e] of Object.entries(b)) {
    const cur = out[gid]
    if (!cur || e.v > cur.v) out[gid] = e
  }
  return out
}

/// Pull the slot, fold it into the local store, and push back whatever the
/// island was missing. Called from the vault sweep beside contacts and
/// sections; quiet on every failure - the localStorage copy keeps working.
export async function syncRoomKeysWithVault(identity: WebIdentity): Promise<void> {
  const slot = slotId(identity, VAULT_GSKEYS)
  const local = Object.fromEntries([...keys.entries()].map(([g, e]) => [String(g), e]))
  try {
    const r = await readSlot(identity, slot, lastSeenVersion(slot))
    const remote = r.plaintext?.length
      ? (JSON.parse(new TextDecoder().decode(r.plaintext)) as Record<string, { k: string; v: number }>)
      : {}
    rememberVersion(slot, r.version)
    const folded = mergeKeyMaps(remote, local)
    // Fold the remote half into memory first: a key another device minted is
    // usable the moment the sweep lands, not after the next reload.
    let gained = false
    for (const [gid, e] of Object.entries(folded)) {
      if (putRoomKey(Number(gid), e.v, e.k)) gained = true
    }
    if (gained) {
      try {
        window.dispatchEvent(new Event('rcq-room-keys-changed'))
      } catch {
        /* no window in the CLI build */
      }
    }
    // The island is missing something of ours: push the fold. The merge
    // callback re-folds against whatever version the write races with.
    if (JSON.stringify(folded) !== JSON.stringify(remote)) {
      const seen = await writeSlot(identity, slot, (cur) => {
        const base = cur?.length
          ? (JSON.parse(new TextDecoder().decode(cur)) as Record<string, { k: string; v: number }>)
          : {}
        return new TextEncoder().encode(JSON.stringify(mergeKeyMaps(base, folded)))
      }, lastSeenVersion(slot))
      rememberVersion(slot, seen)
    }
  } catch (e) {
    if (!(e instanceof VaultError)) {
      /* network - the next sweep retries */
    }
  }
}
