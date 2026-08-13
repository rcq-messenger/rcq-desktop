/// What this session should be CALLED in the other devices' "Linked devices"
/// list.
///
/// It used to be the string "Desktop", or "Web", and nothing else: one ternary
/// at QR-generation time. Founder: "показывает устройства как Desktop, хотел бы
/// именно какое пк, как в телеге". Telegram's shape is app-or-browser first,
/// then the operating system — "Telegram Desktop, Windows", "Chrome, macOS" —
/// and that is what this builds.
///
/// The name travels in the QR itself (the `c` param), so a phone with the
/// CURRENT build already shows whatever we put here: no server change and no
/// phone build stands between this and the founder's screen. That is also the
/// constraint — the phones truncate the label at 24 characters, so every string
/// below is short by construction.

import { desktopPlatform, isTauri } from './desktop'

const OS_NAMES: [RegExp, string][] = [
  [/Windows NT 10/i, 'Windows'],
  [/Windows/i, 'Windows'],
  [/Android/i, 'Android'],
  // iPadOS reports itself as a Mac; the touch-point count is what separates
  // them, and getting this wrong is how an iPad ends up labelled "macOS".
  [/iPhone|iPod/i, 'iOS'],
  [/Macintosh|Mac OS X/i, 'macOS'],
  [/CrOS/i, 'ChromeOS'],
  [/Linux|X11/i, 'Linux'],
]

/// Browser, in the order that matters: every Chromium browser also claims
/// "Chrome", and Chrome itself also claims "Safari", so the specific names have
/// to be tested before the generic ones or everything is Chrome.
const BROWSER_NAMES: [RegExp, string][] = [
  [/Edg\//i, 'Edge'],
  [/OPR\/|Opera/i, 'Opera'],
  [/YaBrowser/i, 'Yandex'],
  [/Brave/i, 'Brave'],
  [/Vivaldi/i, 'Vivaldi'],
  [/Firefox\//i, 'Firefox'],
  [/Chrome\//i, 'Chrome'],
  [/Safari\//i, 'Safari'],
]

function matchFirst(pairs: [RegExp, string][], ua: string): string | null {
  for (const [re, name] of pairs) if (re.test(ua)) return name
  return null
}

function osName(ua: string): string | null {
  const touch = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0
  if (/Macintosh|Mac OS X/i.test(ua) && touch > 1) return 'iPadOS'
  return matchFirst(OS_NAMES, ua)
}

/// The label this client puts in its own link QR. Never longer than the 24
/// characters the phones keep.
export async function clientLabel(): Promise<string> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  let head: string
  let tail: string | null
  if (isTauri()) {
    head = 'RCQ Desktop'
    const p = await desktopPlatform()
    tail = p === 'macos' ? 'macOS' : p === 'windows' ? 'Windows' : p === 'linux' ? 'Linux' : null
  } else {
    head = matchFirst(BROWSER_NAMES, ua) ?? 'Web'
    tail = osName(ua)
  }
  const full = tail ? `${head} · ${tail}` : head
  return full.length <= 24 ? full : head.slice(0, 24)
}
