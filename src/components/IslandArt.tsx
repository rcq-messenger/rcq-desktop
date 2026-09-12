// The island's painting with its logo at the foot: the top of every card in
// the picker's deck (IslandArtView on iOS, the Box at the top of IslandCard on
// Android).
//
// No card under it. The island is a cut-out and the modal already has a
// ground of its own; a panel behind the painting turns a floating island into
// a sticker on a tile (founder, 24.08, on the Android deck). The painting
// drifts 4px up and down over 2.6s, the phones' float, as a CSS animation
// (`.rcq-island-float`, index.css) rather than a JS one: it starts on the
// first frame, where iOS had to defer its animation one runloop tick or it
// never started. Off under prefers-reduced-motion, like the QR waves.
//
// The logo sits ON the painting the way a flag sits on a hill: the painting
// says "an island", the logo says WHICH. It is the island's own face through
// IslandAvatar, off the same /server/info the door line reads, and it is
// mounted only for a card the person is on or next to (`near`): the deck must
// not hand this device's address to every island in the catalogue the moment
// the picker opens (Android's islandDoor rule). A far card shows its painting
// alone, which is all of it that peeks out anyway.

import { IslandAvatar } from './IslandAvatar'
import { islandArtDims, islandArtPath } from '../lib/island-catalog'

export function IslandArt({
  base,
  name,
  near,
  height = 152,
}: {
  base: string
  name?: string
  near: boolean
  height?: number
}) {
  const [w, h] = islandArtDims(base)
  return (
    // The float needs headroom: the box is 10px taller than the painting so
    // the drift never leaves the card's clipped viewport.
    <div className="relative w-full flex justify-center" style={{ height }}>
      <div className="rcq-island-float relative h-full flex items-end justify-center">
        <img
          src={islandArtPath(base)}
          width={w}
          height={h}
          alt=""
          draggable={false}
          className="block w-auto select-none"
          style={{ height: height - 10 }}
        />
        {near && (
          <IslandAvatar
            apiBase={base}
            name={name}
            size={34}
            className="absolute bottom-0 left-1/2 -translate-x-1/2 shadow-md"
          />
        )}
      </div>
    </div>
  )
}
