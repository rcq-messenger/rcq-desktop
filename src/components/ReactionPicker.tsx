// Reaction picker — KOLOBOK "set 14" GIFs served from /emoticons/. Same 12 the
// iOS/Android clients offer (MessageActionSheet.reactionAssets / Emoticon.kt
// `reactions`), in the same order, so a reaction renders identically on every
// client. Tap one to fire the parent's `onPick(asset)`; tap the current one
// again to clear it. Two rows of six under a chat bubble.

const ASSETS = [
  'good', 'give_heart', 'biggrin', 'rofl', 'shok', 'cray',
  'mad', 'diablo', 'cool', 'kiss', 'give_rose', 'man_in_love',
] as const

export type ReactionAsset = (typeof ASSETS)[number]

export function ReactionPicker({
  current,
  onPick,
}: {
  /// The asset currently set on the target message, if any. Tapping
  /// the same asset toggles it off (sends `null` upstream).
  current: string | null
  onPick: (asset: string | null) => void
}) {
  return (
    <div className="grid grid-cols-6 gap-1 rounded-lg border border-line bg-surface px-2 py-1.5 shadow-sm">
      {ASSETS.map((a) => {
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
              src={`/emoticons/${a}.gif`}
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
