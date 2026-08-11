// Which account's data a storage key belongs to.
//
// Everything local used to be stored under one flat namespace —
// `rcq.web.outgoing.peer.123`, one IndexedDB called `rcq-web` — because there
// was only ever one account in a browser, and signing out wiped the lot. That
// worked exactly as long as the assumption held. The moment two accounts live
// here at once, the same key means two different conversations and they merge:
// not "the other account shows up once", but permanently one pile. The comment
// on `wipeLocalAccountData` records the same bug being hit when a NEW account
// inherited the previous one's group messages.
//
// So every key is now scoped by the owning UIN, and the scope is set before any
// store is touched. It is deliberately module state rather than a React
// context: the stores that read it are plain modules called from anywhere, and
// threading a provider through them would only move the problem.

let _uin: number | null = null

/// Set by the identity provider the moment an account becomes active, and
/// BEFORE anything reads a store. A hard reload follows every switch, so this
/// is written once per page life.
export function setAccountScope(uin: number | null) {
  _uin = uin
}

export function accountScope(): number | null {
  return _uin
}

/// `rcq.web.<uin>.<suffix>`. Falls back to the flat key when no account is
/// active yet — nothing should be writing then, and a wrong-looking key beats
/// throwing inside a store.
export function scopedKey(suffix: string): string {
  return _uin == null ? `rcq.web.${suffix}` : `rcq.web.${_uin}.${suffix}`
}

/// Per-account IndexedDB. A database name cannot be changed after opening, so
/// this is read once when the connection is first made.
export function scopedDbName(): string {
  return _uin == null ? 'rcq-web' : `rcq-web-${_uin}`
}

// ⚠ v2, not v1: the first wave (outgoing logs only) already ran in most
// browsers and set the flag, so reusing it would skip the federation stores
// added to the list in 0.3.3 for exactly the people who have them. Re-running
// the copy is safe — it never overwrites a scoped key that already exists.
const MIGRATED_FLAG = 'rcq.web.scoped.v2'

/// Move the flat-namespace data into this account's scope, once.
///
/// COPIES rather than moves. If something about this is wrong, the original
/// keys are still sitting there and nothing is lost — and a message log that
/// failed to arrive looks exactly like a wiped conversation, which is not a
/// thing to be brave about. Sweeping the originals is a separate step for a
/// later version, once it is clear everything landed.
///
/// Only the FIRST account to run this claims the flat data: it belonged to
/// whoever was signed in, and that is the account being scoped right now.
export function migrateFlatDataInto(uin: number) {
  if (localStorage.getItem(MIGRATED_FLAG)) return
  const prefix = 'rcq.web.'
  const scopedPrefix = `rcq.web.${uin}.`
  const moved: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || !k.startsWith(prefix)) continue
    const rest = k.slice(prefix.length)
    // Skip anything already scoped (starts with digits + '.'), and the keys
    // that are about the BROWSER rather than an account.
    if (/^\d+\./.test(rest)) continue
    // The outgoing logs, plus the federation stores. `rcq.web.unread.<uin>`
    // already carries its owner — a different shape, but scoped all the same,
    // and copying it would produce `rcq.web.<uin>.unread.<uin>` that nothing
    // ever reads.
    //
    // ⚠ The federation four were flat until 0.3.3 and are the reason this list
    // grew: cross-island contacts, held message requests, the blocked list and
    // the visited-island records all survived an unlink and showed up in the
    // next account created in this browser. They are scoped now; this copy is
    // what keeps the person who HAD them from losing them in the process.
    if (!rest.startsWith('outgoing.') && !FLAT_FEDERATION_KEYS.has(rest)) continue
    moved.push(k)
  }
  for (const k of moved) {
    const v = localStorage.getItem(k)
    if (v == null) continue
    const target = scopedPrefix + k.slice(prefix.length)
    // Never overwrite: if the scoped key already holds something, that is
    // newer than a copy of the pre-scope world.
    if (localStorage.getItem(target) == null) localStorage.setItem(target, v)
  }
  // These, unlike the message logs, are DELETED after copying. Leaving them is
  // the bug: a flat key is readable by every account in this browser, and the
  // whole point of the move is that the next account does not inherit them.
  for (const k of moved) {
    if (FLAT_FEDERATION_KEYS.has(k.slice(prefix.length))) localStorage.removeItem(k)
  }
  localStorage.setItem(MIGRATED_FLAG, String(uin))
}

/// Suffixes (after `rcq.web.`) of the stores that federation kept flat.
const FLAT_FEDERATION_KEYS = new Set([
  'crossisland.v1',
  'ci-requests.v1',
  'ci-blocked.v1',
  'visited.v1',
  'fgroup-alias.v1',
])
