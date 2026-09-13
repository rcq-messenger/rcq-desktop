// What SHAPE an emoticon is, remembered from the last time this browser drew it.
//
// Every emoticon image in this client is sized by its HEIGHT with the width
// left to the picture, because the kolobok set is not square (23x26, 36x27,
// 37x23 ...) and a fixed box squeezes the wide ones. That rule is right the
// moment the file is here and wrong for every moment before it: an <img> whose
// bytes have not arrived has no ratio of its own, so the browser lays it out
// ZERO wide and everything beside it slides when the GIF lands.
//
// Measured on a strip of four reaction chips with the GIFs held in flight: the
// first chip sat at x=361.84 and the strip was 75.66px wide; once the files
// were there the chip was at x=234.72 and the strip 202.78px. That is the
// reaction icons "moving" in the founder's report (12.09), and the same trap
// sits under every smiley inside a text bubble.
//
// `aspect-ratio: auto W / H` is the one property that reserves the room without
// lying about it: the browser uses W/H only while the image has no ratio of its
// own, and switches to the real one the instant it does. So a remembered shape
// that has gone stale (an asset redrawn at a new size) corrects itself on load
// instead of distorting anything, which is why this table is allowed to be a
// cache rather than a manifest that has to be kept in step with the files.
//
// ⚠ NOT the `width`/`height` attributes and NOT a Tailwind width class.
// Preflight sets `img { height: auto }`, the attributes are only presentational
// hints, and a real width class would hold the wrong width AFTER the load too.
// This is the one form the browser treats as a hint and then abandons.

const KEY = 'rcq.web.emoticon.aspect'
/// A never-seen asset is drawn at the shape of the set. Measured over all 258
/// GIFs in public/emoticons: 211 are wider than tall and the median ratio is
/// 1.35, so a square guesses low on four assets out of five. On a cold
/// right-aligned strip of four chips a square still slid the first chip 32.6px
/// and could re-wrap the strip, which changes the bubble's HEIGHT and carries
/// everything below it. 4/3 is the nearest plain fraction to the median and
/// roughly halves that on the first sight of an asset; the real ratio still
/// wins the moment the bytes arrive.
const UNKNOWN = 'auto 4 / 3'

let table: Record<string, string> | null = null

function load(): Record<string, string> {
  if (table) return table
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : null
    table = parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    // A browser with storage switched off still gets the in-memory half of
    // this: an emoticon settles once per page rather than once per chat.
    table = {}
  }
  return table
}

/// The `aspect-ratio` an emoticon image should carry. Pass it through to the
/// style, never to a width.
export function emoticonAspect(asset: string): string {
  return load()[asset] ?? UNKNOWN
}

/// Record what an emoticon image turned out to be, from its own load event.
/// Cheap to call from anywhere that draws one, including the picker, whose
/// boxes are fixed and cannot move: every asset seen there is an asset that
/// will not shift the first time somebody reacts with it.
export function rememberEmoticonSize(asset: string, img: HTMLImageElement | null): void {
  if (!img || !img.naturalWidth || !img.naturalHeight) return
  const shape = `auto ${img.naturalWidth} / ${img.naturalHeight}`
  const t = load()
  if (t[asset] === shape) return
  t[asset] = shape
  try {
    localStorage.setItem(KEY, JSON.stringify(t))
  } catch {
    /* quota or private mode: the in-memory table still holds for this page */
  }
}
