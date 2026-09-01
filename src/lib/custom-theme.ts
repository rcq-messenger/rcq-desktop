/// A background gradient the person picks, with the text colour taken out of
/// their hands.
///
/// ⚠⚠ THE RULE. Nobody chooses the foreground. It is computed from the
/// background's luminance, and if the pair they picked cannot carry readable
/// text, the PAIR moves until it can. That is the whole reason this file
/// exists: "let people pick colours" and "text stays readable" are only
/// compatible if the second one is not also a choice. A picker that offers a
/// text colour eventually produces white on cream, and the person who did it
/// will report it as our bug, correctly.
///
/// ⚠ We move the background rather than refusing the input. Refusing means a
/// slider that stops for reasons the person cannot see; moving means they see
/// the colour settle a little darker and understand immediately.

export interface CustomTheme {
  /// Gradient stops, `#rrggbb`.
  from: string
  to: string
  /// Which theme this belongs to. Light and dark are separate pictures: the
  /// same pair that reads well over a light page is unreadable over a dark one.
  mode: 'light' | 'dark'
}

const KEY = 'rcq.web.customTheme'

/// Contrast the body text must clear. WCAG AA for normal text.
const MIN_CONTRAST = 4.5
/// How far we are willing to walk a colour to reach it. Beyond this the input
/// was not a background colour in any useful sense.
const MAX_STEPS = 40

function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim()
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = Number.parseInt(full, 16)
  if (!Number.isFinite(n) || full.length !== 6) return [0, 0, 0]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')
}

/// WCAG relative luminance.
export function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

export function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

const NEAR_BLACK: [number, number, number] = [10, 10, 10]
const NEAR_WHITE: [number, number, number] = [240, 240, 240]

/// Move one colour one step toward black (or white).
function step(c: [number, number, number], towardWhite: boolean): [number, number, number] {
  const target = towardWhite ? 255 : 0
  return c.map((v) => clamp(v + (target - v) * 0.06)) as [number, number, number]
}

export interface ResolvedTheme {
  from: string
  to: string
  /// The computed body colour. Never an input.
  fg: string
  /// True when the pair had to be moved to make text readable.
  adjusted: boolean
  /// Contrast actually achieved against the WORSE of the two stops.
  contrast: number
}

/// Take a pair and return a pair that can carry text, plus the text colour.
///
/// The text colour is decided against the WORSE stop, not the average: a
/// gradient from near-white to near-black has a fine average and no colour of
/// text that survives both ends, and that is exactly the case a naive
/// implementation ships.
export function resolve(from: string, to: string): ResolvedTheme {
  let a = hexToRgb(from)
  let b = hexToRgb(to)
  // Which text colour has more room over this pair, judged at its worse end.
  const worstAgainst = (fg: [number, number, number]) =>
    Math.min(contrast(a, fg), contrast(b, fg))
  const useWhiteText = worstAgainst(NEAR_WHITE) >= worstAgainst(NEAR_BLACK)
  const fg = useWhiteText ? NEAR_WHITE : NEAR_BLACK
  let adjusted = false
  let steps = 0
  // White text wants a darker background, black text a lighter one. Walk both
  // stops, not just the offending one: moving one end alone turns the person's
  // gradient into a different gradient.
  while (worstAgainst(fg) < MIN_CONTRAST && steps < MAX_STEPS) {
    a = step(a, !useWhiteText)
    b = step(b, !useWhiteText)
    adjusted = true
    steps += 1
  }
  return {
    from: rgbToHex(a),
    to: rgbToHex(b),
    fg: rgbToHex(fg),
    adjusted,
    contrast: worstAgainst(fg),
  }
}

/// Mix a colour toward the foreground by `amount`, for the surfaces that sit ON
/// the gradient (panels, bubbles, fields). They must stay distinguishable from
/// the background without becoming a second, unrelated palette.
function lift(bg: [number, number, number], fg: [number, number, number], amount: number): [number, number, number] {
  return bg.map((v, i) => clamp(v + (fg[i] - v) * amount)) as [number, number, number]
}

function rgbVar(c: [number, number, number]): string {
  return `${c[0]} ${c[1]} ${c[2]}`
}

/// Paint the resolved theme onto the document, or clear it when null.
///
/// ⚠ Written as CSS variables on the root element, the same names the built-in
/// themes set, so every component keeps reading one source. The gradient itself
/// is a background image on `body`: a variable cannot hold a gradient AND be
/// used as a solid colour elsewhere.
export function apply(theme: CustomTheme | null): void {
  const root = document.documentElement
  const names = [
    '--c-surface', '--c-surface-dim', '--c-line', '--c-fg-primary',
    '--c-fg-secondary', '--c-fg-dim', '--c-bubble-other', '--c-field',
  ]
  if (!theme) {
    for (const n of names) root.style.removeProperty(n)
    root.style.removeProperty('--rcq-gradient')
    root.classList.remove('rcq-custom-theme')
    return
  }
  const r = resolve(theme.from, theme.to)
  const a = hexToRgb(r.from)
  const b = hexToRgb(r.to)
  const fg = hexToRgb(r.fg)
  // The darker end is the reference for surfaces, so a panel never lands
  // lighter than the page under it at one end and darker at the other.
  const base = luminance(a) <= luminance(b) ? a : b
  root.style.setProperty('--rcq-gradient', `linear-gradient(160deg, ${r.from}, ${r.to})`)
  root.style.setProperty('--c-surface-dim', rgbVar(base))
  root.style.setProperty('--c-surface', rgbVar(lift(base, fg, 0.08)))
  root.style.setProperty('--c-field', rgbVar(lift(base, fg, 0.12)))
  root.style.setProperty('--c-bubble-other', rgbVar(lift(base, fg, 0.12)))
  root.style.setProperty('--c-line', rgbVar(lift(base, fg, 0.18)))
  root.style.setProperty('--c-fg-primary', rgbVar(fg))
  // Secondary and dim are the SAME hue as primary, stepped toward the
  // background. Picking them independently is how a theme ends up with a
  // readable body and an invisible timestamp.
  root.style.setProperty('--c-fg-secondary', rgbVar(lift(fg, base, 0.35)))
  root.style.setProperty('--c-fg-dim', rgbVar(lift(fg, base, 0.55)))
  root.classList.add('rcq-custom-theme')
}

/// Both pictures at once. Light and dark are stored SEPARATELY on purpose: a
/// pair that reads well over a light page is unreadable over a dark one, and
/// somebody who set a custom light background and then switched to dark should
/// get the built-in dark theme, not their light gradient forced into it.
type Stored = { light?: { from: string; to: string }; dark?: { from: string; to: string } }

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const v = JSON.parse(raw)
    // Migrate the single-theme shape this key held before there were two.
    if (v && typeof v.from === 'string' && typeof v.to === 'string') {
      const mode: 'light' | 'dark' = v.mode === 'dark' ? 'dark' : 'light'
      return { [mode]: { from: v.from, to: v.to } } as Stored
    }
    return (v && typeof v === 'object' ? v : {}) as Stored
  } catch {
    return {}
  }
}

export function load(mode: 'light' | 'dark'): CustomTheme | null {
  const one = readAll()[mode]
  if (!one || typeof one.from !== 'string' || typeof one.to !== 'string') return null
  return { from: one.from, to: one.to, mode }
}

export function save(theme: CustomTheme | null, mode?: 'light' | 'dark'): void {
  const which = theme?.mode ?? mode
  try {
    const all = readAll()
    if (theme) all[theme.mode] = { from: theme.from, to: theme.to }
    else if (which) delete all[which]
    if (all.light || all.dark) localStorage.setItem(KEY, JSON.stringify(all))
    else localStorage.removeItem(KEY)
  } catch {
    /* a browser with storage off keeps the built-in theme, which is fine */
  }
  apply(theme)
}
