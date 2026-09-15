// #985(2), first half: a nickname change reaches this account's copies on
// other islands.
//
// The copy of this account on a visited island (a group's island, §5c) or on
// a backup island is a separate row there, holding the same keys. Renaming on
// the home island rewrote only the home row, and the island tells only its
// own contacts (`contact_renamed`), so the members of a group on another
// island went on reading whatever name the copy was registered with. No
// island will ever carry it across: islands do not talk to each other, on
// purpose. The client holds a token for each copy, which makes it the only
// thing that can repeat the rename there, so it does.
//
// Avatars do not ride along yet: a picture would first have to be uploaded to
// that island, the way §5b deposits one, and that is its own change.

import { Api, ApiError } from './api'
import type { WebIdentity } from './crypto'
import { isFrontHost } from './front'
import { backupIdentityFor, hostOfApiBase, listBackupHomes, refreshBackupAuth } from './multihome'
import { listVisitedIslands, pushNicknameToVisited } from './visited-islands'

/// The nickname on our copy on backup island `host`. Same contract as
/// `pushNicknameToVisited`: the nickname alone, best effort, one recover and
/// retry on a 401.
async function pushNicknameToBackup(identity: WebIdentity, host: string, nickname: string): Promise<boolean> {
  let ident = backupIdentityFor(identity, host)
  if (!ident) return false
  // Tokens are memory-only: after a restart there is none until a drain or
  // this re-mints it, and asking with an empty bearer just spends a round trip.
  if (!ident.jwt) ident = await refreshBackupAuth(identity, host)
  if (!ident) return false
  try {
    await Api.updateProfile(ident, { nickname })
    return true
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) return false
  }
  const fresh = await refreshBackupAuth(identity, host)
  if (!fresh) return false
  try {
    await Api.updateProfile(fresh, { nickname })
    return true
  } catch {
    return false
  }
}

/// Push `nickname` to every island in this account's visited and backup
/// stores, each with that island's own token. Call after the rename has landed
/// on the home island. Fire-and-forget from the caller's side: someone else's
/// island being down must never fail, or slow, a profile save. Returns how
/// many islands took it.
///
/// ⚠ Only islands from this account's OWN stores. Never an island named by a
/// peer, a record or a link: this call carries a live token for us there.
export async function pushNicknameToGuestCopies(identity: WebIdentity, nickname: string): Promise<number> {
  const name = nickname.trim()
  if (!name) return 0
  const own = hostOfApiBase(identity.apiBase)
  // One PUT per island. The same island can sit in both stores (a backup home
  // that also hosts a group we joined), and it holds one row for us there.
  const seen = new Set<string>([own])
  const jobs: Promise<boolean>[] = []
  for (const v of listVisitedIslands()) {
    if (seen.has(v.host)) continue
    seen.add(v.host)
    jobs.push(pushNicknameToVisited(identity, v.host, name))
  }
  for (const h of listBackupHomes()) {
    if (seen.has(h.host) || isFrontHost(h.host)) continue
    seen.add(h.host)
    jobs.push(pushNicknameToBackup(identity, h.host, name))
  }
  const results = await Promise.all(jobs.map((j) => j.catch(() => false)))
  return results.filter(Boolean).length
}
