// Cross-island rooms (federation §5c), the CLI's thin glue over the web's own
// mechanism. Nothing here re-implements the protocol: guest registration,
// alias ids and the guest-mailbox drain all come from src/lib/visited-islands
// (and multihome under it), which are React-free and localStorage-backed, so
// they run under the CLI's FileStorage shim unchanged. What lives here is the
// argument parsing, the snapshot bookkeeping, and the one wrinkle a process
// that dies between commands adds: guest jwts are memory-only by design
// (visited-islands.ts keeps them off disk), so every fresh process re-mints
// them through the recover handshake, which `ensureGuestAuth` does on demand.
//
// ⚠ `groupApiCtx` from the web is deliberately NOT used for API calls: it is
// synchronous and hands back whatever token is in memory, which on a fresh
// CLI process is none, and api.ts refuses to run its refresher for a guest
// 401 (the refresher mints against the HOME island). `foreignGroupCtx` below
// goes through `ensureGuestAuth`, which recovers a token first.

import { Api, type RCQGroup } from '../../src/lib/api'
import { contactsCache, persistSnapshot } from '../../src/lib/contacts-cache'
import type { WebIdentity } from '../../src/lib/crypto'
import { parseGroupInvite } from '../../src/lib/group-invite'
import {
  aliasFor,
  ensureGuestAuth,
  listVisitedIslands,
  refByAlias,
} from '../../src/lib/visited-islands'
import { tr } from './i18n'
import { visitedTrusted } from './island-trust'

/// What `join` was given: a bare id (host null, today's home-island path), a
/// `<gid>@<host>`, or a full invite link (https://rcq.app/g/<gid>[@host] and
/// rcq://group/..., both via the web's parser). Null = not a join target.
///
/// The host may carry the island's fingerprint (`<gid>@<host>#<fp>`, §3 of the
/// island-fingerprint design); it is handed on as typed, fragment included,
/// for joinForeignRoom to pin BEFORE the first packet. Not stripped here: a
/// fragment dropped on the way is a first-use pin taken while the person
/// believes they pinned.
export function parseJoinTarget(raw: string): { gid: number; host: string | null } | null {
  const s = raw.trim()
  if (!s) return null
  const link = parseGroupInvite(s)
  if (link) return { gid: link.id, host: link.host }
  // Same split as the blocklist's uin@host: lastIndexOf, so a host that
  // somehow carries an @ cannot shift the boundary.
  const at = s.lastIndexOf('@')
  if (at > 0) {
    const gid = Number(s.slice(0, at).replace(/^g/i, ''))
    const host = s.slice(at + 1).trim()
    if (!Number.isInteger(gid) || gid <= 0 || !host) return null
    return { gid, host }
  }
  const gid = Number(s.replace(/^g/i, ''))
  return Number.isInteger(gid) && gid > 0 ? { gid, host: null } : null
}

/// The (identity, server-side gid, host) every group API call about a foreign
/// room must use. Throws a human-readable line when the alias dangles or the
/// island cannot be signed into right now.
export interface ForeignCtx {
  ident: WebIdentity
  gid: number
  host: string
}

export function isForeignGroupId(gid: number): boolean {
  return gid < 0
}

export async function foreignGroupCtx(identity: WebIdentity, aliasGid: number): Promise<ForeignCtx> {
  const ref = refByAlias(aliasGid)
  if (!ref) throw new Error(tr('group.gone'))
  // The trust gate before the first packet: a room's island whose certificate
  // changed is refused, not signed into.
  if (!(await visitedTrusted(ref.host))) throw new Error(tr('island.trust.refusedLine', { host: ref.host }))
  const guest = await ensureGuestAuth(identity, ref.host)
  if (!guest) throw new Error(tr('visited.noAuth', { host: ref.host }))
  return { ident: guest, gid: ref.remoteId, host: ref.host }
}

/// The uin WE hold in this room. In a foreign room that is the guest uin the
/// host island issued to this keypair, not the home number: the roster rows,
/// the owner field and the exempt set over there all speak in host-island
/// uins, and comparing them against the home uin would misread every rule.
export function myUinInRoom(identity: WebIdentity, group: RCQGroup): number {
  if (!isForeignGroupId(group.id)) return identity.uin
  const ref = refByAlias(group.id)
  const v = ref ? listVisitedIslands().find((x) => x.host === ref.host) : undefined
  return v?.uin ?? identity.uin
}

/// Put one foreign room into the warm snapshot (under its ALIAS id, host
/// tagged), so /g, labels, the rules and `rcq groups` see it immediately,
/// before the next directory refresh re-reads it from the island.
export function rememberForeignGroup(myUin: number, row: RCQGroup): void {
  const prev = contactsCache.get(myUin) ?? { contacts: [], groups: [], pending: [], me: null }
  persistSnapshot(myUin, { ...prev, groups: [...prev.groups.filter((g) => g.id !== row.id), row] })
}

/// Take one foreign room out (leave): the alias mapping itself is kept, like
/// the web keeps it - stable per account, and rejoining reuses it.
export function dropForeignGroup(myUin: number, aliasGid: number): void {
  const prev = contactsCache.get(myUin)
  if (!prev) return
  persistSnapshot(myUin, { ...prev, groups: prev.groups.filter((g) => g.id !== aliasGid) })
}

/// The rooms this account is in on every visited island, ids rewritten to the
/// local alias and the host tagged on, exactly at the fetch boundary like the
/// web's Contacts page. Per island: one recover handshake when this process
/// has not touched it yet (guest jwts never rest on disk), one GET /groups.
/// An island that does not answer keeps its rooms from the last snapshot
/// (`prevForeign`) rather than blinking them out of every list.
export async function fetchForeignGroups(identity: WebIdentity, prevForeign: RCQGroup[]): Promise<RCQGroup[]> {
  const out: RCQGroup[] = []
  for (const v of listVisitedIslands()) {
    const kept = prevForeign.filter((g) => g.host === v.host)
    // A refused island keeps its rooms from the last snapshot, like one that
    // does not answer; the gate has said why on stderr.
    if (!(await visitedTrusted(v.host))) {
      out.push(...kept)
      continue
    }
    try {
      const guest = await ensureGuestAuth(identity, v.host)
      if (!guest) {
        out.push(...kept)
        continue
      }
      const list = await Api.groups(guest, false)
      out.push(...list.map((g) => ({ ...g, id: aliasFor(v.host, g.id), host: v.host })))
    } catch {
      out.push(...kept)
    }
  }
  return out
}
