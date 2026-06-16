// Reaction picker — the user's OWN chosen quick reactions (curated in the
// emoticon config sheet; defaults to the historical six until customised).
// KOLOBOK GIFs served from /emoticons/. A reaction sends an asset name, so any
// chosen kolobok (incl. the new extras) renders identically on iOS/Android.
// Tap one to fire the parent's `onPick(asset)`; tap the current one again to
// clear it.

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
    <div className="grid grid-cols-6 gap-1 rounded-lg border border-line bg-surface px-2 py-1.5 shadow-sm">
      {assets.map((a) => {
        const selected = current === a
        return (
          <button
            key={a}
            onClick={() => onPick(selected ? null : a)}
            className={`h-9 w-9 rounded-md flex items-center justify-center transition-colors ${
              selected ? 'bg-accent/20' : 'hover:bg-surface-dim'
            }`}
            title={a}
            aria-label={a}
          >
            <img
              src={emoticonAssetURL(a)}
              alt={a}
              className="h-6 w-6 select-none"
              draggable={false}
            />
          </button>
        )
      })}
    </div>
  )
}
