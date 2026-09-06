// Keeping the vault slots fresh: the nudge, and the reconnect sweep.
//
// The island fans out `vault_changed {slot, version}` to every session of the
// account whenever a slot moves (SPEC §4.9). Until now NO client listened for
// it and none re-read a slot on reconnect, so a contact list sealed by the
// phone reached this browser on its next cold start and not before. Sections
// make that visible immediately: a section made on the desktop has to appear
// on the phone, and the other way round.
//
// Two paths, because one of them is not enough:
//
//   * the nudge, for the device that is connected right now. Cheap and
//     immediate.
//   * the sweep on every socket (re)connect, because the nudge is pub/sub with
//     NO REPLAY: a device whose socket was down when the other one wrote never
//     hears it, and a reconnect is exactly the moment that gap closes. One
//     `GET /vault` (slots and versions, no blobs) tells us what moved, and only
//     the slots that moved are actually fetched.
//
// ⚠ Slot names are hashes. `slot` on the wire is 32 hex characters that mean
// nothing without the account's identity key, so the frame is matched by
// deriving both names locally rather than by comparing strings to "contacts".

import type { WebIdentity } from './crypto'
import { syncRoomKeysWithVault } from './group-state'
import {
  forgetVersion,
  listSlots,
  slotId,
  VAULT_CONTACTS,
  VAULT_CROSSISLAND,
  VAULT_SECTIONS,
  type VaultChangedFrame,
} from './vault'
import {
  buryCrossIsland,
  lastSeenCrossIslandVersion,
  retireCrossIslandSync,
  scheduleCrossIslandPush,
  syncCrossIsland,
} from './crossisland-vault'
import { setCrossIslandListener } from './crossisland-store'
import {
  invalidateContactsMirror,
  lastSeenContactsVersion,
  readContactsFromVault,
  retireContactsMirror,
} from './contacts-vault'
import {
  lastSeenSectionsVersion,
  retireSectionsSync,
  sectionsPushPending,
  syncSections,
} from './sections-vault'

/// A socket that keeps dying redials on a curve that starts at one second, and
/// each redial that succeeds would otherwise be a sweep. One every fifteen
/// seconds is plenty for a change another device just made.
const SWEEP_FLOOR_MS = 15_000
let lastSweep = 0

/// `vault_changed` from the socket. The writer hears its own nudge too and
/// drops it by version: the floor is already at or above what the frame names.
export async function handleVaultChanged(identity: WebIdentity, frame: VaultChangedFrame): Promise<void> {
  if (!frame || typeof frame.slot !== 'string') return
  const version = typeof frame.version === 'number' ? frame.version : 0
  if (frame.slot === slotId(identity, VAULT_SECTIONS)) {
    if (version > 0 && version <= lastSeenSectionsVersion(identity)) return
    await syncSections(identity)
    return
  }
  if (frame.slot === slotId(identity, VAULT_CONTACTS)) {
    if (version > 0 && version <= lastSeenContactsVersion(identity)) return
    await refreshContactsSlot(identity)
    return
  }
  if (frame.slot === slotId(identity, VAULT_CROSSISLAND)) {
    if (version > 0 && version <= lastSeenCrossIslandVersion(identity)) return
    await syncCrossIsland(identity)
  }
}

/// `vault_reset` from the socket: `POST /auth/reissue` on another device
/// rotated the account's identity, and the island emptied the vault in the
/// same transaction (SPEC §4.9, `backend/app/routers/auth.py`).
///
/// ⚠ NOT a wipe, and not a republish either. The slot NAMES and the seal key
/// are derived from `identity_priv`, and this browser is holding the retired
/// one: it cannot write anything the new derivation will ever read, and what
/// it CAN still write is the whole contact list, sealed with the key the user
/// has just declared compromised, under the old name. So both slots stop for
/// this session and the local caches are left exactly as they are (they are
/// the only copy of the sections tree in existence until a device with the new
/// identity publishes one).
///
/// The stored floors go, because they belong to names that will never be read
/// again and a stale floor is what locks a fresh derivation out of its own
/// slot for good.
///
/// ⚠ Nobody was listening for this frame at all until 23.08: the island has
/// been sending it since the reissue path learned to announce itself, and a
/// second device went on publishing under the retired derivation.
export function handleVaultReset(identity: WebIdentity): void {
  forgetVersion(slotId(identity, VAULT_SECTIONS))
  forgetVersion(slotId(identity, VAULT_CONTACTS))
  forgetVersion(slotId(identity, VAULT_CROSSISLAND))
  retireSectionsSync(identity.uin)
  retireContactsMirror(identity.uin)
  retireCrossIslandSync(identity.uin)
  console.warn('[vault] the account rotated its identity elsewhere; this derivation is retired')
}

/// Boot and every reconnect. `force` skips the floor (the boot call).
export async function sweepVaultSlots(identity: WebIdentity, force = false): Promise<void> {
  // The sweep is the one thing that runs at boot and on every reconnect with a
  // live identity in hand, so it is where the cross-island store's listener is
  // (re)armed. Registering it anywhere a page can unmount would leave local
  // adds unmirrored for the rest of the session.
  armCrossIslandMirror(identity)
  const now = Date.now()
  if (!force && now - lastSweep < SWEEP_FLOOR_MS) return
  lastSweep = now
  let slots: Map<string, number>
  try {
    slots = await listSlots(identity)
  } catch {
    // No vault on this island, or it is unreachable. Either way there is
    // nothing to compare against and nothing to do.
    return
  }
  const sections = slots.get(slotId(identity, VAULT_SECTIONS)) ?? 0
  // ⚠ The version is not the only reason to sync. A device that owes the
  // island a write (offline when the section was made, 429, 5xx) has to be
  // let in even though the island's copy has not moved: `syncSections` merges
  // both ways and sends what is outstanding. Without this the sweep looks at
  // an unchanged version, decides there is nothing to do, and the section
  // stays on one device forever.
  if (sections > lastSeenSectionsVersion(identity) || sectionsPushPending()) {
    await syncSections(identity)
  }
  const contacts = slots.get(slotId(identity, VAULT_CONTACTS)) ?? 0
  if (contacts > lastSeenContactsVersion(identity)) await refreshContactsSlot(identity)
  // ⚠ Unconditionally, unlike the two above. This slot is not a mirror of
  // anything the island can be asked for again: an unchanged version means the
  // island has not moved, NOT that it holds what this device holds, and a
  // device whose write failed (offline, 429, 5xx) is exactly the one carrying
  // rows nothing else has. The sync itself is a no-op when both sides agree.
  await syncCrossIsland(identity)
  // Room state keys (stage 6 phase 2): same sweep, same quietness. The sync
  // itself decides whether either side is missing anything.
  await syncRoomKeysWithVault(identity)
}

/// The contacts slot is still a MIRROR of the island's own list (stage 4,
/// mirror phase), so re-reading it does not change what the page draws. What
/// it does do is move the rollback floor up to what another device just wrote,
/// which is what keeps this browser's next mirror write from opening with a
/// 409, and drop the "already folded this list" fingerprint so the next
/// `/contacts` refresh folds against the fresh copy instead of assuming its
/// own is current.
/// Point the cross-island store at this account's slot. Idempotent: the same
/// identity re-registers the same closure, and a different one replaces it.
let armedFor: number | null = null
function armCrossIslandMirror(identity: WebIdentity): void {
  if (armedFor === identity.uin) return
  armedFor = identity.uin
  setCrossIslandListener((e) => {
    if (e.kind === 'removed') buryCrossIsland(e.uin, e.host, Date.now())
    scheduleCrossIslandPush(identity)
  })
}

async function refreshContactsSlot(identity: WebIdentity): Promise<void> {
  await readContactsFromVault(identity)
  invalidateContactsMirror()
}
