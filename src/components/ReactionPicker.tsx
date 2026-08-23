// Reaction picker: the user's OWN chosen quick reactions (curated in the
// emoticon config sheet; defaults to the historical six until customised).
// KOLOBOK GIFs served from /emoticons/. A reaction sends an asset name, so any
// chosen kolobok (incl. the new extras) renders identically on iOS/Android.
// Tap one to fire the parent's `onPick(asset)`; tap the current one again to
// clear it.
//
// ⚠ ONE scrolling row, not a grid. The set used to be capped at six, which
// fit a fixed 6-column block; REACTION_CAP is 40 now (founder, item 10), and a
// 6x7 block would have grown down over the message it belongs to. A row that
// scrolls sideways keeps the bar the same shape whether the user kept two
// reactions or forty. Width is clamped to the window, never to the bubble: the
// bar hangs off a narrow `relative` wrapper, so an unclamped `w-max` is what
// keeps a short message from squeezing it. `no-scrollbar` (index.css) rather
// than a visible track: a classic scrollbar on Windows/Linux would eat into a
// 36px-tall row and then trigger a vertical one too. A vertical wheel over a
// horizontal-only scroller scrolls it in every engine we ship on.

import { useReactionAssets } from '../lib/emoticon-choices'
import { emoticonAssetURL } from '../lib/emoticons'

export function ReactionPicker({
  uin,
  current,
  onPick,
}: {
  /// The viewer's UIN — selects their chosen reaction set.
  uin: number
  /// The asset currently set on the target message, if any. Tapping the
  /// same asset toggles it off (sends `null` upstream).
  current: string | null
  onPick: (asset: string | null) => void
}) {
  const assets = useReactionAssets(uin)
  return (
    <div
      data-chat-menu
      style={{ maxWidth: 'min(20rem, calc(100vw - 2rem))' }}
      className="no-scrollbar flex w-max gap-1 overflow-x-auto overscroll-x-contain rounded-lg bg-surface px-2 py-1.5 shadow-lg"
    >
      {assets.map((a) => {
        const selected = current === a
        return (
          <button
            key={a}
            onClick={() => onPick(selected ? null : a)}
            className={`h-9 w-9 shrink-0 rounded-md flex items-center justify-center transition-colors ${
              selected ? 'bg-accent/20' : 'hover:bg-surface-dim'
            }`}
            title={a}
            aria-label={a}
          >
            {/* ⚠ object-contain. The koloboks are not all square, and a bare
                h-6 w-6 stretched the wide ones into the box: founder, on the
                reaction row, "эмотиконы сжаты почему то (некоторые)". */}
            <img
              src={emoticonAssetURL(a)}
              alt={a}
              className="h-6 w-6 object-contain select-none"
              draggable={false}
            />
          </button>
        )
      })}
    </div>
  )
}
