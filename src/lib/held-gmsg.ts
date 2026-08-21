// In-memory hold buffer for `gmsg` broadcasts that arrived BEFORE the SKDM
// carrying their sender key (mirrors Android's heldGmsg). A queue drain is
// ordered (skdm rows are served first), so this bites the live-socket path:
// without the hold such a broadcast failed to decrypt once and was gone.
//
// Deliberately NOT persisted. The common race is seconds wide (the sender
// posts skdm and gmsg back to back) and a reload inside it lands on a
// connect drain, where the island replays the still-unacked live row in the
// right order anyway. The residual case (a sweep drain already acked the
// gmsg and the page reloads before the NACK answer lands) would need the
// NACK debounce state persisted too to be worth it; Android holds in memory
// as well.

/// One held broadcast, exactly as it arrived off the wire (replay re-decodes
/// it through the normal path). `e`/`i` are kept only for the dedup below.
export interface HeldGmsg {
  kid: string
  gid: number
  payloadB64: string
  e: number
  i: number
}

/// Oldest entries are dropped past this. Fifty unreadable messages per
/// account is already a broken group, and the bound keeps a hostile flood
/// of un-openable broadcasts cheap.
export const HELD_GMSG_CAP = 50

// Per-account arrival-ordered buffers, keyed by own uin: two accounts in one
// browser hold and replay independently, like every sender-key map.
const held = new Map<number, HeldGmsg[]>()

/// Buffer one undecryptable broadcast. Deduped by chain position (kid, e, i):
/// the same row can arrive live AND via a sweep drain while the key is still
/// missing, and only one copy can ever derive a message key.
export function holdGmsg(ownUin: number, entry: HeldGmsg): void {
  const list = held.get(ownUin) ?? []
  if (list.some((h) => h.kid === entry.kid && h.e === entry.e && h.i === entry.i)) return
  list.push(entry)
  if (list.length > HELD_GMSG_CAP) list.splice(0, list.length - HELD_GMSG_CAP)
  held.set(ownUin, list)
}

/// Remove and return every held broadcast under `kid`, in arrival order.
/// Entries held for other kids stay put.
export function takeHeldForKid(ownUin: number, kid: string): HeldGmsg[] {
  const list = held.get(ownUin)
  if (!list || list.length === 0) return []
  const taken = list.filter((h) => h.kid === kid)
  if (taken.length === 0) return []
  held.set(
    ownUin,
    list.filter((h) => h.kid !== kid),
  )
  return taken
}

/// How many broadcasts an account is holding (tests only).
export function heldGmsgCount(ownUin: number): number {
  return held.get(ownUin)?.length ?? 0
}
