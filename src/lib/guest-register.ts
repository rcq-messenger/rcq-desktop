// Getting a guest copy of this identity onto another island (spec 2026-09-15,
// sections 4 and 12.1): the network half of guest-path.ts.
//
// Two ways, picked per island on the explicit Join tap and never before it
// (the §5c privacy rule: seeing a link must not touch its island):
//   * GUEST, where /server/info says `guest_accounts_v1: true`: a challenge,
//     then an `rcq-guest-v1` proof over the island, the room, both our keys
//     and that challenge (guest-proof.ts). One request gives the copy AND its
//     first room, and works on a paid door, because no door is involved.
//   * LEGACY everywhere else: recover-first, then a plain registration, as
//     every client did before. Now with the register challenge signed and
//     ⚠⚠ without `desired_uin` (legacyGuestRegisterBody).
//
// `registerOnIsland` (multihome.ts) stays for backup homes only. A backup home
// is supposed to carry our number; a guest copy is not.

import { ed25519 } from '@noble/curves/ed25519'
import { bytesToB64, type WebIdentity } from './crypto'
import { isIdentityRotated, recoverOnIsland, type IslandCredentials } from './multihome'
import { loadServerInfo } from './server-info'
import { guestProofBytes } from './guest-proof'
import {
  GUEST_NICKNAME_PLACEHOLDER,
  decideGuestPath,
  guestAttemptVerdict,
  guestJoinBody,
  guestRefusalOf,
  legacyGuestRegisterBody,
  type GuestPath,
} from './guest-path'

/// A guest join the island refused, with its status and `detail.code` so the
/// screen can pick the sentence (guestJoinErrorKey). `message` is the code
/// (or `HTTP <status>`) and is never meant to be shown.
export class GuestJoinError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    public body: string,
  ) {
    super(code ?? `HTTP ${status}`)
    this.name = 'GuestJoinError'
  }
}

/// How long the capability read may take on a Join tap before it counts as no
/// answer (and so as LEGACY, which is what an unreachable island always got).
const INFO_TIMEOUT_MS = 15_000

/// Ask the island, uncached, which path it takes. Uncached on purpose: the
/// answer changes with a deploy and with the operator's `guest_admission`
/// switch, and a run-long "no" from an hour ago would send a person to the
/// door the island has since opened for them.
export async function islandGuestPath(apiBase: string): Promise<GuestPath> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), INFO_TIMEOUT_MS)
  try {
    return decideGuestPath(await loadServerInfo(apiBase, { signal: ctl.signal }))
  } finally {
    clearTimeout(timer)
  }
}

/// Guest credentials for `host`, by whichever path the island advertises.
///
/// `groupId` is the room id ON THAT ISLAND. On the guest path a caller without
/// a room never mints a copy: it may only take back one that exists (recover),
/// because the island creates a guest row only together with its first room.
export async function guestCredentialsFor(
  host: string,
  identity: WebIdentity,
  groupId?: number,
): Promise<IslandCredentials> {
  const path = await islandGuestPath(`https://${host}`)
  if (path === 'guest') {
    if (groupId != null && Number.isSafeInteger(groupId) && groupId > 0) {
      return registerGuestOnIsland(host, identity, groupId)
    }
    const cred = await recoverGuestCopy(host, identity)
    if (cred) return cred
    throw new GuestJoinError(404, 'identity_not_found', '')
  }
  return legacyGuestCredentials(host, identity)
}

/// Today's path, unchanged in shape: recover-first, then register.
async function legacyGuestCredentials(host: string, identity: WebIdentity): Promise<IslandCredentials> {
  return (await recoverGuestCopy(host, identity)) ?? (await registerGuestLegacy(host, identity))
}

/// The recover every guest path makes, with one difference from a plain
/// `recoverOnIsland`: a 404 `identity_rotated` is not "no copy here" (D2). It
/// is thrown as a GuestJoinError with that code, so nothing goes on to
/// register the retired key, and the caller starts the rotated-elsewhere flow.
export async function recoverGuestCopy(host: string, identity: WebIdentity): Promise<IslandCredentials | null> {
  try {
    return await recoverOnIsland(host, identity, { rotatedThrows: true })
  } catch (e) {
    if (isIdentityRotated(e)) throw new GuestJoinError(404, 'identity_rotated', '')
    throw e
  }
}

/// Section 4, as 12.1 handles it:
///   * `invalid_challenge`, `guest_replayed`, `guest_busy`: one retry with a
///     fresh challenge;
///   * `identity_rotated`: thrown as such, and the caller never wipes on it;
///   * 404 or 405 on the route itself: the legacy path;
///   * 5xx or no answer: one recover-first attempt, whose credentials are used
///     when it has any;
///   * every other refusal: thrown with its code, and NO legacy fallback.
export async function registerGuestOnIsland(
  host: string,
  identity: WebIdentity,
  groupId: number,
): Promise<IslandCredentials> {
  const base = `https://${host}`
  const signingKey = bytesToB64(identity.signingPub)
  const identityKey = bytesToB64(identity.identityPub)
  // A placeholder: the name we really use is pushed to the copy right after
  // (visited-islands, #985(2)), and the island is told nothing more about us
  // than it has to be. ⚠ D1: a word, never `user-<digits>`.
  const nickname = GUEST_NICKNAME_PLACEHOLDER
  let retried = false
  for (;;) {
    let status: number | null = null
    let text = ''
    try {
      const ch = await fetch(`${base}/auth/guest/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signing_key: signingKey }),
      })
      if (!ch.ok) {
        status = ch.status
        text = await ch.text()
      } else {
        const { challenge } = (await ch.json()) as { challenge: string }
        // `host` as dialled: the proof canonicalises it, and the island checks
        // the canonical spelling against its own names.
        const signed = guestProofBytes(host, groupId, identity.identityPub, identity.signingPub, challenge)
        const signature = bytesToB64(ed25519.sign(signed, identity.signingPriv))
        const res = await fetch(`${base}/auth/guest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            guestJoinBody({ host, groupId, nickname, identityKey, signingKey, challenge, signature, homeUin: identity.uin }),
          ),
        })
        status = res.status
        text = await res.text()
        if (res.ok) {
          const out = JSON.parse(text) as { uin?: unknown; token?: unknown; guest?: unknown }
          if (typeof out.uin !== 'number' || typeof out.token !== 'string') {
            throw new Error('malformed guest reply')
          }
          return { uin: out.uin, token: out.token, guest: out.guest === true }
        }
      }
    } catch {
      // No answer, or an answer that is not the documented one: the same
      // "try the key we already have there" as a 5xx.
      status = null
    }
    const refusal = guestRefusalOf(status ?? 0, text)
    switch (guestAttemptVerdict(status, refusal.code)) {
      case 'retry':
        if (!retried) {
          retried = true
          continue
        }
        throw new GuestJoinError(status ?? 0, refusal.code, text)
      case 'legacy':
        return legacyGuestCredentials(host, identity)
      case 'recover': {
        const cred = await recoverGuestCopy(host, identity).catch((e: unknown) => {
          // A retired key is the one answer that must not read as "nothing to
          // recover": it goes on to the rotated-elsewhere flow (D2).
          if (e instanceof GuestJoinError && e.code === 'identity_rotated') throw e
          return null
        })
        if (cred) return cred
        throw new GuestJoinError(status ?? 0, refusal.code ?? 'guest_unavailable', text)
      }
      default:
        // 'rotated' and 'refused'. ('ok' returned above.)
        throw new GuestJoinError(status ?? 0, refusal.code, text)
    }
  }
}

/// A legacy guest registration: the register challenge signed when the island
/// hands one out, and ⚠⚠ never `desired_uin` (see legacyGuestRegisterBody).
/// Throws the same shape `registerOnIsland` does (message = body, plus
/// `status` and `body`), so `doorRefusalOf` reads a door here too and the join
/// card says "its server can't take people from other islands yet".
export async function registerGuestLegacy(host: string, identity: WebIdentity): Promise<IslandCredentials> {
  const signingKey = bytesToB64(identity.signingPub)
  let challenge: string | undefined
  try {
    const chRes = await fetch(`https://${host}/auth/register/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signing_key: signingKey }),
    })
    if (chRes.ok) challenge = ((await chRes.json()) as { challenge: string }).challenge
  } catch {
    // no proof, same as an island older than the endpoint
  }
  const res = await fetch(`https://${host}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      legacyGuestRegisterBody({
        nickname: GUEST_NICKNAME_PLACEHOLDER,
        homeUin: identity.uin,
        identityKey: bytesToB64(identity.identityPub),
        signingKey,
        challenge,
        signature: challenge
          ? bytesToB64(ed25519.sign(new TextEncoder().encode(challenge), identity.signingPriv))
          : undefined,
      }),
    ),
  })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(text || `register: HTTP ${res.status}`) as Error & { status: number; body: string }
    err.status = res.status
    err.body = text
    throw err
  }
  const out = JSON.parse(text) as { uin: number; token: string; guest?: unknown }
  return { uin: out.uin, token: out.token, guest: out.guest === true }
}
