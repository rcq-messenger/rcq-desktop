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
export function putRoomKey(gid: number, ver: number, keyB64: string): boolean {
  const cur = keys.get(gid)
  if (cur && cur.v >= ver) return false
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

export async function sealRoomState(state: SealedRoomState, keyB64: string): Promise<string> {
  const plain = new TextEncoder().encode(JSON.stringify(state))
  const deflated = await pipeThrough(plain, new CompressionStream('deflate-raw'))
  const key = await crypto.subtle.importKey('raw', b64ToBytes(keyB64) as BufferSource, 'AES-GCM', false, ['encrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, deflated as BufferSource),
  )
  const out = new Uint8Array(nonce.length + ct.length)
  out.set(nonce)
  out.set(ct, nonce.length)
  return bytesToB64(out)
}

export async function openRoomState(blobB64: string, keyB64: string): Promise<SealedRoomState | null> {
  try {
    const blob = b64ToBytes(blobB64)
    if (blob.length < 13) return null
    const key = await crypto.subtle.importKey('raw', b64ToBytes(keyB64) as BufferSource, 'AES-GCM', false, ['decrypt'])
    const deflated = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: blob.slice(0, 12) as BufferSource },
        key,
        blob.slice(12) as BufferSource,
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
): Promise<{ k: string; v: number }> {
  const existing = roomKey(gid)
  if (existing) return existing
  const fresh = bytesToB64(crypto.getRandomValues(new Uint8Array(32)))
  putRoomKey(gid, 1, fresh)
  let n = 0
  for (const m of members) {
    if (m.uin === identity.uin || !m.identity_key) continue
    try {
      await sendKeyTo(identity, m, gid, 1, fresh)
    } catch {
      /* they will gsknack */
    }
    if (++n % YIELD_EVERY === 0) await uiYield()
  }
  return { k: fresh, v: 1 }
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
  const blob = await sealRoomState(state, k.k)
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
