// Persistent sender-key chain state for the web client. Outbound chains
// (one per group I post to) + inbound chains (one per kid I've been handed
// via SKDM). Mirrors the Android SenderKeyStore / iOS SenderKeyStore shape.
//
// localStorage-backed like multihome.ts so it survives reloads and is
// node-testable with a localStorage stub. Chain keys are base64 strings on
// disk; the ratchet runs in memory.

import { b64ToBytes, bytesToB64 } from './crypto'
import { deriveMessageKey, nextChainKey, newKid, MAX_SKIP } from './sender-keys'

// v3: the OWN side is keyed by account now too. v2 scoped only the inbound
// map, so in a two-account browser `ownsKid` answered for BOTH accounts —
// account B read account A's broadcast kid as "my own echo" and silently
// dropped every group message A posted (caught live 2026-08-21: a fresh
// member saw an empty room while its chain sat un-advanced at i=0). The
// shared `out` map was the same hazard in the send direction. Migration
// keeps v2's inbound chains (already per-account, and dropping them would
// NACK-storm every group after the update); own chains are dropped — the
// next post simply rotates to a fresh kid and re-distributes.
const STORE_KEY = 'rcq.web.senderkeys.v3'
const V2_STORE_KEY = 'rcq.web.senderkeys.v2'

interface OutChainJSON {
  kid: string
  e: number
  i: number // next index to send
  ck: string // b64 chain key AT index i
  distributed: number[] // uins the current (kid,e) SKDM reached
}

interface InChainJSON {
  gid: number
  senderUin: number
  spub: string // b64 Ed25519 — gmsg sig verifies against this
  e: number
  i: number // chain position (next index ck corresponds to)
  ck: string // b64 chain key AT index i
  skipped: Record<number, string> // index -> b64 message key (out-of-order cache)
}

interface StoreJSON {
  /// ⚠⚠ EVERY map here is keyed by account ("<ownUin>:…"), for the same
  /// reason twice over.
  ///
  /// Inbound: a device with two accounts receives the SAME kid twice, once
  /// addressed to each, and each copy has its own ratchet position. Sharing
  /// one chain meant whichever account read the group first advanced it and
  /// consumed the skipped keys, and the other account then hit `i < c.i` and
  /// could open NOTHING from that point on — the founder's second account
  /// lost nine days of a group this way on iOS (2026-08-13).
  ///
  /// Own: with `owned` shared, account B answered `ownsKid` for account A's
  /// kid and dropped A's every broadcast as "my own echo" (2026-08-21); a
  /// shared `out` would likewise let two accounts fight over one ratchet.
  out: Record<string, OutChainJSON> // "<ownUin>:<gid>" -> own chain
  in: Record<string, InChainJSON> // "<ownUin>:<kid>" -> inbound chain
  owned: string[] // rolling "<ownUin>:<kid>" list (drop my own echoed gmsg)
}

const OWNED_CAP = 64

/// Inbound chains are per ACCOUNT as well as per kid — see the note on
/// `StoreJSON`.
function inKey(ownUin: number, kid: string): string {
  return `${ownUin}:${kid}`
}

/// Own chains and owned kids carry the account too.
function outKey(ownUin: number, gid: number): string {
  return `${ownUin}:${gid}`
}

function ownedKey(ownUin: number, kid: string): string {
  return `${ownUin}:${kid}`
}

function load(): StoreJSON {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      return { out: p.out ?? {}, in: p.in ?? {}, owned: p.owned ?? [] }
    }
    // One-time v2 lift: carry the inbound chains over (they were already
    // per-account, and dropping them would NACK-storm every group), leave
    // the unattributable own side behind.
    const v2raw = localStorage.getItem(V2_STORE_KEY)
    if (v2raw) {
      const p = JSON.parse(v2raw)
      const lifted: StoreJSON = { out: {}, in: p.in ?? {}, owned: [] }
      save(lifted)
      localStorage.removeItem(V2_STORE_KEY)
      return lifted
    }
  } catch {
    /* corrupt / unavailable — start fresh */
  }
  return { out: {}, in: {}, owned: [] }
}

function save(s: StoreJSON): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s))
  } catch {
    /* quota / unavailable — best effort */
  }
}

export interface OwnChainStep {
  kid: string
  e: number
  i: number
  mk: Uint8Array // message key for index i (already derived)
  /// Members who still need this chain's SKDM (adds + first send, or
  /// everyone after a rotation). Empty once everyone has it.
  needDistribution: number[]
  /// The chain key AT index i, base64 — what an SKDM to a new member carries
  /// (so they can ratchet forward from here, never seeing earlier messages).
  ckAtI: string
}

/// Resolve the outbound chain for a group send. Rotates (fresh kid, e+1,
/// i=0) when anyone in `distributed` is no longer capable (left/removed) so
/// the departed member can't read future messages, then returns the message
/// key for the current index and who still needs the SKDM. After the caller
/// ships the message it MUST call `advanceOwn(gid)`.
export function prepareOwnSend(ownUin: number, gid: number, capableUins: number[]): OwnChainStep {
  const s = load()
  const capable = new Set(capableUins)
  const k = outKey(ownUin, gid)
  let c = s.out[k]
  const rotate = !c || c.distributed.some((u) => !capable.has(u))
  if (rotate) {
    const ck = bytesToB64(crypto.getRandomValues(new Uint8Array(32)))
    c = { kid: newKid(), e: (c?.e ?? -1) + 1, i: 0, ck, distributed: [] }
    const ok = ownedKey(ownUin, c.kid)
    s.owned = [ok, ...s.owned.filter((x) => x !== ok)].slice(0, OWNED_CAP)
  }
  const ckBytes = b64ToBytes(c.ck)
  const mk = deriveMessageKey(ckBytes)
  const need = capableUins.filter((u) => !c!.distributed.includes(u))
  s.out[k] = c
  save(s)
  return { kid: c.kid, e: c.e, i: c.i, mk, needDistribution: need, ckAtI: c.ck }
}

/// Mark members as having received the current chain's SKDM (so we don't
/// re-seal it to them on every send — distribution is once per epoch).
export function markDistributed(ownUin: number, gid: number, uins: number[]): void {
  const s = load()
  const c = s.out[outKey(ownUin, gid)]
  if (!c) return
  const set = new Set(c.distributed)
  uins.forEach((u) => set.add(u))
  c.distributed = [...set]
  save(s)
}

/// Ratchet the outbound chain one step forward after a successful send.
export function advanceOwn(ownUin: number, gid: number): void {
  const s = load()
  const c = s.out[outKey(ownUin, gid)]
  if (!c) return
  c.ck = bytesToB64(nextChainKey(b64ToBytes(c.ck)))
  c.i += 1
  save(s)
}

/// Store (or refresh) an inbound chain handed to us via SKDM. Binds the kid
/// to the authenticated sender; a second SKDM for a known kid from a
/// DIFFERENT sender is rejected (returns false).
export function acceptSkdm(
  ownUin: number,
  kid: string,
  gid: number,
  senderUin: number,
  spub: string,
  e: number,
  i: number,
  ck: string,
): boolean {
  const s = load()
  const k = inKey(ownUin, kid)
  const existing = s.in[k]
  if (existing && existing.senderUin !== senderUin) return false
  // A resent SKDM for the same kid/epoch at an OLDER index would rewind the
  // ratchet — keep the most-advanced position we already hold.
  if (existing && existing.e === e && existing.i >= i) {
    existing.spub = spub
    save(s)
    return true
  }
  s.in[k] = { gid, senderUin, spub, e, i, ck, skipped: {} }
  save(s)
  return true
}

export interface InboundKey {
  mk: Uint8Array
  spub: string
  senderUin: number
}

/// Derive the message key for (kid, e, i), ratcheting forward and caching
/// skipped keys for out-of-order delivery. Returns null when the kid is
/// unknown (caller should NACK), the epoch doesn't match, the index is in
/// the past with no cached key (replay/dupe), or it's beyond MAX_SKIP.
export function deriveInbound(ownUin: number, kid: string, e: number, i: number): InboundKey | null {
  const s = load()
  const c = s.in[inKey(ownUin, kid)]
  if (!c || c.e !== e) return null

  const cached = c.skipped[i]
  if (cached) {
    delete c.skipped[i]
    save(s)
    return { mk: b64ToBytes(cached), spub: c.spub, senderUin: c.senderUin }
  }
  if (i < c.i) return null // already past it, no cached key → replay/dupe
  if (i - c.i > MAX_SKIP) return null // too far ahead → NACK for a fresh SKDM

  let ck = b64ToBytes(c.ck)
  for (let idx = c.i; idx < i; idx++) {
    c.skipped[idx] = bytesToB64(deriveMessageKey(ck))
    ck = nextChainKey(ck)
  }
  const mk = deriveMessageKey(ck)
  c.ck = bytesToB64(nextChainKey(ck))
  c.i = i + 1
  save(s)
  return { mk, spub: c.spub, senderUin: c.senderUin }
}

export function knowsKid(ownUin: number, kid: string): boolean {
  return !!load().in[inKey(ownUin, kid)]
}

/// True if THIS ACCOUNT on this device created `kid` (so a gmsg under it is
/// my own message echoed back by the server — own multi-device sync rides
/// carbons, drop it). Account-scoped: the sibling account in this browser
/// must NOT treat my kid as its own echo, that is how it went deaf.
export function ownsKid(ownUin: number, kid: string): boolean {
  return load().owned.includes(ownedKey(ownUin, kid))
}

/// The kid this account currently owns for a group (for answering a NACK).
export function ownKidForGroup(ownUin: number, gid: number): string | null {
  return load().out[outKey(ownUin, gid)]?.kid ?? null
}

/// Re-seal data for answering a NACK: the current chain key + position so we
/// can hand a requester an SKDM that lets them read from here forward.
export function ownChainSnapshot(
  ownUin: number,
  gid: number,
): { kid: string; e: number; i: number; ck: string } | null {
  const c = load().out[outKey(ownUin, gid)]
  return c ? { kid: c.kid, e: c.e, i: c.i, ck: c.ck } : null
}
