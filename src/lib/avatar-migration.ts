/// Taking the key to your own face off the island, for the pictures that were
/// set before that was possible.
///
/// ⚠⚠ WHY THIS EXISTS. The profile-key model (docs/profile-key-design.md) stops
/// the island from holding the key to a person's avatar: the blob is sealed
/// under one key per ACCOUNT, the island is handed the media id ALONE, and
/// contacts receive the key over E2E. It only ever applied to pictures set
/// AFTER it shipped. Everything older kept the old shape — a per-upload key
/// sitting in `users.avatar_media_key`, in the same row as the number and the
/// nickname, with the ciphertext behind an unauthenticated GET on the same
/// disk. Counted on 21.09: of 80 pictures on the two production islands, 63
/// were still openable by the island. Three quarters of the faces we hold.
///
/// Nothing was ever going to fix those on its own. The shape only changes when
/// somebody happens to SET a new picture, and most people set one once.
///
/// So: on sign-in, if my own row still carries a key, fetch my own blob,
/// open it with that key, re-seal it under my profile key, upload it as a new
/// id and hand the island the id alone. The island clears the key column when
/// an id arrives without one, which is what actually takes it away.
///
/// ⚠ Safe to interrupt at any point. The old blob and the old id stay exactly
/// where they are until the very last step, so a failure anywhere before it
/// leaves the picture working as it did. A device that fails half way tries
/// again tomorrow.
///
/// ⚠ Safe to race. Two devices migrating the same account at once seal under
/// the SAME profile key (both read it from the vault), so whichever id lands
/// last is a blob every contact can open with the key they already hold.

import { Api } from './api'
import type { WebIdentity } from './crypto'
import { resealBlobUnderKey } from './media'
import { ensureMyProfileKey, fanOutMyProfileKey } from './profile-key'
import { pushProfileToCrossIslandContacts } from './crossisland-profile'
import { scopedKey } from './account-scope'

/// Not more than once a day per account, and not twice in one session. The
/// condition that starts it clears itself the moment it succeeds (the island
/// stops returning a key), so this only bounds the FAILING case — an island
/// that cannot be reached must not turn into a retry loop on every reload.
const TRIED_KEY = 'avatar.migration.lastTry'
const RETRY_MS = 24 * 60 * 60 * 1000
const triedThisSession = new Set<number>()

function recentlyTried(): boolean {
  try {
    const at = Number(localStorage.getItem(scopedKey(TRIED_KEY)) ?? '0')
    return Number.isFinite(at) && Date.now() - at < RETRY_MS
  } catch {
    return false
  }
}

function markTried(): void {
  try {
    localStorage.setItem(scopedKey(TRIED_KEY), String(Date.now()))
  } catch {
    /* no storage: the session guard still stops a loop within this page */
  }
}

/// Move my own picture to the profile-key shape if it is still in the old one.
/// Returns the new media id when something was actually moved.
export async function migrateOwnAvatar(identity: WebIdentity): Promise<string | null> {
  if (triedThisSession.has(identity.uin)) return null
  triedThisSession.add(identity.uin)
  if (recentlyTried()) return null

  const me = await Api.myInfo(identity).catch(() => null)
  const oldId = me?.avatar_media_id
  const oldKey = me?.avatar_media_key
  // No picture, or already sealed under the profile key: nothing to do, and
  // nothing to remember either — this is the resting state.
  if (!oldId || !oldKey) return null

  markTried()

  // ⚠ This MINTS when the account has no profile key yet, and that is correct
  // here and nowhere else: we are about to publish under it and hand it to
  // every contact in the same breath. It reads the vault first, so a key a
  // sibling install already published is adopted rather than rivalled.
  const pk = await ensureMyProfileKey(identity)

  const newId = await resealBlobUnderKey(identity.apiBase, oldId, oldKey, pk)
  if (!newId) return null

  // ⚠ id ALONE. That is the whole point: the island drops the key column when
  // an id arrives without one.
  await Api.updateProfile(identity, { avatar_media_id: newId })

  // ⚠⚠ Read it back rather than trusting the write. An island older than the
  // profile-key feature parses the request with Pydantic's default
  // extra='ignore': it drops the field, commits nothing and answers 200. On
  // such an island this migration must be a no-op, not a picture that quietly
  // points at a blob nobody was told about.
  const back = await Api.userInfo(identity, identity.uin).catch(() => null)
  if (!back || back.avatar_media_id !== newId) return null

  // Everyone entitled gets the key. Most of them already have it (it is the
  // account's key, not this picture's), and `rememberPeerKey` drops a repeat,
  // so this is cheap for them and necessary for anyone added since it was last
  // handed out.
  try {
    const roster = await Api.contacts(identity)
    await fanOutMyProfileKey(identity, roster, pk)
  } catch {
    /* an unreachable contact asks with `pkeyask` instead */
  }

  // §5e: a cross-island contact reads the picture from THEIR island, so the
  // new blob has to be deposited there and the key handed over in the sealed
  // snapshot. Only after the read-back: never announce a picture this island
  // did not keep.
  void pushProfileToCrossIslandContacts(identity)
  return newId
}
