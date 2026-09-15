// What a burn from this browser covers, and the real transport it runs on
// (spec 2026-09-15, F2). The state machine itself is burn-cascade.ts.
//
// Covered: every island in this account's own stores, and nothing learned
// from anybody else.
//  * visited islands (a guest copy where this browser joined a group);
//  * backup homes (multihome);
//  * other accounts held in this browser under the same signing key, on
//    another island: they are the same identity and die with the keys.
// Not covered, and the screen says so: copies made by the account's other
// devices, and copies a group owner added on an island this browser never
// opened. No island is ever told to delete on another island's behalf.
//
// Web and desktop have no wipe PIN, so there is no detached, network-after-
// wipe path here; that one is Android and iOS only.

import { ed25519 } from '@noble/curves/ed25519'
import { parseErrorCode } from './api'
import { listStoredIdentities } from './auth'
import { mergeBurnTargets, sameKeySiblings, type BurnSource, type BurnTarget, type BurnTransport, type RecoverAnswer } from './burn-cascade'
import { contactsCache, snapshotFor } from './contacts-cache'
import { bytesToB64, type WebIdentity } from './crypto'
import { isFrontHost } from './front'
import { hostOfApiBase, listBackupHomes } from './multihome'
import { listVisitedIslands } from './visited-islands'

/// A key the transport proves: the public half named, the private half signs.
export interface BurnKey {
  signingPub: Uint8Array
  signingPriv: Uint8Array
}

export interface BurnPlan {
  homeHost: string
  targets: BurnTarget<BurnKey>[]
  /// Visited and backup islands, for the paragraph above the confirm.
  islandHosts: string[]
  /// Same-key accounts in this browser, burned with this one.
  siblings: Array<{ uin: number; host: string }>
  /// Names of groups this account owns on those islands: they go for everyone.
  ownedGroups: string[]
}

/// Read the stores NOW. Called when the confirm opens and again when the burn
/// starts, so the list shown and the list burned are the same stores.
export function planBurn(identity: WebIdentity): BurnPlan {
  const homeHost = hostOfApiBase(identity.apiBase).toLowerCase()
  const visited = listVisitedIslands()
  const backups = listBackupHomes().filter((h) => !isFrontHost(h.host))
  const signingPub = bytesToB64(identity.signingPub)
  const siblings = sameKeySiblings(
    listStoredIdentities()
      .filter((a) => a.uin !== identity.uin || hostOfApiBase(a.apiBase).toLowerCase() !== homeHost)
      .map((a) => ({ uin: a.uin, host: hostOfApiBase(a.apiBase), jwt: a.jwt, signingPub: bytesToB64(a.signingPub) })),
    { uin: identity.uin, host: homeHost, signingPub },
  )
  const sources: BurnSource[] = [
    ...visited.map((v) => ({ host: v.host, uin: v.uin, token: v.jwt || undefined })),
    ...backups.map((h) => ({ host: h.host, uin: h.uin, token: h.jwt || undefined })),
    ...siblings.map((s) => ({ host: s.host, uin: s.uin, token: s.jwt || undefined })),
  ]
  const key: BurnKey = { signingPub: identity.signingPub, signingPriv: identity.signingPriv }
  const targets = mergeBurnTargets(sources, homeHost, [key])
  const islandHosts = [...new Set([...visited, ...backups].map((x) => x.host.toLowerCase()))].filter((h) => h !== homeHost)

  // Owned groups, from the roster snapshot only: no fetch before a confirm.
  const guestUinOn = new Map(visited.map((v) => [v.host.toLowerCase(), v.uin]))
  const groups = contactsCache.get(identity.uin)?.groups ?? snapshotFor(identity.uin)?.groups ?? []
  const ownedGroups = groups
    .filter((g) => g.host && guestUinOn.get(g.host.toLowerCase()) === g.owner_uin)
    .map((g) => g.name)
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')

  return {
    homeHost,
    targets,
    islandHosts,
    siblings: siblings.map((s) => ({ uin: s.uin, host: s.host })),
    ownedGroups,
  }
}

/// The transport over `fetch`. Its own recover rather than `recoverOnIsland`,
/// which reads every 404 as "no account": a burn has to tell
/// `identity_not_found` from `identity_rotated`, and both from an island with
/// no recover route at all.
export function fetchBurnTransport(): BurnTransport<BurnKey> {
  return {
    async deleteAccount(host, token, signal) {
      const res = await fetch(`https://${host}/auth/account`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal,
      })
      void res.body?.cancel()
      return res.status
    },
    async recover(host, key, signal): Promise<RecoverAnswer> {
      const sk = bytesToB64(key.signingPub)
      const ch = await fetch(`https://${host}/auth/recover/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signing_key: sk }),
        cache: 'no-store',
        signal,
      })
      // ⚠ A 404 HERE is a missing route, not a missing account. Such an island
      // can never say "no copy", so it is never reported as gone.
      if (ch.status === 404) {
        void ch.body?.cancel()
        return { kind: 'too_old' }
      }
      if (!ch.ok) {
        void ch.body?.cancel()
        return { kind: 'status', status: ch.status }
      }
      const { challenge } = (await ch.json().catch(() => ({}))) as { challenge?: unknown }
      if (typeof challenge !== 'string') return { kind: 'status', status: 502 }
      const signature = ed25519.sign(new TextEncoder().encode(challenge), key.signingPriv)
      const res = await fetch(`https://${host}/auth/recover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signing_key: sk, challenge, signature: bytesToB64(signature) }),
        cache: 'no-store',
        signal,
      })
      const text = await res.text()
      if (res.ok) {
        try {
          const token = (JSON.parse(text) as { token?: unknown }).token
          if (typeof token === 'string' && token) return { kind: 'token', token }
        } catch {
          /* fall through */
        }
        return { kind: 'status', status: 502 }
      }
      if (res.status === 404) {
        const code = parseErrorCode(text)
        if (code === 'identity_not_found') return { kind: 'not_found' }
        if (code === 'identity_rotated') return { kind: 'rotated' }
        // A bare "Not Found": the route itself is missing.
        return { kind: 'too_old' }
      }
      return { kind: 'status', status: res.status }
    },
  }
}
