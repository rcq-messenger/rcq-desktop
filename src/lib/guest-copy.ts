// "The account this browser is signed into is a guest copy" (spec 2026-09-15,
// section 12.1, "Copy signed in as an account").
//
// A guest copy on another island answers `/auth/recover` like any account, so a
// person can type their recovery phrase on the wrong island's login and land in
// the copy: a row that takes part in rooms and nothing else. The island says so
// in every recover and refresh reply (`guest: true`), and this is where that
// answer is kept, so the screens can show the banner and stop offering what the
// island will refuse (contacts, calls, rooms of its own, sites, the shop).
//
// React-free: auth.ts writes here, and auth.ts is bundled into the CLI. The
// hook lives in use-guest-copy.ts. Not a secret and not a credential, so a
// plain key rather than an account-scoped one; the entry names host and uin.

const KEY = 'rcq.web.guest-copy.v1'
export const GUEST_COPY_EVENT = 'rcq-guest-copy-changed'

function entryOf(apiBase: string, uin: number): string {
  let host = apiBase
  try {
    host = new URL(apiBase).host
  } catch {
    /* keep the string as given */
  }
  return `${host.toLowerCase()}#${uin}`
}

function load(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/// Record what the island said about the account (uin on apiBase).
///
/// ⚠⚠ ABSENT MEANS NOT A GUEST: only `guest: true` in as many words sets the
/// entry, and every other answer — absent, null, a wrong type — clears it. This
/// used to leave the entry as it was for an absent flag, and that direction is
/// how a stale true becomes permanent: an island that HAS guest copies always
/// sends the key (the server fills it explicitly false on register, recover,
/// refresh and the self view), so the only reply that omits it comes from an
/// island where no guest row can exist — or from one rolled back to a build
/// before the feature, which is exactly when a stale true does damage. Here it
/// only hides UI surfaces, because the web registers no push token at all; on
/// iOS the same stickiness silenced push for an account permanently and
/// invisibly. The three clients resolve it identically now: Android
/// `Session.notePrimaryGuest` + `GuestFlagWireTest`, iOS `GuestFlag` in
/// `CrossIslandLogic.swift`.
export function notePrimaryGuest(apiBase: string, uin: number, guest: unknown): void {
  const isGuest = guest === true
  const entry = entryOf(apiBase, uin)
  const list = load()
  const has = list.includes(entry)
  if (has === isGuest) return
  const next = isGuest ? [...list, entry] : list.filter((x) => x !== entry)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage full or blocked: the next refresh says it again */
  }
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(GUEST_COPY_EVENT))
  } catch {
    /* no window (the console) */
  }
}

/// True when the island last said this account is a guest copy.
export function isPrimaryGuest(identity: { apiBase: string; uin: number } | null | undefined): boolean {
  if (!identity) return false
  return load().includes(entryOf(identity.apiBase, identity.uin))
}
