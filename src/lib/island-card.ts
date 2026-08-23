// What an island looks like, kept across reloads.
//
// The name and the logo version come from `/server/info`, which is a network
// call, and they are drawn in places that must be complete on the FIRST frame:
// the island line on the login screen, the account rows in Settings, the island
// card. Without a cache every one of those flashed a lettered tile and the bare
// host for as long as the request took, on every single visit.
//
// Same division the phones make. iOS keeps an `AccountCard` per account in
// UserDefaults and draws its switcher from disk (ContactListView.swift);
// Android keeps `AccountCards` in SharedPreferences and says the same thing in
// its file comment: "no island is asked anything to draw this screen".
//
// ⚠ Keyed by ISLAND, not by account, and deliberately NOT account-scoped
// (`account-scope.ts`). An island's public name and its logo are the same for
// everybody on it, they are not secrets, and the account switcher has to be
// able to draw a row for an account whose scope is not the mounted one. This is
// the same reasoning iOS spells out for keeping its cards in UserDefaults
// rather than in the sealed per-account roster files.
//
// React-free and dependency-free, because `server-info.ts` imports it and that
// module is bundled into the CLI, which runs in node where there is no
// localStorage at all. Every access is guarded.

export interface IslandCard {
  /// What the island calls itself. '' when it has never answered or its
  /// operator left the field blank; callers fall back to the host, which is all
  /// anybody honestly knows.
  name: string
  /// Digest of its logo, '' for "no logo" (draw the lettered tile). Rides on
  /// the picture's URL as `?v=`, so a changed logo is a changed URL.
  logoVersion: string
}

const PREFIX = 'rcq.island.'

function key(apiBase: string): string {
  return PREFIX + apiBase.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase()
}

/// What we last heard from this island, or null. Never throws: a browser with
/// storage disabled just draws the tile until the fetch lands.
export function islandCard(apiBase: string | undefined | null): IslandCard | null {
  if (!apiBase) return null
  try {
    const raw = localStorage.getItem(key(apiBase))
    if (!raw) return null
    const card = JSON.parse(raw) as IslandCard
    return typeof card?.name === 'string' && typeof card?.logoVersion === 'string' ? card : null
  } catch {
    return null
  }
}

/// Remember what an island answered. Called from the one place that parses
/// `/server/info`, so nothing else has to remember to.
///
/// ⚠ A blank name does NOT overwrite a known one, for the same reason iOS
/// guards `AccountCardCache.record`: an island that is momentarily answering
/// with an empty name (or a reply that raced ahead of the operator's own
/// settings row) would otherwise wipe the name the switcher has been drawing,
/// and the screen would lose it for a beat on every launch. A blank
/// logoVersion is a different matter and IS believed: it is the operator
/// removing the logo, and that has to take effect.
export function rememberIslandCard(apiBase: string, card: IslandCard): void {
  try {
    const merged: IslandCard = { ...card }
    if (!merged.name) {
      const existing = islandCard(apiBase)
      if (existing?.name) merged.name = existing.name
    }
    localStorage.setItem(key(apiBase), JSON.stringify(merged))
  } catch {
    /* storage disabled or full: the run-long memory cache still has it */
  }
}
