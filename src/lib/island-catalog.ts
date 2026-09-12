// The public island catalogue and the paintings that go with it.
//
// Shared by the picker's deck (IslandCarousel) and by anything that needs to
// know which islands exist without a React tree around it. React-free and
// storage-guarded like island-card.ts: remembered-islands.ts reads the
// catalogue to fill in a region, and that module has no React either.
//
// The catalogue is servers.json on rcq.app, a file the team edits by hand a few
// times a year. The last copy is kept on disk so the deck is complete on its
// first frame and still lists something when rcq.app is unreachable (the
// picker is the one screen that has to work on a blocked network: it is where
// a person finds the island that is NOT blocked), and it is refreshed on every
// open the way iOS does it (ServerDirectoryService), so a price or a blurb
// edited this morning is right by the second frame.
//
// ⚠ Public data only: name, host, region, blurb, a mirrored logo URL. Nothing
// here records which island a person actually reached. That list lives in
// remembered-islands.ts under its own key, where a catalogue refresh cannot
// overwrite it (founder, 12.09: the hand-typed island was lost between
// accounts because the only places it existed were places other writes
// clobbered).
//
// The painting for an island is one of nine cut-outs the site's hero and the
// phones already draw, chosen by FNV-1a over the host so the same island is the
// same picture on all four clients (IslandCatalog.artIndex on Android,
// IslandArtStore.index on iOS): island-1 for the flagship, 2..9 for the rest.
// ⚠ Shipped in public/islands rather than fetched from rcq.app: chat.rcq.app's
// CSP admits images from itself only (#815), and a painting that needs rcq.app
// would be missing on exactly the network where the picker matters most.

import { normaliseIsland } from './island-choice'

export interface CatalogIsland {
  url: string
  name?: string
  description?: string
  region?: string
  /// The island's logo, mirrored on the site (Android reads it so the picker
  /// does not have to ask five islands for their logos). Unused here: the web
  /// already draws the island's own logo through IslandAvatar off the same
  /// /server/info the door line needs, and one road is better than two.
  logo?: string
}

export const CATALOG_URL = 'https://rcq.app/servers.json'
export const FLAGSHIP = 'https://api.rcq.app'

const CACHE_KEY = 'rcq.web.catalog.v1'

let memory: CatalogIsland[] | null = null

function sane(list: unknown): CatalogIsland[] {
  if (!Array.isArray(list)) return []
  return list.filter((s): s is CatalogIsland => !!s && typeof s === 'object' && typeof (s as CatalogIsland).url === 'string')
}

/// The last catalogue this browser saw, or null when it never saw one. Off
/// memory first, then off disk. Never throws.
export function cachedCatalog(): CatalogIsland[] | null {
  if (memory) return memory
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { servers?: unknown }
    memory = sane(parsed.servers)
    return memory
  } catch {
    return null
  }
}

/// Ask rcq.app for the catalogue and keep the answer. Throws when the fetch
/// fails, so the caller can say the catalogue is unreachable and fall back on
/// the cached copy, or on the flagship alone.
export async function fetchCatalog(): Promise<CatalogIsland[]> {
  const res = await fetch(CATALOG_URL)
  if (!res.ok) throw new Error(`catalogue ${res.status}`)
  const body = (await res.json()) as { servers?: unknown }
  const list = sane(body.servers)
  memory = list
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ servers: list }))
  } catch {
    /* storage disabled or full: memory still has it for this run */
  }
  return list
}

/// The base URL of a catalogue row, normalised the way every other island
/// address in this tree is (`https://host[:port]`, no trailing slash).
export function catalogBase(s: CatalogIsland): string {
  return normaliseIsland(s.url).base
}

/// The catalogue row for a base, if the catalogue we hold has one.
export function catalogEntry(base: string): CatalogIsland | null {
  const list = cachedCatalog()
  if (!list) return null
  return list.find((s) => catalogBase(s) === base) ?? null
}

/// Which of the nine paintings an island gets. ⚠ FNV-1a over the AUTHORITY
/// (`host[:port]`, lowercased, no scheme), the string Android hashes as
/// `host` and iOS as the URL's host, so an island is the same picture on
/// every client. Not a JS string hash: a different hash is a different
/// picture on the desktop for the same island, which reads as two islands.
export function artIndex(base: string): number {
  const authority = base.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase()
  if (authority === 'api.rcq.app') return 1
  let hash = 2166136261
  for (const byte of new TextEncoder().encode(authority)) {
    hash = Math.imul(hash ^ byte, 16777619) >>> 0
  }
  return 2 + (hash % 8)
}

export function islandArtPath(base: string): string {
  return `/islands/island-${artIndex(base)}.png`
}

/// Intrinsic pixel size of each cut-out, set as the <img> width/height so the
/// browser reserves the right aspect box BEFORE the file loads and the card
/// does not pop when it lands. Copied from the site's hero
/// (web/src/components/FederationPage.tsx), which ships the same nine files.
export const ISLAND_DIMS: Record<number, [number, number]> = {
  1: [414, 440], 2: [440, 439], 3: [394, 440], 4: [404, 440], 5: [325, 440],
  6: [440, 430], 7: [434, 440], 8: [349, 440], 9: [376, 440],
}

export function islandArtDims(base: string): [number, number] {
  return ISLAND_DIMS[artIndex(base)] ?? [420, 440]
}
