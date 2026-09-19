// The presence chime, mounted once for the whole app.
//
// ⚠⚠ IT USED TO LIVE INSIDE THE CONTACTS PAGE, and inside a `setContacts`
// updater at that, which is three bugs in one line (#1030):
//   * scoped to one route, so the same transition was audible on /contacts and
//     silent everywhere else — "через раз" in the report;
//   * a side effect inside a state reducer, which React is free to run twice;
//   * one sound per frame, so a reconnect's burst of frames was a burst of
//     sounds.
// It lives here now: one subscription, one decision per burst, and the rule
// itself is pure and shared with Android (lib/presence-chime.ts).

import { useEffect, useRef } from 'react'
import { lookupContactStatus, snapshotFor } from './contacts-cache'
import { useIdentity } from './identity-context'
import { isPeerArchived, isPeerFavorite, isPeerMuted } from './local-store'
import {
  BURST_WINDOW_MS,
  decidePresenceChime,
  presenceIsAround,
  type PresenceFlip,
} from './presence-chime'
import { isPresenceLeaveSoundEnabled, isSoundEnabled, playSound, presenceSoundMode } from './sounds'
import { useWS } from './ws'

export function PresenceChimeWatcher() {
  const ws = useWS()
  const { identity } = useIdentity()
  const me = identity?.uin
  // Not state: nothing here draws, and a re-render per presence frame is a
  // cost this component exists to avoid.
  const pending = useRef<Map<number, PresenceFlip>>(new Map())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastChimed = useRef<Map<number, number>>(new Map())

  useEffect(() => {
    if (!me) return
    const flush = () => {
      timer.current = null
      const flips = [...pending.current.values()]
      pending.current.clear()
      if (flips.length === 0) return
      const now = Date.now()
      const pick = decidePresenceChime(
        flips,
        presenceSoundMode(),
        isPresenceLeaveSoundEnabled(),
        lastChimed.current,
        now,
      )
      if (!pick) return
      lastChimed.current.set(pick.uin, now)
      // Keep the map from growing with every contact who ever flapped.
      for (const [uin, at] of lastChimed.current) {
        if (now - at >= 5 * 60_000) lastChimed.current.delete(uin)
      }
      playSound(pick.online ? 'contact_online' : 'contact_offline')
    }

    const off = ws.on('presence', (ev) => {
      const uin = ev.uin as number | undefined
      const status = ev.status as string | undefined
      if (typeof uin !== 'number' || typeof status !== 'string') return
      if (!isSoundEnabled()) return
      // ⚠ A `presence` frame is NOT proof of a relationship: the island sends
      // one to every co-member of every group, so without this the schedule of
      // these sounds is set by strangers in rooms the person happens to share.
      const before = lookupContactStatus(me, uin)
      if (before == null) return
      const snap = snapshotFor(me)
      if (snap && !snap.contacts.some((c) => c.uin === uin)) return
      const wasAround = presenceIsAround(before)
      const isAround = presenceIsAround(status)
      if (wasAround === isAround) return
      // Archived is "I put this away", which the chime never honoured, and
      // blocked speaks for itself. Muted is checked by the rule.
      if (isPeerArchived(uin)) return
      pending.current.set(uin, {
        uin,
        online: isAround,
        favorite: isPeerFavorite(uin),
        muted: isPeerMuted(uin),
      })
      if (timer.current == null) timer.current = setTimeout(flush, BURST_WINDOW_MS)
    })
    return () => {
      off()
      if (timer.current != null) clearTimeout(timer.current)
      timer.current = null
      pending.current.clear()
    }
  }, [ws, me])

  return null
}
