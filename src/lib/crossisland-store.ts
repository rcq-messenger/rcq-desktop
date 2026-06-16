// Federation Layer B (F2) — local store of cross-island contacts.
//
// A peer on ANOTHER island is not a flagship user, so it can't live in the
// server-side /contacts list (there's no cross-island contact-request handshake).
// We keep cross-island contacts purely on this device, keyed by `uin@host`
// (uin is per-island, so the host is part of the identity of the handle).
//
// These carry the peer's pinned public keys (from their island's open key card)
// for display + future safety-number verification; the actual send re-resolves
// via federation-send so a moved peer still gets reached.

export interface CrossIslandContact {
  uin: number
  host: string
  nickname: string
  identityKey: string            // v=1 X25519 (base64)
  signingKey: string             // v=1 Ed25519 (base64)
  signalIdentityKey?: string | null // v=2 libsignal / safety-number key (base64)
  addedAt: number
  // §5c display, from the open card (optional; old entries lack them).
  gender?: string | null
  statusMessage?: string | null
}

const KEY = 'rcq.web.crossisland.v1'

export function ciKey(uin: number, host: string): string {
  return `${uin}@${host.toLowerCase()}`
}

function loadAll(): Record<string, CrossIslandContact> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, CrossIslandContact>
  } catch {
    return {}
  }
}

function saveAll(map: Record<string, CrossIslandContact>): void {
  localStorage.setItem(KEY, JSON.stringify(map))
}

export function getCrossIsland(uin: number, host: string): CrossIslandContact | null {
  return loadAll()[ciKey(uin, host)] ?? null
}

export function saveCrossIsland(c: CrossIslandContact): void {
  const map = loadAll()
  map[ciKey(c.uin, c.host)] = c
  saveAll(map)
}

export function listCrossIsland(): CrossIslandContact[] {
  return Object.values(loadAll()).sort((a, b) => b.addedAt - a.addedAt)
}

/// Look up a cross-island contact by bare uin (for mapping an incoming sealed
/// message's senderUIN back to its thread). Per-island uins can collide in
/// theory; returns the first match, which is adequate for the common case.
export function findCrossIslandByUin(uin: number): CrossIslandContact | null {
  return listCrossIsland().find((c) => c.uin === uin) ?? null
}

export function removeCrossIsland(uin: number, host: string): void {
  const map = loadAll()
  delete map[ciKey(uin, host)]
  saveAll(map)
}
