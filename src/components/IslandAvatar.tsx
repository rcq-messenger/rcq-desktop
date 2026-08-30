// An island's face: its operator's logo, or the lettered tile when it has none.
//
// Rounded square, not a circle: a person is a circle and a group is a circle,
// and an island is neither. Same shape iOS draws (`IslandAvatarView`) and
// Android draws (`IslandAvatar` in Common.kt), same tint from the same hash, so
// an island that has not set a logo looks like the same island on all four.
//
// ⚠⚠ THIS FALLS BACK IN FOUR DIRECTIONS AND NEVER SHOWS A BROKEN IMAGE:
//   * an island with no logo         -> `logoVersion` is '' -> the tile;
//   * an island too old to know the field -> the field is absent, which
//     `normalize` in server-info.ts reads as '' -> the tile;
//   * an island that has not answered yet (or at all) -> no card, no version
//     -> the tile, drawn on the first frame, replaced in place if a logo lands;
//   * a logo that 404s, times out, or is bytes the browser cannot decode ->
//     the <img> `onError` swaps to the tile.
// There is no state in which this renders an empty box.
//
// The bytes come through `fetch` into a blob: URL rather than a plain
// cross-origin <img src>. Not a style choice: chat.rcq.app ships
// `img-src 'self' data: blob:` (report #815 - the flagship's flower rendered
// as its letter tile on the web and nowhere else), and the CSP stays tight on
// purpose because this app renders other people's content. `connect-src`
// already admits the islands, the browser's HTTP cache still covers the
// fetch, and one run-cached object URL per logo version serves every tile on
// the screen. This is still NOT the `loadEncryptedImage` shape `PersonAvatar`
// uses: an island logo is public plaintext, nothing here decrypts.

import { useEffect, useState } from 'react'
import { islandLogoURL } from '../lib/server-info'
import { useIslandCard } from '../lib/use-server-info'

interface Props {
  /// The island to draw. Every screen that lists more than one account passes
  /// the ROW's own base, never the active one, for the same reason
  /// `PersonAvatar` does: an account living on another island keeps its face
  /// there.
  apiBase: string | undefined
  /// The island's name when the caller already knows it (Settings has it from
  /// its own `useServerInfo`). Only used to pick the letter; the cache and the
  /// live fetch fill it in when the caller does not.
  name?: string
  size?: number
  className?: string
}

/// ⚠ FNV-1a over the host, never a JS string hash and never anything seeded
/// per run. iOS spells out why (`IslandAvatarView.tint`): Swift's own hashing
/// is seeded per process, so an island changed colour on every launch. Ours
/// would not do that, but a DIFFERENT hash is a different colour from the
/// phones for the same island, which is the same bug seen from one device
/// over.
function tint(host: string): string {
  let hash = 2166136261
  for (const byte of new TextEncoder().encode(host.toLowerCase())) {
    hash = Math.imul(hash ^ byte, 16777619) >>> 0
  }
  // Off full saturation so the tile reads as chrome rather than as an alert.
  return `hsl(${hash % 360} 46% 62%)`
}

/// First LETTER, not first character: a name that opens with an emoji or a
/// bracket would otherwise draw a tile with punctuation on it.
function initial(name: string, host: string): string {
  const source = (name || host).trim()
  const ch = [...source].find((c) => /\p{L}|\p{N}/u.test(c))
  return ch ? ch.toUpperCase() : '#'
}

/// One inflight-or-done promise per logo URL (the version rides in the URL, so
/// a rotated logo is a new key). ⚠ Only SUCCESS is cached. The first cut
/// cached a failure for the life of the page, and on the desktop that was
/// the life of the APP: its first render fires before the transport is
/// engaged, the fetch failed once, and the flagship's flower was a letter
/// tile for days (founder, 31.08). A failed fetch now clears its slot so
/// the next mount simply tries again.
const logoObjectURLs = new Map<string, Promise<string | null>>()

function fetchLogoObjectURL(url: string): Promise<string | null> {
  let p = logoObjectURLs.get(url)
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b && b.size > 0 ? URL.createObjectURL(b) : null))
      .catch(() => null)
      .then((u) => {
        if (u == null) logoObjectURLs.delete(url)
        return u
      })
    logoObjectURLs.set(url, p)
  }
  return p
}

export function IslandAvatar({ apiBase, name, size = 28, className = '' }: Props) {
  const host = (apiBase ?? '').replace(/^https?:\/\//, '')
  // Off disk first, so the tile (and a logo already in the browser's cache) are
  // there on the first frame rather than after a round trip, then corrected by
  // the live answer. Run-cached per island by `fetchServerInfo`, so several of
  // these on one screen make one request each at most, and none at all for an
  // island already asked this run.
  const card = useIslandCard(apiBase)
  const version = card.logoVersion
  const label = name || card.name

  const [broken, setBroken] = useState(false)
  const [src, setSrc] = useState<string | null>(null)
  const url = version && apiBase ? islandLogoURL(apiBase, version) : null
  // A new logo is a new version, a new version is a new URL, and a URL that
  // has changed deserves one more try: without this, an island whose logo
  // failed once would keep its tile for the life of the page even after the
  // operator fixed it.
  useEffect(() => {
    setBroken(false)
    setSrc(null)
    if (!url) return
    let alive = true
    void fetchLogoObjectURL(url).then((u) => {
      // The fetch road failed (offline, transport not engaged yet)? Try the
      // picture as a PLAIN cross-origin <img>. On the desktop that road is
      // open (its CSP admits https: images) and was how the logo always
      // loaded; on the web it is CSP-blocked, errors, and the letter tile
      // stands - exactly the pre-#815 behaviour, never worse.
      if (alive) setSrc(u ?? url)
    })
    return () => {
      alive = false
    }
  }, [url])

  const style = { width: size, height: size, borderRadius: Math.round(size * 0.28) }

  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        draggable={false}
        onError={() => setBroken(true)}
        className={`flex-none object-cover ${className}`}
        style={style}
      />
    )
  }

  return (
    <span
      className={`flex-none inline-flex items-center justify-center text-white font-bold leading-none ${className}`}
      style={{ ...style, background: tint(host), fontSize: Math.round(size * 0.46) }}
      aria-hidden
    >
      {initial(label, host)}
    </span>
  )
}
