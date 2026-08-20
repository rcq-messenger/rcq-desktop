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

/// The "standart" Kolobok set (258 glyphs), bundled on every client.
///
/// A plain name list rather than 258 rows: the display name is mechanical, and
/// the three clients MUST carry the same set — a `:code:` missing here renders
/// as raw text in the browser and nowhere else.
///
/// Additive on purpose. The curated set above stays bundled even where this one
/// has no replacement, because those codes are already in people's history.
const STANDARD_PACK: string[] = [
  'acute', 'aggressive', 'agree', 'aikido', 'air_kiss', 'alcoholic', 'angel',
  'assassin', 'bad', 'banned', 'beach', 'beee', 'beta', 'big_boss', 'black_eye',
  'blind', 'blum2', 'blum3', 'blush2', 'boast', 'boredom', 'brunette', 'buba',
  'buba_phone', 'butcher', 'censored', 'clapping', 'comando', 'cray', 'cray2', 'crazy',
  'crazy_pilot', 'curtsey', 'dance', 'dance2', 'dance3', 'dance4', 'dash1', 'dash2',
  'dash3', 'declare', 'ded_moroz', 'ded_snegurochka', 'ded_snegurochka2', 'dinamo',
  'dirol', 'dntknw', 'don-t_mention', 'download', 'drinks', 'dwarf', 'elf', 'facepalm',
  'fan_1', 'fans', 'feminist', 'feminist_en', 'first_move', 'flirt', 'focus', 'fool',
  'friends', 'gamer1', 'gamer2', 'gamer3', 'gamer4', 'girl_blum', 'girl_blum2',
  'girl_cray', 'girl_cray2', 'girl_cray3', 'girl_crazy', 'girl_dance', 'girl_drink1',
  'girl_drink2', 'girl_drink3', 'girl_drink4', 'girl_haha', 'girl_hide',
  'girl_hospital', 'girl_impossible', 'girl_in_love', 'girl_mad', 'girl_prepare_fish',
  'girl_sad', 'girl_sigh', 'girl_smile', 'girl_to_take_umbrage',
  'girl_to_take_umbrage2', 'girl_wacko', 'girl_werewolf', 'girl_wink', 'girl_witch',
  'give_heart', 'give_rose', 'good', 'good2', 'good3', 'heat', 'help', 'hi', 'hunter',
  'hysteric', 'i-m_so_happy', 'ireful1', 'ireful2', 'ireful3', 'jester', 'king',
  'king2', 'kiss', 'kiss2', 'kiss3', 'laugh1', 'laugh2', 'laugh3', 'lazy', 'lazy2',
  'lazy3', 'locomotive', 'mail1', 'mamba', 'man_in_love', 'mda', 'meeting', 'moil',
  'morpheus', 'mosking', 'music', 'music2', 'nea', 'negative', 'neo', 'new_russian',
  'nhl', 'nhl2', 'nhl3', 'nhl_checking', 'nhl_crach', 'nhl_fight', 'no2', 'offtopic',
  'ok', 'on_the_quiet', 'on_the_quiet2', 'orc', 'padonak', 'paint', 'paint2', 'paint3',
  'paladin', 'pardon', 'parting', 'parting2', 'party', 'patsak', 'phi', 'pilot',
  'pioneer', 'pioneer_smoke', 'pleasantry', 'pogranichnik', 'polling', 'popcorm1',
  'popcorm2', 'prankster', 'prankster2', 'preved', 'protest', 'punish', 'punish2',
  'queen', 'rabbi', 'rap', 'read', 'resent', 'rofl', 'russian', 'sad', 'santa',
  'santa2', 'santa3', 'sarcasm', 'sarcastic', 'sarcastic_blum', 'sarcastic_hand',
  'scare', 'scare2', 'scenic', 'sclerosis', 'scout', 'scout_en', 'scratch_one-s_head',
  'search', 'secret', 'shablon_01', 'shablon_02', 'shablon_03', 'shablon_04', 'shout',
  'slow', 'slow_en', 'smile3', 'smoke', 'snegurochka', 'snooks', 'sorry', 'sorry2',
  'spartak', 'spruce_up', 'stinker', 'stop', 'sun_bespectacled', 'superman',
  'superman2', 'superstition', 'swoon', 'swoon2', 'take_example', 'taunt', 'tease',
  'telephone', 'tender', 'thank_you', 'thank_you2', 'this', 'to_babruysk',
  'to_become_senile', 'to_clue', 'to_keep_order', 'to_pick_ones_nose',
  'to_pick_ones_nose2', 'to_pick_ones_nose3', 'to_pick_ones_nose_eat',
  'to_take_umbrage', 'tommy', 'training1', 'triniti', 'umnik', 'umnik2', 'vampire',
  'victory', 'vinsent', 'wacko', 'wacko2', 'warning', 'warning2', 'whistle', 'whistle2',
  'whistle3', 'wild', 'wink3', 'wizard', 'yahoo', 'yes2', 'yes3', 'yes4', 'yu'
]

/// 'to_pick_ones_nose' -> 'To pick ones nose'.
const packName = (asset: string): string => {
  const words = asset.replace(/[_-]/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const KOLOBOK_FOLDER = '/emoticons'

/// asset name → public URL. Built once at module load from the kolobok
/// table + every pack manifest. Packs override kolobok if there's a
/// name clash (none today, but keeps the rule explicit).
const ASSET_URL: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const asset of STANDARD_PACK) map[asset] = `${KOLOBOK_FOLDER}/${asset}.gif`
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
  // The `:asset:` form is the ONLY shape iOS/Android parse — they deliberately
  // ignore typed shortcuts like `:-)` so a smiley never eats a URL or a bit of
  // maths — so it is what the picker inserts and what we tokenize.
  for (const asset of STANDARD_PACK) {
    flat.push({ code: `:${asset}:`, asset, name: packName(asset) })
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
  for (const asset of STANDARD_PACK) {
    if (!seen.has(asset)) {
      seen.add(asset)
      out.push({ asset, name: packName(asset), primaryCode: `:${asset}:` })
    }
  }
  return out
})()

/// Default six quick reactions — byte-identical to iOS
/// `EmoticonStore.defaultReactions` / Android `DEFAULT_REACTION_EMOJIS`.
/// Used ONLY when the stored reactions key is ABSENT; a stored `[]` is an
/// intentional empty set and is respected (see emoticon-choices.ts).
export const DEFAULT_REACTIONS: readonly string[] = [
  'good', 'give_heart', 'laugh1', 'scare', 'cray', 'ireful1',
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
