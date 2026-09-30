// Room link keys (report #990, step 2): the `?k=` a group link carries, the key
// an island asks for before it shows or lets anyone into a room outside its
// catalogue. Remembered here when a link is parsed (a click, a paste, a pinned
// message, a bubble), and read by the preview, the join and the guest entry,
// so nothing in between has to carry it. Memory only: a link parsed again puts
// it back. Not to be confused with the `#k=` FRAGMENT, which carries the room
// STATE key and never leaves the browser.

const keys = new Map<string, string>()

/// The key's shape: what the island's `secrets.token_urlsafe` makes.
export const ROOM_LINK_KEY = /^[A-Za-z0-9_-]{8,64}$/

function slot(host: string | null, id: number): string {
  return `${(host ?? '').toLowerCase()}#${id}`
}

export function rememberRoomLinkKey(host: string | null, id: number, k: string): void {
  if (ROOM_LINK_KEY.test(k)) keys.set(slot(host, id), k)
}

/// `hosts`: every name the room's island goes by here; for our own island that
/// is `null` (a bare id) and its host.
export function findRoomLinkKey(id: number, hosts: (string | null)[]): string | null {
  for (const h of hosts) {
    const k = keys.get(slot(h, id))
    if (k) return k
  }
  return null
}
