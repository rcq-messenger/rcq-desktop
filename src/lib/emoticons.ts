// Port of iOS `Emoticons.swift` + `CosmeticPacks.swift`. Same KOLOBOK
// base table, same shortcode→asset mapping, same longest-match
// tokenizer. Cosmetic packs (Forum Classics, future smiley sets)
// layer extra emoticons on top — they get their own primary code
// (`:banana:` etc.) and live alongside the base set in the picker
// when the user has the pack equipped. Receivers can render any
// pack emoji in incoming text regardless of equip status because
// every pack's assets are bundled.
//
// Asset URLs:
//   - Kolobok base set served from `/emoticons/<name>.gif`
//   - Pack assets served from `/items/<pack-folder>/<name>.gif`
//   The catalog's `asset_ref` already encodes the right relative path
//   for items; we mirror the folder layout for packs here.

export interface EmoticonEntry {
  code: string
  asset: string
  name: string
}

export interface PaletteEntry {
  asset: string
  name: string
  primaryCode: string
}

export interface PackPalette {
  kindID: string
  /// Display name for the pack — for now we just show "Forum Classics"
  /// directly in the picker header. Could be localized later.
  name: string
  items: PaletteEntry[]
}

// KOLOBOK "set 14" — the SAME 40-emoticon set the iOS + Android clients ship
// (asset names match `Emoticons.swift` / `Emoticon.kt` exactly), so a smiley
// picked on any client renders identically everywhere. Only the `:asset:` code
// is parsed (iOS/Android deliberately ignore typed shortcuts like `:-)` to
// avoid colliding with URLs/math), so each code list is empty and the `:asset:`
// form is appended by ENTRIES below. GIFs live in `public/emoticons/`.
const RAW: Array<[string, string, string[]]> = [
  ['smile', 'Happy', []], ['biggrin', 'Laughing', []], ['lol', 'LOL', []], ['rofl', 'ROFL', []],
  ['good', 'Thumbs Up', []], ['give_heart', 'Heart', []], ['man_in_love', 'In Love', []], ['give_rose', 'Rose', []],
  ['kiss', 'Kiss', []], ['kiss3', 'Smooch', []], ['air_kiss', 'Air Kiss', []], ['blush', 'Embarrassed', []],
  ['i_am_so_happy', 'So Happy', []], ['dance', 'Dancing', []], ['music', 'Music', []], ['cool', 'Cool', []],
  ['gamer', 'Gamer', []], ['drinks', 'Cheers', []], ['hi', 'Hi', []], ['bye2', 'Bye', []],
  ['blum1', 'Tongue', []], ['mocking', 'Teasing', []], ['crazy', 'Crazy', []], ['wacko1', 'Wacko', []],
  ['nea', 'Pensive', []], ['scratch_one-s_head', 'Thinking', []], ['unknown', 'Dunno', []], ['shok', 'Shocked', []],
  ['sad', 'Sad', []], ['cray', 'Crying', []], ['pardon', 'Pardon', []], ['sorry', 'Sorry', []],
  ['mad', 'Angry', []], ['ireful', 'Furious', []], ['shout', 'Shouting', []], ['bad', 'Sick', []],
  ['diablo', 'Devil', []], ['bomb', 'Bomb', []], ['girl_angel', 'Angel', []], ['hang1', 'Hang', []],
  // 20 "extra" koloboks — the SAME set the iOS/Android clients added (40→60),
  // appended in native order. asset == display name; wire code is `:asset:`.
  // Filename casing is load-bearing (case-sensitive on the deploy server).
  ['Cherna_01', 'Cherna_01', []], ['FinouCat_02', 'FinouCat_02', []], ['Koshechka_06', 'Koshechka_06', []],
  ['Laie_74', 'Laie_74', []], ['Mauridia_02', 'Mauridia_02', []], ['Rulezzz_03', 'Rulezzz_03', []],
  ['WhiteVoid_1', 'WhiteVoid_1', []], ['d_clock', 'd_clock', []], ['kirtsun_05', 'kirtsun_05', []],
  ['l_girl_kiss', 'l_girl_kiss', []], ['l_lovers', 'l_lovers', []], ['l_teddy', 'l_teddy', []],
  ['snoozer_likelinux_man', 'snoozer_likelinux_man', []], ['viannen_03', 'viannen_03', []], ['viannen_06', 'viannen_06', []],
  ['viannen_09', 'viannen_09', []], ['viannen_35', 'viannen_35', []], ['viannen_48', 'viannen_48', []],
  ['viannen_76', 'viannen_76', []], ['viannen_88', 'viannen_88', []],
]

interface PackManifest {
  kindID: string
  name: string
  folder: string // public-relative URL prefix without trailing slash
  entries: { asset: string; name: string; primaryCode: string }[]
}

/// Cosmetic-pack manifest. Mirrors iOS `CosmeticPacks.swift` — when
/// adding a new pack, register it here AND drop the gif files into
/// `web-chat/public/<folder>/`. Asset names must be unique across
/// the whole system (kolobok + every pack) since the tokenizer keys
/// off them.
const PACK_MANIFESTS: PackManifest[] = [
  {
    kindID: 'forum_classics',
    name: 'Forum Classics',
    folder: '/items/cosm1',
    entries: [
      { asset: 'banana',   name: 'Banana dance', primaryCode: ':banana:' },
      { asset: 'coolblue', name: 'Cool blue',    primaryCode: ':coolblue:' },
      { asset: 'hail',     name: 'Hail',         primaryCode: ':hail:' },
      { asset: 'hwluxx',   name: 'Hwluxx',       primaryCode: ':hwluxx:' },
      { asset: 'mad',      name: 'Mad',          primaryCode: ':mad:' },
      { asset: 'wallbash', name: 'Wallbash',     primaryCode: ':wallbash:' },
    ],
  },
]

const KOLOBOK_FOLDER = '/emoticons'

/// asset name → public URL. Built once at module load from the kolobok
/// table + every pack manifest. Packs override kolobok if there's a
/// name clash (none today, but keeps the rule explicit).
const ASSET_URL: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const [asset] of RAW) map[asset] = `${KOLOBOK_FOLDER}/${asset}.gif`
  for (const pack of PACK_MANIFESTS) {
    for (const e of pack.entries) {
      map[e.asset] = `${pack.folder}/${e.asset}.gif`
    }
  }
  return map
})()

/// All entries (kolobok + every pack), sorted longest-code-first so
/// the tokenizer never clips a long shortcode by matching a shorter
/// prefix. Receivers tokenise pack codes whether or not the pack is
/// equipped — the assets are bundled regardless.
export const ENTRIES: EmoticonEntry[] = (() => {
  const flat: EmoticonEntry[] = []
  for (const [asset, name, codes] of RAW) {
    // Always include the `:asset:` form — that's the ONLY shape iOS/
    // Android parse (they deliberately ignore typed shortcuts like
    // `:-)` to avoid colliding with URLs/math). So the picker inserts
    // `:asset:` (see PALETTE) and we must tokenize it here too, even
    // for assets whose RAW list only has text shortcuts. The typed
    // shortcuts stay tokenizable on web for users who type them.
    const assetCode = `:${asset}:`
    const all = codes.includes(assetCode) ? codes : [...codes, assetCode]
    for (const code of all) flat.push({ code, asset, name })
  }
  for (const pack of PACK_MANIFESTS) {
    for (const e of pack.entries) {
      flat.push({ code: e.primaryCode, asset: e.asset, name: e.name })
    }
  }
  return flat.sort((a, b) => b.code.length - a.code.length)
})()

/// Picker palette for the kolobok base set — one entry per asset.
/// primaryCode is the `:asset:` form (NOT codes[0]) so a picked
/// emoticon renders on iOS/Android too — they only parse `:asset:`,
/// not typed shortcuts like `:-)`. (This was the bug where a smiley
/// sent from web showed as literal symbols on the phone.)
export const PALETTE: PaletteEntry[] = (() => {
  const seen = new Set<string>()
  const out: PaletteEntry[] = []
  for (const [asset, name] of RAW) {
    if (!seen.has(asset)) {
      seen.add(asset)
      out.push({ asset, name, primaryCode: `:${asset}:` })
    }
  }
  return out
})()

/// Default six quick reactions — byte-identical to iOS
/// `EmoticonStore.defaultReactions` / Android `DEFAULT_REACTION_EMOJIS`.
/// Used ONLY when the stored reactions key is ABSENT; a stored `[]` is an
/// intentional empty set and is respected (see emoticon-choices.ts).
export const DEFAULT_REACTIONS: readonly string[] = [
  'good', 'give_heart', 'biggrin', 'shok', 'cray', 'mad',
] as const

/// Caps: the composer panel holds up to 40 emoticons, reactions up to 6
/// (matches the native picker).
export const PANEL_CAP = 40
export const REACTION_CAP = 6

/// Map chosen asset names → PaletteEntry[] preserving the user's pick order
/// (unknown assets are skipped). Renders the user's chosen composer panel.
export function panelPaletteFor(assets: string[]): PaletteEntry[] {
  const byAsset = new Map(PALETTE.map((p) => [p.asset, p]))
  return assets
    .map((a) => byAsset.get(a))
    .filter((p): p is PaletteEntry => p != null)
}

/// True when the kindID corresponds to a registered smiley pack.
/// Used by the chat composer to filter the inventory's equipped
/// items down to "things that should appear in the picker".
export function isSmileyPack(kindID: string): boolean {
  return PACK_MANIFESTS.some((p) => p.kindID === kindID)
}

/// Picker palette filtered to the user's currently-equipped packs,
/// returned as discrete sections so the renderer can put a divider
/// + label between each. Order matches `equippedKindIDs`.
export function packPalettesFor(equippedKindIDs: string[]): PackPalette[] {
  const known = new Map(PACK_MANIFESTS.map((p) => [p.kindID, p]))
  const out: PackPalette[] = []
  for (const kindID of equippedKindIDs) {
    const m = known.get(kindID)
    if (!m) continue
    out.push({ kindID, name: m.name, items: m.entries.slice() })
  }
  return out
}

/// Whole pack contents — used by the inventory sheet when a smiley
/// pack is opened so the user can see everything inside before
/// equipping. Returns null when the kindID isn't a registered pack.
export function packContentsFor(kindID: string): PackPalette | null {
  const m = PACK_MANIFESTS.find((p) => p.kindID === kindID)
  if (!m) return null
  return { kindID: m.kindID, name: m.name, items: m.entries.slice() }
}

export type Token = { kind: 'text'; text: string } | { kind: 'emoticon'; asset: string; code: string }

/// Tokenize a string into [text | emoticon] runs. Used by the
/// chat-bubble renderer to splice GIFs into the typeface flow.
export function tokenize(input: string): Token[] {
  const out: Token[] = []
  let buffer = ''
  let i = 0
  while (i < input.length) {
    let matched: EmoticonEntry | null = null
    for (const e of ENTRIES) {
      if (input.startsWith(e.code, i)) {
        matched = e
        break
      }
    }
    if (matched) {
      if (buffer) {
        out.push({ kind: 'text', text: buffer })
        buffer = ''
      }
      out.push({ kind: 'emoticon', asset: matched.asset, code: matched.code })
      i += matched.code.length
    } else {
      buffer += input[i]
      i++
    }
  }
  if (buffer) out.push({ kind: 'text', text: buffer })
  return out
}

export function emoticonAssetURL(asset: string): string {
  return ASSET_URL[asset] ?? `${KOLOBOK_FOLDER}/${asset}.gif`
}
