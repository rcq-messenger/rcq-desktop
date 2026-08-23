// The sections slot: read it, merge it, write it back.
//
// The transport is vault.ts and is not reinvented here: `writeSlot` already
// owns the #605 read-merge-write loop (a write names the version it was based
// on; the island answers 409 with the current one and the loop goes around).
// What this file adds is the two halves the loop takes as arguments: the merge
// (sections.ts, pure) and the rollback floor.
//
// Both directions go through the SAME merge:
//   read   cache = merge(cache, remote)
//   write  next  = merge(decode(remote), cache),  null when nothing moved
//
// ⚠ A `rolled_back` must NOT clear the floor and rewrite the slot from local
// state: there is no server-side truth to rebuild from here, and the same
// answer now holds for the contacts mirror, which used to clear it (the
// island cannot tell "restored from a backup" apart from "your derivation was
// retired by /auth/reissue", and rewriting under a retired derivation
// republishes the very ciphertext the reissue existed to destroy). It stops
// the sync for this session, keeps rendering the cache, and says so in the
// log. The floor itself lives in vault.ts and is keyed by SLOT NAME, so a
// fresh derivation starts at zero instead of inheriting a floor it can never
// reach.

import type { WebIdentity } from './crypto'
import { scopedKey } from './account-scope'
import { fetchServerInfo } from './server-info'
import { isForeignGroupId, refByAlias } from './visited-islands'
import {
  jsonBytes,
  lastSeenVersion,
  readSlot,
  rememberVersion,
  slotId,
  VAULT_SECTIONS,
  VaultError,
  writeSlot,
} from './vault'
import { loadSectionsTree, saveSectionsTree } from './sections-store'
import {
  assertWritable,
  decode,
  dropExpired,
  forgetMember,
  groupKey,
  merge,
  sameContent,
  SectionsError,
  touchTree,
  userSections,
  type SectionsTree,
} from './sections'

/// A drag ends in one write, not one per frame. 240 puts an account per hour
/// is the budget; a reorder is the only gesture that can produce a burst.
const PUSH_DEBOUNCE_MS = 800

/// "This device has an edit the island has not confirmed." Persisted, because
/// the case that matters most is the one that outlives the tab: a section made
/// on a train, a write that failed, the browser closed, and on the next cold
/// start the island's version has not moved either, so nothing would have
/// looked. The flag is set the moment the cache is edited and cleared only
/// when a write comes back saying the island's copy includes ours.
const PENDING_KEY = 'vault.sections.pending'

function markPending(on: boolean) {
  try {
    if (on) localStorage.setItem(scopedKey(PENDING_KEY), '1')
    else localStorage.removeItem(scopedKey(PENDING_KEY))
  } catch {
    /* no storage: the edit is not durable either, so nothing to remember */
  }
}

/// Does this device owe the island a write? Read by the reconnect sweep.
export function sectionsPushPending(): boolean {
  try {
    return localStorage.getItem(scopedKey(PENDING_KEY)) === '1'
  } catch {
    return false
  }
}

/// Set for the rest of the session when the island serves a version below the
/// floor, or when the account's derivation was retired under us
/// (`vault_reset`). Keyed by account so switching accounts in one tab clears
/// it.
let rolledBackFor: number | null = null

/// Stop the slot for this session, from outside: `/auth/reissue` on another
/// device retired the derivation this browser's slot name and key come from,
/// so anything written from here would be sealed with a key the user has just
/// declared dead, under a name nothing will ever read again.
export function retireSectionsSync(uin: number): void {
  rolledBackFor = uin
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
}

/// Does this island run a vault at all? Sections are hidden entirely without
/// it: a local-only fallback would create state that syncs badly the day the
/// island upgrades.
export async function sectionsAvailable(identity: WebIdentity): Promise<boolean> {
  const info = await fetchServerInfo(identity.apiBase)
  return info?.capabilities.vault === true
}

/// The rollback floor, for the reconnect sweep: a slot whose version on the
/// island is no higher than this has nothing new in it. Kept in vault.ts, per
/// SLOT NAME (see the note there: a name outlives nothing, an account does).
export function lastSeenSectionsVersion(identity: WebIdentity): number {
  return lastSeenVersion(slotId(identity, VAULT_SECTIONS))
}

/// Read the island's copy and fold it into the cache. The read path: boot, a
/// `vault_changed` nudge, and every socket reconnect (the nudge is pub/sub
/// with no replay, so a device whose socket was down never hears it).
///
/// Never throws. Returns the tree now in the cache, or null when the slot was
/// unreadable or the island has no vault.
export async function syncSections(identity: WebIdentity): Promise<SectionsTree | null> {
  if (rolledBackFor === identity.uin) return null
  if (!(await sectionsAvailable(identity))) return null
  const slot = slotId(identity, VAULT_SECTIONS)
  try {
    const r = await readSlot(identity, slot, lastSeenVersion(slot))
    const remote = decode(r.plaintext)
    if (remote === null) {
      // A newer format. Render the built-ins, write nothing, and do not touch
      // the cache: whatever is in there was written by this build and is still
      // the best it can show.
      console.info('[sections] slot is newer than this build; not syncing')
      return null
    }
    rememberVersion(slot, r.version)
    const next = merge(loadSectionsTree(), remote)
    saveSectionsTree(next)
    // ⚠ AND THIS IS THE RETRY. A write that failed (offline, a 429 against the
    // 240-an-hour budget, a 5xx, a conflict loop) leaves an edit sitting in
    // the cache and nothing else was ever going to send it: `pushSections` has
    // no caller but `mutateSections`, so a section made on a train reached the
    // island only if the user happened to edit sections again, online. The
    // read path is the one thing that runs on boot, on the nudge and on every
    // reconnect, so it is where the outstanding write belongs.
    //
    // The condition is the merge's own answer, not a dirty flag: if folding
    // the cache into what the island holds changes what the island holds, the
    // island is missing something of ours. No state to keep in step, and
    // nothing to push in the ordinary case where it agrees.
    if (!sameContent(next, remote)) void pushSections(identity)
    return next
  } catch (e) {
    if (e instanceof VaultError && e.code === 'rolled_back') {
      rolledBackFor = identity.uin
      console.warn('[sections] island served a version below the floor; sync stopped for this session')
    }
    return null
  }
}

/// Apply a local edit and get it to the island.
///
/// The cache is updated first and synchronously, because the list has to
/// repaint at the speed of the tap; the write goes behind it. `defer` coalesces
/// a burst (the drag reorder) into one put.
///
/// Throws [SectionsError] from the caps before anything is saved, so the UI can
/// say "this section is full" instead of writing a blob the island will refuse.
export function mutateSections(
  identity: WebIdentity | null,
  edit: (tree: SectionsTree) => SectionsTree,
  opts: { defer?: boolean } = {},
): SectionsTree {
  const next = edit(loadSectionsTree())
  assertWritable(next)
  saveSectionsTree(next)
  markPending(true)
  if (!identity) return next
  if (opts.defer) schedulePush(identity)
  else void pushSections(identity)
  return next
}

let pushTimer: ReturnType<typeof setTimeout> | null = null

function schedulePush(identity: WebIdentity) {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    void pushSections(identity)
  }, PUSH_DEBOUNCE_MS)
}

/// One write in flight at a time. Two overlapping read-merge-write loops on
/// the same slot are legal (the island's 409 sorts them out) but they burn the
/// hourly budget for nothing.
let inFlight: Promise<void> = Promise.resolve()

/// Push the cache. Resolves when the island holds a tree that includes it, or
/// when there was nothing to send.
export function pushSections(identity: WebIdentity): Promise<void> {
  const run = inFlight.then(() => pushOnce(identity))
  inFlight = run.catch(() => {})
  return run
}

async function pushOnce(identity: WebIdentity): Promise<void> {
  if (rolledBackFor === identity.uin) return
  if (!(await sectionsAvailable(identity))) return
  const slot = slotId(identity, VAULT_SECTIONS)
  const now = Date.now()
  // A box rather than a plain `let`: the assignments happen inside the merge
  // callback, and the compiler cannot see that the callback ran.
  const landed: { tree: SectionsTree | null } = { tree: null }
  try {
    const version = await writeSlot(
      identity,
      slot,
      (remote) => {
        const cur = decode(remote)
        // Unreadable (a newer `v`, or bytes that are not the tree): writing
        // would erase whatever wrote it. Leave the slot alone.
        if (cur === null) return null
        const next = dropExpired(merge(cur, loadSectionsTree()), now)
        if (sameContent(next, cur)) {
          landed.tree = cur
          return null
        }
        assertWritable(next)
        landed.tree = next
        return jsonBytes(next)
      },
      lastSeenVersion(slot),
    )
    rememberVersion(slot, version)
    // The island's copy now includes ours, so the cache becomes the merged
    // tree rather than the local one. Fold rather than replace: a tap that
    // landed while the put was in the air must not be thrown away.
    if (landed.tree) saveSectionsTree(merge(loadSectionsTree(), landed.tree))
    // ...and only here. A write that threw leaves the flag standing, which is
    // what makes the next sync look. A tap that landed while this put was in
    // the air queued a push of its own behind it (`inFlight` serialises them),
    // so the flag is decided by the LAST write to finish, not by this one.
    markPending(false)
  } catch (e) {
    if (e instanceof VaultError && e.code === 'rolled_back') {
      rolledBackFor = identity.uin
      console.warn('[sections] island served a version below the floor; sync stopped for this session')
      return
    }
    if (e instanceof SectionsError) {
      console.warn(`[sections] refused to write: ${e.code}`)
      return
    }
    // Offline, or the island is unhappy (a 5xx, or a 429 against the
    // 240-an-hour put budget). The cache keeps the edit and `syncSections`
    // sends it: it runs on boot, on the `vault_changed` nudge and on every
    // socket reconnect, and it pushes whenever folding the cache into the
    // island's copy would change the island's copy. That is the whole retry,
    // and until 23.08 it did not exist: this line said "will retry on the next
    // sync" while the read path only ever merged inwards.
    console.info('[sections] write failed; the next sync will send it')
  }
}

/// Account switch inside one tab (the page reloads, but a burn does not).
export function resetSectionsSyncState(): void {
  rolledBackFor = null
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
}

/// The member key for a group row, or null when this device cannot name the
/// group in a way another device would recognise.
///
/// ⚠⚠ A foreign group's `id` in this client is the LOCAL ALIAS: a negative
/// number handed out in first-sight order by visited-islands.ts, different in
/// every browser and on every phone. Putting one in the slot would file this
/// chat here and a different chat, or none, over there. The slot only ever
/// holds (remoteId, host), and this is the edge where that translation
/// happens.
export function sectionKeyForGroup(g: { id: number; host?: string | null }): string | null {
  if (isForeignGroupId(g.id)) {
    const ref = refByAlias(g.id)
    return ref ? groupKey(ref.remoteId, ref.host) : null
  }
  return groupKey(g.id)
}

/// Take a chat out of whatever section holds it, because it is going away on
/// THIS device on purpose: a contact removed, a group left, a cross-island
/// peer deleted. Writes the member tombstone in the same operation.
///
/// ⚠ This is the only pruning there is. Nothing prunes because a chat failed
/// to render: one failed roster fetch would then empty the account's sections
/// everywhere.
///
/// ⚠⚠ WRITE TIMING IS THE SIDE CHANNEL HERE, not the blob. This runs directly
/// after `DELETE /contacts/{uin}`, `POST /groups/{id}/leave` and the
/// cross-island equivalent, and until 23.08 it wrote the slot ONLY when the
/// chat turned out to be filed. The island cannot read the slot, but it can
/// read its own request log: a delete followed within a moment by a put on
/// this account's second, rarely-written slot said "that uin was in one of
/// their sections", and a delete followed by nothing said the opposite. For
/// the common account whose only user section is the PIN-gated one, that
/// reconstructs the hidden membership one removal at a time, which is exactly
/// what sealing it was for.
///
/// So the write is unconditional whenever the account has any user section at
/// all: a removal that changed nothing still stamps `w` and still puts. It is
/// deferred as well, so the put does not sit against the API call in the log.
/// An account with no user sections writes nothing and has nothing to hide.
export function forgetSectionMember(identity: WebIdentity | null, key: string | null): void {
  if (!key) return
  if (userSections(loadSectionsTree()).length === 0) return
  mutateSections(identity, (tree) => forgetMember(tree, key) ?? touchTree(tree), { defer: true })
}
