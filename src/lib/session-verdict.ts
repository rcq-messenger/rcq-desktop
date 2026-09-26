// What an island's refusal to mint a session token MEANS, and what start-up
// does about it. On its own and pure (no store, no network, no imports) so the
// rule that decides whether this browser signs an account out can be proven
// offline against the built bundle (cli/test/carbon-gate.mjs), the same way
// crossisland-gate.ts is.
//
// Why it is its own file (spec 2026-09-15, P0.2): this client used to read the
// refusal with `text.includes('identity_not_found')` and sign out on a hit.
// Two new answers share that 404 and must NEVER end a session:
//
//  * `identity_rotated`: this account's keys were changed on another device
//    (the island keeps the old signing key as retired). The account is alive;
//    this browser just holds the previous keys. Signing out here would drop
//    the only copy of the old key a sibling cascade will need, and old web
//    builds doing exactly that is why C0 ships before any client can rotate.
//  * `identity_ambiguous`: the number is vacant and the key answers for more
//    than one account, so the island will not guess (auth.py /auth/refresh).
//    Recovery by phrase, with a person looking at the screen, is the way on.
//
// And none of them, `identity_not_found` included, ends a session while this
// browser holds a pending rotation: mid-rotation the island can legitimately
// not know the key we asked with, and the pending state holds the only key
// that finishes the job.

/// What came back from an attempt to mint a session token.
///
/// The failures are deliberately NOT the same thing, because acting on the
/// wrong one signs somebody out of a live account:
///  * `dead` — the island says this identity is gone. The session really is
///    over; the caller may send the user back to the login screen.
///  * `unsupported` — the island predates POST /auth/refresh. Nothing is
///    wrong; this account simply goes on keeping its token on disk.
///  * `rotated` — the keys were changed on another device. Keep everything and
///    ask for the new phrase.
///  * `ambiguous` — the island refused to pick between accounts sharing this
///    key. Keep everything and send the person to recovery.
///  * none of these — offline, a 5xx, a captive portal. Try again later and
///    change nothing in the meantime.
export interface TokenMint {
  token: string | null
  dead: boolean
  unsupported: boolean
  /// ⚠⚠ The number this account answers as NOW, when it is not the one we
  /// asked about. Set only when the island said in so many words that the
  /// account moved off the number we named (`moved_from`), which is a
  /// different thing from a shared key handing back a stranger.
  ///
  /// This exists because the old answer to "that number is not here" was
  /// `identity_not_found`, and this client reads that as a burn and signs
  /// itself out. A person who buys a shorter number on their laptop should not
  /// find their browser logged out and their phone wiped.
  movedTo?: number
  /// 404 `identity_rotated`: see the file header.
  rotated?: boolean
  /// 404 `identity_ambiguous`: see the file header.
  ambiguous?: boolean
  /// The number the island named alongside `identity_rotated`, when it did.
  uin?: number
  /// Seconds the island asked us to wait before minting again (429 on
  /// /auth/refresh). Says nothing about the account: the budget is per
  /// address, and it refills on its own (#1041).
  retryAfterS?: number
}

/// The refusal code out of an error body, in either shape the island answers
/// with: `{"detail":{"code":"..."}}` (its own refusals) or `{"detail":"..."}`
/// (FastAPI's, e.g. "Not Found" for a route it does not have). A body that is
/// not JSON has no code. Same reading as api.ts `parseErrorCode`, repeated here
/// so this file keeps no imports.
export function refusalCode(body: string): { code: string | null; uin?: number } {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown }
    const d = parsed?.detail
    if (typeof d === 'string') return { code: d }
    if (d && typeof d === 'object') {
      const o = d as { code?: unknown; uin?: unknown }
      const code = typeof o.code === 'string' ? o.code : null
      const uin = typeof o.uin === 'number' && Number.isInteger(o.uin) ? o.uin : undefined
      return uin === undefined ? { code } : { code, uin }
    }
  } catch {
    /* non-JSON body */
  }
  return { code: null }
}

/// Map a refused POST /auth/refresh (401, 404, 405) to a [TokenMint].
///
/// Exact codes, never substrings: a future code that merely CONTAINS
/// `identity_not_found` must not inherit its power to end a session.
///
/// `rotationPending`: this browser holds a pending key rotation for the
/// account. Nothing is ever `dead` then (see the file header).
export function mintFromRefusal(status: number, body: string, rotationPending: boolean): TokenMint {
  const miss: TokenMint = { token: null, dead: false, unsupported: false }
  const { code, uin } = refusalCode(body)
  if (status === 401) {
    // The account disconnected this browser. Same ending as "identity gone":
    // the session is over and no amount of retrying changes that.
    if (code === 'device_revoked') return rotationPending ? miss : { token: null, dead: true, unsupported: false }
    return miss
  }
  if (status === 404) {
    if (code === 'identity_rotated') {
      return { token: null, dead: false, unsupported: false, rotated: true, ...(uin !== undefined ? { uin } : {}) }
    }
    if (code === 'identity_ambiguous') return { token: null, dead: false, unsupported: false, ambiguous: true }
    // "No such account" (ours, coded) versus "no such route" (an island older
    // than this endpoint, FastAPI's bare "Not Found").
    if (code === 'identity_not_found') return rotationPending ? miss : { token: null, dead: true, unsupported: false }
    return { token: null, dead: false, unsupported: true }
  }
  if (status === 405) return { token: null, dead: false, unsupported: true }
  return miss
}

/// What start-up does with a mint for the stored account.
///  * `moved`    adopt the number the island named (`moved_from` proof)
///  * `token`    carry on with the fresh token
///  * `rotated`  keep the account and every local store, show the
///               rotated-elsewhere screen
///  * `stranded` keep everything, show the moved-account notice (recovery)
///  * `signout`  the island says the identity is gone
///  * `keep`     could not ask; open on stored history and keep trying
///
/// `signout` comes ONLY from `dead`, and [mintFromRefusal] never sets `dead`
/// for a rotated or ambiguous identity, or under a pending rotation.
export type BootAction = 'moved' | 'token' | 'rotated' | 'stranded' | 'signout' | 'keep'

export function bootAction(mint: TokenMint): BootAction {
  if (mint.token && mint.movedTo) return 'moved'
  if (mint.token) return 'token'
  if (mint.rotated) return 'rotated'
  if (mint.ambiguous) return 'stranded'
  if (mint.dead) return 'signout'
  return 'keep'
}
