// Live group patches off the socket, in one place because the island emits
// `group_membership_changed` in TWO shapes and a screen that understands only
// the fat one goes quietly stale.
//
//   • up to 100 members → the whole `GroupOut` rides along in `group`. Roles,
//     owner, room rules, the lot. Nothing to fetch.
//   • above 100 members → the frame degrades to a compact form: the group id
//     and (since the ownership-transfer work) `owner_uin`, and nothing else.
//     The roster is the expensive half and the island will not push it to
//     everyone on every patch.
//
// ⚠ The compact form is NOT a no-op, and treating it as one is the bug this
// module exists to prevent. Handed over ownership of a room of 4000 people and
// every member's client keeps drawing the previous owner, with the owner
// badge on the wrong row, the pin button offered to somebody who no longer has
// it, and an owner-only room whose composer stays shut for the new owner,
// until the app is restarted. So: take `owner_uin` from the compact frame
// IMMEDIATELY (it is the half that re-gates the whole screen and it is right
// there in the frame), then refetch the roster behind it.
//
// ⚠ Cross-island groups ride the FOREIGN island's socket, which this client
// does not hold: those screens stay on the fetch-on-open path and pass
// `enabled: false`.

import { useEffect, useRef } from 'react'
import { Api, type RCQGroup } from './api'
import type { WebIdentity } from './crypto'
import { useWS, type WsEvent } from './ws'

/// What one `group_membership_changed` frame actually said.
export interface GroupChange {
  /// The group it is about (island-side id).
  gid: number
  /// The full snapshot, present only in the fat form.
  snapshot: RCQGroup | null
  /// Who owns the group as of this event. Present in BOTH forms: the fat one
  /// carries it inside the snapshot, the compact one as a top-level field.
  /// Null only on an older island that predates the compact form's owner.
  ownerUin: number | null
}

/// Read a socket frame of either shape. Null when it is not about a group we
/// can identify.
export function parseGroupChanged(ev: WsEvent | unknown): GroupChange | null {
  const frame = ev as { group?: RCQGroup; group_id?: unknown; owner_uin?: unknown }
  const snapshot = frame.group && typeof frame.group.id === 'number' ? frame.group : null
  const rawGid = snapshot ? snapshot.id : frame.group_id
  const gid = typeof rawGid === 'number' ? rawGid : Number(rawGid)
  if (!Number.isFinite(gid)) return null
  const rawOwner = snapshot ? snapshot.owner_uin : frame.owner_uin
  const ownerUin = typeof rawOwner === 'number' && Number.isFinite(rawOwner) ? rawOwner : null
  return { gid, snapshot, ownerUin }
}

/// One patch to apply to a locally held group.
///
/// `owner` is deliberately narrow: it is what the compact frame knows, and a
/// caller must merge it INTO the group it already holds rather than throwing
/// the roster away. The `snapshot` that follows carries the roles.
export type GroupPatch =
  | { kind: 'snapshot'; group: RCQGroup }
  | { kind: 'owner'; ownerUin: number }

/// Subscribe a screen to live patches for one group.
///
/// `apply` is called with the fat snapshot when there is one, and with the
/// owner alone the instant a compact frame arrives, followed by a snapshot
/// once the refetch lands. It is read through a ref, so passing an inline
/// closure does not churn the subscription.
export function useGroupChanged(
  args: { enabled: boolean; ident: WebIdentity | null; gid: number | null },
  apply: (patch: GroupPatch) => void,
): void {
  const ws = useWS()
  const { enabled, ident, gid } = args
  const applyRef = useRef(apply)
  applyRef.current = apply
  // The identity is rebuilt every render (groupApiCtx returns a fresh object)
  // and its token is swapped on refresh: hold it by ref so the subscription
  // neither churns on the former nor closes over a dead token on the latter.
  const identRef = useRef(ident)
  identRef.current = ident
  const uin = ident?.uin

  useEffect(() => {
    if (!enabled || gid == null || uin == null) return
    let alive = true
    const off = ws.on('group_membership_changed', (ev) => {
      const change = parseGroupChanged(ev)
      if (!change || change.gid !== gid) return
      if (change.snapshot) {
        applyRef.current({ kind: 'snapshot', group: change.snapshot })
        return
      }
      // Compact form. The owner first, because it re-gates the screen and it
      // costs nothing; the roster then follows from a fetch.
      if (change.ownerUin != null) {
        applyRef.current({ kind: 'owner', ownerUin: change.ownerUin })
      }
      const id = identRef.current
      if (!id) return
      void Api.groupInfo(id, gid)
        .then((g) => {
          if (alive) applyRef.current({ kind: 'snapshot', group: g })
        })
        .catch(() => {
          /* the owner patch above already landed; the next open refetches */
        })
    })
    return () => {
      alive = false
      off()
    }
  }, [ws, enabled, gid, uin])
}
