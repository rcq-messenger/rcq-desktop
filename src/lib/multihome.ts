// Federation Layer B — MULTIHOMING (v1).
//
// A multi-homed account lives on ≥2 islands at once: the PRIMARY (the island
// this app is logged into — the flagship for normal accounts) plus backup
// islands, registered with the SAME X25519+Ed25519 keypair. Identity is the
// key; the per-island uin is just a local handle, so the same person holds a
// different uin on each island. The signed home-island record lists every
// home, senders deposit a sealed copy into each one, and we poll every home's
// queue — the existing envelope-id dedup in the incoming store collapses the
// copies. A single island death is then invisible: delivery rides the
// surviving home(s).
//
// v1 scope (deliberate):
//   • Backup mailboxes are v=1 only. A v=2 libsignal session needs the
//     auth-gated prekey bundle, which stays on the primary; no bundle is
//     published to backups. The primary keeps v=2 untouched.
//   • The device that ADDED the backup island is the one that polls it.
//     Linked devices hold no token on the backup; they keep riding the
//     primary's per-device queue + carbons. (A linked device CAN adopt the
//     backup itself later via /auth/recover — same keys — but v1 doesn't
//     auto-propagate.)
//   • Groups stay single-island (room-host model) — only 1:1 multihomes.
//
// Storage: localStorage, same phase-1 trade-off as the identity itself.

import { ed25519 } from '@noble/curves/ed25519'
import { b64ToBytes, bytesToB64, encryptV1, type Envelope, type PeerBundle, type WebIdentity } from './crypto'
import { suggestNickname, persistIdentity } from './auth'
import { verifyHomeIslandRecord, type IslandHome } from './federation'
import { verifySigned } from './signing-keys'

const STORE_KEY = 'rcq.web.multihome.v1'
const PEER_CACHE_KEY = 'rcq.web.multihome.peers.v1'
/// How long a resolved peer-homes entry stays fresh. After expiry we re-fetch
/// the record, but a STALE entry is still used when the primary is unreachable
/// (that's the failover moment the cache exists for).
const PEER_CACHE_TTL_MS = 10 * 60 * 1000

// -----------------------------------------------------------
// Our own backup homes
// -----------------------------------------------------------

export interface BackupHome {
  /// Bare island host, e.g. `is2.rcq.app`.
  host: string
  /// OUR uin on that island (per-island handle, ≠ the primary uin).
  uin: number
  /// Bearer token for that island. Refreshable any time via /auth/recover
  /// (possession of the signing key IS the credential).
  jwt: string
  addedAt: number
  /// True when this home was picked by the catalogue auto-pick toggle (vs a
  /// manually-entered host). The toggle only ever adds/removes ITS OWN homes.
  auto?: boolean
}

export function listBackupHomes(): BackupHome[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as BackupHome[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function saveBackupHomes(list: BackupHome[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(list))
}

/// `is2.rcq.app`, `https://is2.rcq.app/`, `is2.rcq.app/x` → `is2.rcq.app`.
/// Returns null when the input doesn't look like a host at all.
export function normalizeIslandHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    return url.host || null
  } catch {
    return null
  }
}

export function hostOfApiBase(apiBase: string): string {
  try {
    return new URL(apiBase).host
  } catch {
    return 'api.rcq.app'
  }
}

// -----------------------------------------------------------
// Registering this identity on another island
// -----------------------------------------------------------

export interface IslandCredentials {
  uin: number
  token: string
}

/// Re-authenticate on `host` by proving possession of our Ed25519 signing key
/// (two-step challenge-response, same flow as seed-phrase recovery). Returns
/// null when this identity has never registered there (404 identity_not_found);
/// throws on network/server errors.
export async function recoverOnIsland(host: string, identity: WebIdentity): Promise<IslandCredentials | null> {
  const base = `https://${host}`
  const skB64 = bytesToB64(identity.signingPub)
  const chRes = await fetch(`${base}/auth/recover/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signing_key: skB64 }),
  })
  if (!chRes.ok) throw new Error(`recover challenge: HTTP ${chRes.status}`)
  const { challenge } = (await chRes.json()) as { challenge: string }
  const signature = ed25519.sign(new TextEncoder().encode(challenge), identity.signingPriv)
  const res = await fetch(`${base}/auth/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signing_key: skB64, challenge, signature: bytesToB64(signature) }),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`recover: HTTP ${res.status}`)
  return (await res.json()) as IslandCredentials
}

/// First-time registration of this identity on `host` — same public keys as
/// the primary account, fresh per-island uin. The nickname is cosmetic (peers
/// see the name from the primary contact list, never the backup roster).
export async function registerOnIsland(host: string, identity: WebIdentity): Promise<IslandCredentials> {
  const skB64 = bytesToB64(identity.signingPub)
  // ⚠ The island only honours `desired_uin` under proof of the signing key
  // now. Without the signature we still register, but on a fresh number, and
  // "one number everywhere" quietly stops being true. An island too old to
  // know the endpoint 404s and we register the way we always did.
  let challenge: string | undefined
  try {
    const chRes = await fetch(`https://${host}/auth/register/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signing_key: skB64 }),
    })
    if (chRes.ok) challenge = ((await chRes.json()) as { challenge: string }).challenge
  } catch {
    // no proof, same as an old island
  }
  const res = await fetch(`https://${host}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nickname: suggestNickname(),
      identity_key: bytesToB64(identity.identityPub),
      signing_key: skB64,
      // Ask to keep our primary number on this backup island (best-effort;
      // the server mints a fresh uin if it's already taken there).
      desired_uin: identity.uin,
      ...(challenge
        ? {
            challenge,
            signature: bytesToB64(
              ed25519.sign(new TextEncoder().encode(challenge), identity.signingPriv),
            ),
          }
        : {}),
    }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(text || `register: HTTP ${res.status}`)
  return JSON.parse(text) as IslandCredentials
}

/// Add `hostInput` as a backup home: recover-first (the identity may already
/// live there), else register with the same keys. Throws with a human-readable
/// message on failure; the caller should republish the home-island record
/// afterwards so senders learn the new home.
export async function addBackupIsland(
  identity: WebIdentity,
  hostInput: string,
  opts?: { auto?: boolean },
): Promise<BackupHome> {
  const host = normalizeIslandHost(hostInput)
  if (!host) throw new Error('invalid host')
  if (host === hostOfApiBase(identity.apiBase)) throw new Error('primary island')
  const existing = listBackupHomes()
  if (existing.some((h) => h.host === host)) throw new Error('already added')

  // Recover-first: registering twice would mint a SECOND uin for the same key
  // on that island (no server-side uniqueness on keys — deliberately).
  const cred = (await recoverOnIsland(host, identity)) ?? (await registerOnIsland(host, identity))
  const home: BackupHome = {
    host,
    uin: cred.uin,
    jwt: cred.token,
    addedAt: Date.now(),
    ...(opts?.auto ? { auto: true } : {}),
  }
  saveBackupHomes([...existing, home])
  return home
}

// -----------------------------------------------------------
// Auto-pick: one toggle instead of typing a host
// -----------------------------------------------------------

// The auto-pick list is a SEPARATE, Ed25519-signed file (not servers.json):
// the toggle silently registers a backup mailbox on whatever it picks, so a
// tampered catalogue must not be able to steer that. servers.json stays a
// display-only directory; this file is what we enforce.
const AUTO_ISLANDS_URL =
  'https://raw.githubusercontent.com/rcq-messenger/rcq-servers/main/auto-islands.json'
const AUTO_ISLANDS_SIG_URL = `${AUTO_ISLANDS_URL}.sig`
// Verified against the ISLAND_LIST role in `signing-keys.ts` — its own role,
// because steering a backup mailbox and steering a tunnel are different powers
// and should not stay welded to one key.

/// True when the auto-pick toggle is on (an auto-picked home exists).
export function hasAutoBackup(): boolean {
  return listBackupHomes().some((h) => h.auto)
}

async function islandHealthy(host: string): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 6000)
    const res = await fetch(`https://${host}/health`, { signal: ctl.signal, cache: 'no-store' })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

/// Fetch the signed auto-pick island list and verify the Ed25519 signature
/// over the EXACT bytes GitHub served against the pinned maintainer key.
/// Throws 'no island' on any fetch/verify failure (fail-safe: no silent
/// backup on an unverified island).
async function fetchSignedAutoIslands(): Promise<string[]> {
  const [jsonRes, sigRes] = await Promise.all([
    fetch(AUTO_ISLANDS_URL, { cache: 'no-store' }),
    fetch(AUTO_ISLANDS_SIG_URL, { cache: 'no-store' }),
  ])
  if (!jsonRes.ok || !sigRes.ok) throw new Error('no island')
  const bytes = new Uint8Array(await jsonRes.arrayBuffer())
  const sig = b64ToBytes((await sigRes.text()).trim())
  if (!verifySigned('island-list', bytes, sig)) throw new Error('no island')
  const doc = JSON.parse(new TextDecoder().decode(bytes)) as { islands?: string[] }
  return Array.isArray(doc.islands) ? doc.islands : []
}

/// Pick a backup island from the SIGNED list, minus our primary island and
/// anything already added. Candidates are health-checked in parallel, then the
/// FIRST healthy one in list order wins (the order is the project's
/// preference). Throws 'no island' when the list can't be verified or no
/// candidate responds.
export async function autoPickBackupIsland(identity: WebIdentity): Promise<string> {
  const own = hostOfApiBase(identity.apiBase)
  const existing = new Set(listBackupHomes().map((h) => h.host))
  const candidates = (await fetchSignedAutoIslands())
    .map((u) => normalizeIslandHost(u))
    .filter((h): h is string => !!h && h !== own && !existing.has(h))
  const health = await Promise.all(candidates.map(islandHealthy))
  const picked = candidates.find((_, i) => health[i])
  if (!picked) throw new Error('no island')
  return picked
}

/// Add a catalogue-picked backup home (the toggle's ON action). Returns the
/// chosen host; the caller republishes the home-island record.
export async function enableAutoBackup(identity: WebIdentity): Promise<string> {
  const host = await autoPickBackupIsland(identity)
  await addBackupIsland(identity, host, { auto: true })
  return host
}

/// Remove every auto-picked home (the toggle's OFF action). Manually-added
/// islands are untouched. The caller republishes the record.
export function disableAutoBackup(): void {
  saveBackupHomes(listBackupHomes().filter((h) => !h.auto))
}

/// Forget a backup home locally. The mailbox account on that island is left
/// behind (harmless orphan; re-adding recovers the same uin). The caller
/// republishes the record so senders stop depositing there.
export function removeBackupIsland(host: string): void {
  saveBackupHomes(listBackupHomes().filter((h) => h.host !== host))
}

/// Promote a backup island to PRIMARY — the one-tap disaster-recovery path for
/// when your primary island is permanently gone (no phrase re-entry: identity is
/// the key, and you are already registered on the backup via multihoming).
///
/// Refreshes the target's token via recover-first FIRST; if the target island is
/// unreachable it throws and changes nothing — promoting to a dead island would
/// strand the account, and phrase-recovery stays the fallback for a truly-gone
/// island. On success: swaps the primary's (host, uin, jwt) to the backup's
/// (keys unchanged), demotes the OLD primary into the backup list (it may come
/// back), drops the target from backups, and persists. The caller republishes
/// the home-island record (new primary first) and reloads onto the new primary.
export async function promoteBackupToPrimary(identity: WebIdentity, backupHost: string): Promise<WebIdentity> {
  const host = normalizeIslandHost(backupHost) ?? backupHost
  const target = listBackupHomes().find((h) => h.host === host)
  if (!target) throw new Error('not a backup island')
  if (host === hostOfApiBase(identity.apiBase)) throw new Error('already primary')

  // Possession of the signing key IS the credential — recover-first needs no
  // phrase. A null result means the island is unreachable; abort, don't strand.
  const cred = await recoverOnIsland(host, identity)
  if (!cred) throw new Error('target island unreachable')

  const next: WebIdentity = { ...identity, apiBase: `https://${host}`, uin: cred.uin, jwt: cred.token }
  const oldPrimary: BackupHome = {
    host: hostOfApiBase(identity.apiBase),
    uin: identity.uin,
    jwt: identity.jwt,
    addedAt: Date.now(),
  }
  saveBackupHomes([oldPrimary, ...listBackupHomes().filter((h) => h.host !== host)])
  persistIdentity(next)
  return next
}

function updateStoredJwt(host: string, cred: IslandCredentials): void {
  saveBackupHomes(
    listBackupHomes().map((h) => (h.host === host ? { ...h, uin: cred.uin, jwt: cred.token } : h)),
  )
}

// -----------------------------------------------------------
// Record assembly + publishing the record to backup homes
// -----------------------------------------------------------

/// Every home this account lives on, primary first (preference order per
/// federation-protocol.md §2.2).
export function assembleHomes(identity: WebIdentity): IslandHome[] {
  return [
    { host: hostOfApiBase(identity.apiBase), uin: identity.uin },
    ...listBackupHomes().map((h) => ({ host: h.host, uin: h.uin })),
  ]
}

/// PUT the signed record to every backup home (the primary PUT is done by the
/// regular authed API client). Best-effort per island; a 401 refreshes the
/// token via /auth/recover once. A 409 (stale ts) means an equal-or-newer
/// record is already there — fine, ignore.
export async function publishRecordToBackups(identity: WebIdentity, record: unknown): Promise<void> {
  for (const home of listBackupHomes()) {
    try {
      const put = (jwt: string) =>
        fetch(`https://${home.host}/federation/island-record`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
          body: JSON.stringify(record),
        })
      let res = await put(home.jwt)
      if (res.status === 401) {
        const fresh = await recoverOnIsland(home.host, identity)
        if (!fresh) continue
        updateStoredJwt(home.host, fresh)
        res = await put(fresh.token)
      }
      void res.body?.cancel()
    } catch {
      /* island unreachable — next publish retries */
    }
  }
}

// -----------------------------------------------------------
// Receive: drain backup queues
// -----------------------------------------------------------

export interface QueueRow {
  envelope_type: string
  payload: string
  group_id: number | null
}

/// Fetch + hand over every queued row from every backup home. Runs even when
/// the primary is down (that's the point). A 401 refreshes the token via
/// /auth/recover and retries once. Duplicates of primary-delivered messages
/// are expected — the incoming store dedups by envelope id. The handler also
/// gets the home's host: if a backup island ALSO hosts a group we joined
/// (§5c — same identity, same mailbox there), group rows arrive through this
/// drain and must be filed under the local alias, not the raw remote id.
export async function drainBackupQueues(
  identity: WebIdentity,
  handle: (row: QueueRow, host: string) => Promise<void>,
): Promise<void> {
  for (const home of listBackupHomes()) {
    try {
      const get = (jwt: string) =>
        fetch(`https://${home.host}/messages/queue`, {
          headers: { Authorization: `Bearer ${jwt}` },
        })
      let res = await get(home.jwt)
      if (res.status === 401) {
        const fresh = await recoverOnIsland(home.host, identity)
        if (!fresh) continue
        updateStoredJwt(home.host, fresh)
        res = await get(fresh.token)
      }
      if (!res.ok) continue
      const rows = (await res.json()) as QueueRow[]
      for (const r of rows) await handle(r, home.host)
    } catch {
      /* island unreachable — next tick */
    }
  }
}

// -----------------------------------------------------------
// Send: deposit a copy to the peer's OTHER homes
// -----------------------------------------------------------

interface PeerHomesCacheEntry {
  homes: IslandHome[]
  ts: number
  /// The signed record's own ts (Unix seconds), when this entry came from a
  /// verified record (resolve or self-push). Used as `minTs` anti-rollback so
  /// a replayed older push can't downgrade a peer's homes. Absent on legacy
  /// entries → treated as 0 (any record wins).
  recTs?: number
}

function readPeerCache(): Record<string, PeerHomesCacheEntry> {
  try {
    return JSON.parse(localStorage.getItem(PEER_CACHE_KEY) || '{}') as Record<string, PeerHomesCacheEntry>
  } catch {
    return {}
  }
}

function writePeerCache(uin: number, entry: PeerHomesCacheEntry): void {
  const cache = readPeerCache()
  cache[String(uin)] = entry
  localStorage.setItem(PEER_CACHE_KEY, JSON.stringify(cache))
}

/// Apply a contact's SELF-PUSHED home-island record (federation gossip B1):
/// verify it is signed by `senderSigningKey` (the same Ed25519 key that signed
/// the envelope it arrived in — proves the sender owns this record), reject a
/// rollback to an older `ts` than we've already seen, and cache the homes for
/// future sends. Returns true when the cache was updated. Never throws.
export function applyPushedRecord(senderUIN: number, senderSigningKey: string, rec: unknown): boolean {
  const prev = readPeerCache()[String(senderUIN)]
  const v = verifyHomeIslandRecord(rec, { expectedSk: senderSigningKey, minTs: prev?.recTs ?? undefined })
  if (!v.ok) return false
  writePeerCache(senderUIN, { homes: v.record.homes, ts: Date.now(), recTs: v.record.ts })
  return true
}

// -----------------------------------------------------------
// Gossip: mirror a peer's signed record to our island so it can be served
// by sk from any island a contact uses (address-mobility B1). The record is
// self-signed, so a mirror adds redundancy with zero added trust — the
// server re-verifies the signature on write, the client on read.
// -----------------------------------------------------------

/// Best-effort mirror a verified record onto `host`'s gossip store. Never
/// throws; a busy/unreachable island just means the next resolve retries.
export async function mirrorRecord(host: string, record: unknown): Promise<void> {
  try {
    const res = await fetch(`https://${host}/federation/gossip-record`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    })
    void res.body?.cancel()
  } catch {
    /* island unreachable — next resolve re-mirrors */
  }
}

/// Fetch a peer's mirrored record by its Ed25519 signing key from `host`'s
/// gossip store. Returns the raw doc or null (404 / unreachable / error).
export async function fetchGossipRecord(host: string, signingKey: string): Promise<unknown | null> {
  try {
    const res = await fetch(`https://${host}/federation/gossip-record?sk=${encodeURIComponent(signingKey)}`)
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  }
}

/// Resolve the peer's home list, verified against the contact's locally-pinned
/// Ed25519 signing key (strictly better than re-fetching the anchor: it's the
/// key we already trust from contact-add / safety number). Cached with a TTL.
///
/// Sources, in order: (1) OUR island's by-uin owner record (the peer is on or
/// multi-homed onto us); (2) OUR island's GOSSIP mirror by sk (some contact
/// already mirrored this peer's record here — this is the address-mobility
/// win: it survives the peer's own island being blocked or gone). A successful
/// (1) is mirrored into the gossip store so it can be served by sk to clients
/// on other islands. A total miss falls back to the stale cache. No record
/// caches an empty list so single-homed peers cost one lookup per TTL.
async function resolvePeerHomesCached(identity: WebIdentity, peer: PeerBundle): Promise<IslandHome[]> {
  const cached = readPeerCache()[String(peer.uin)]
  if (cached && Date.now() - cached.ts < PEER_CACHE_TTL_MS) return cached.homes
  const ownHost = hostOfApiBase(identity.apiBase)
  // (1) by-uin owner record on our island.
  try {
    const res = await fetch(`${identity.apiBase}/federation/island-record/${peer.uin}`)
    if (res.ok) {
      const rec = (await res.json()) as unknown
      const v = verifyHomeIslandRecord(rec, { expectedSk: peer.signingKey })
      if (v.ok) {
        // Seed the gossip store so this record is reachable by sk from other
        // islands too (and survives this island losing the by-uin row).
        void mirrorRecord(ownHost, rec)
        writePeerCache(peer.uin, { homes: v.record.homes, ts: Date.now(), recTs: v.record.ts })
        return v.record.homes
      }
    } else if (res.status !== 404) {
      throw new Error(`HTTP ${res.status}`)
    }
  } catch {
    /* fall through to gossip + stale cache */
  }
  // (2) gossip mirror by sk on our island.
  if (peer.signingKey) {
    const rec = await fetchGossipRecord(ownHost, peer.signingKey)
    if (rec) {
      const v = verifyHomeIslandRecord(rec, { expectedSk: peer.signingKey })
      if (v.ok) {
        writePeerCache(peer.uin, { homes: v.record.homes, ts: Date.now(), recTs: v.record.ts })
        return v.record.homes
      }
    }
  }
  // (3) nothing reachable — if we ever saw a record, the by-uin 404 path above
  // hasn't run (we threw or got non-404); keep serving the last-known homes.
  return cached?.homes ?? []
}

/// Resolve a peer's homes from THEIR OWN island, mirror the verified record onto
/// our island's gossip store, and fall back to our gossip mirror if their
/// island is unreachable. The cross-island entry point (used when we know the
/// peer's home host, e.g. a cross-island contact): it both seeds the mirror and
/// reaps it. Returns the verified homes, or [] if nothing verifies anywhere.
export async function resolveAndMirrorHomes(
  identity: WebIdentity,
  peerHost: string,
  uin: number,
  signingKey: string,
): Promise<IslandHome[]> {
  const ownHost = hostOfApiBase(identity.apiBase)
  // (1) the peer's own island.
  try {
    const res = await fetch(`https://${peerHost}/federation/island-record/${uin}`)
    if (res.ok) {
      const rec = (await res.json()) as unknown
      const v = verifyHomeIslandRecord(rec, { expectedSk: signingKey })
      if (v.ok) {
        void mirrorRecord(ownHost, rec)        // seed our island's mirror
        return v.record.homes
      }
    }
  } catch {
    /* peer island unreachable — reap the mirror */
  }
  // (2) our island's gossip mirror (the win when the peer's island is gone).
  const rec = await fetchGossipRecord(ownHost, signingKey)
  if (rec) {
    const v = verifyHomeIslandRecord(rec, { expectedSk: signingKey })
    if (v.ok) return v.record.homes
  }
  return []
}

/// Deposit a v=1 sealed copy of `envelope` into each of the peer's homes OTHER
/// than our own island (the primary copy went — or failed to go — through the
/// normal send path). Seal once: v=1 doesn't bind the recipient uin, only their
/// identity key, which is identical on every island. Returns how many homes
/// accepted the copy; 0 for every single-homed peer (today's universal case —
/// the flagship path stays byte-identical). Never throws.
export async function depositToExtraHomes(
  identity: WebIdentity,
  peer: PeerBundle,
  envelope: Envelope,
): Promise<number> {
  try {
    if (!peer.signingKey) return 0 // nothing to anchor the record against
    const ownHost = hostOfApiBase(identity.apiBase)
    const extra = (await resolvePeerHomesCached(identity, peer)).filter((h) => h.host !== ownHost)
    if (extra.length === 0) return 0

    const sealed = encryptV1(envelope, identity, peer)
    let delivered = 0
    for (const home of extra) {
      try {
        const res = await fetch(`https://${home.host}/messages/sealed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to_uin: home.uin, envelope_type: 'message', payload: sealed }),
        })
        if (res.ok) delivered++
        void res.body?.cancel()
      } catch {
        /* this home is unreachable; the others (or the primary) cover it */
      }
    }
    return delivered
  } catch {
    return 0
  }
}
