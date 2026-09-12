// The deck: one island per page with the neighbours' edges showing, dots
// under it, Use under the dots. The same deck the phones draw (IslandCarousel
// on Android, the paged TabView in ServerPickerSheet on iOS), for a screen
// that has no swipe (founder, 12.09: the desktop picker should look like the
// phones').
//
// No library. The track is a flex row moved with a transform; each page is
// 84% of the modal and the rest is the peek Android's 28dp contentPadding
// gives. Everything a finger does on a phone has a twin here, because the
// desktop has no swipe: ← → Home End on the keyboard (the MODAL owns the key
// handler, since it already backs out of the rules page with Escape and it
// holds the index), the trackpad's horizontal wheel (or shift + wheel on a
// mouse), a pointer drag past 40px, two arrow buttons at the sides that show
// under the pointer, and the dots themselves. `touch-action: pan-y` keeps the
// page scrollable on a touch screen while a horizontal drag still lands, so
// the web on a phone pages by swipe for free.
//
// Controlled: the modal holds the index, because the key handler and the pick
// both live there and both need it.

import { useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { useI18n } from '../lib/i18n-context'
import { IslandCard, type DeckIsland } from './IslandCard'

/// A page is this much of the track; the rest is the peek, half each side.
/// ⚠ Two widths, because the peek is only worth having if the NEIGHBOUR'S
/// PAINTING shows in it. On a phone the page is nearly the whole screen and
/// the painting is wide relative to it, so Android's 28dp of padding is
/// enough; in a 576px modal the painting is a third of the card and an 8%
/// peek shows the neighbour's blank margin and a stray letter of its host
/// line, which reads as dirt at the cut. From `sm` up the page is narrower
/// and the painting taller, so what peeks is an island.
const PAGE_WIDE = 56
const PAGE_NARROW = 84
const ART_WIDE = 200
const ART_NARROW = 152
const GAP_PX = 12
/// A drag shorter than this is a click on something in the card, not a page.
const DRAG_PX = 40
/// A wheel gesture pages once it has travelled this far...
const WHEEL_PX = 40
/// ...and a trackpad's inertia tail is not a second gesture: nothing pages
/// again until the wheel has been quiet for this long.
const WHEEL_QUIET_MS = 300

export function IslandCarousel({
  islands,
  index,
  onIndex,
  current,
  homes,
  onUse,
  onForget,
  onRules,
}: {
  islands: DeckIsland[]
  index: number
  onIndex: (i: number) => void
  current: string
  /// Islands an account in the roster lives on: their card has no Forget.
  homes: Set<string>
  onUse: (base: string) => void
  onForget: (base: string) => void
  onRules: (name: string, text: string) => void
}) {
  const { t } = useI18n()
  // Read once: the modal is short-lived and a window resized under it is
  // not worth a listener.
  const [wide] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches)
  const PAGE = wide ? PAGE_WIDE : PAGE_NARROW
  const count = islands.length
  const go = (i: number) => onIndex(Math.max(0, Math.min(count - 1, i)))

  // ── wheel ──
  const wheel = useRef({ acc: 0, at: 0, spent: false })
  function onWheel(e: ReactWheelEvent) {
    const now = Date.now()
    const w = wheel.current
    if (now - w.at > WHEEL_QUIET_MS) {
      w.acc = 0
      w.spent = false
    }
    w.at = now
    if (w.spent) return
    // A trackpad's horizontal swipe is deltaX; a mouse wheel is deltaY, which
    // means the page unless shift is held.
    w.acc += e.deltaX + (e.shiftKey ? e.deltaY : 0)
    if (Math.abs(w.acc) < WHEEL_PX) return
    go(index + (w.acc > 0 ? 1 : -1))
    w.acc = 0
    w.spent = true
  }

  // ── drag ──
  const drag = useRef<{ x: number; id: number; captured: boolean } | null>(null)
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const suppressClick = useRef(false)
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    drag.current = { x: e.clientX, id: e.pointerId, captured: false }
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    const moved = e.clientX - d.x
    // ⚠ Capture only once this is a drag. Capturing on pointerdown would
    // make every pointerup land on the track, and a click is fired at the
    // common ancestor of down and up: the buy link, the rules and Forget
    // buttons inside the card would stop working.
    if (!d.captured && Math.abs(moved) > 4) {
      d.captured = true
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(true)
    }
    if (d.captured) setDx(moved)
  }
  function onPointerEnd(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    drag.current = null
    if (!d.captured) return
    const moved = e.clientX - d.x
    setDx(0)
    setDragging(false)
    // The click that follows a drag is the drag letting go, not a choice.
    suppressClick.current = true
    if (Math.abs(moved) > DRAG_PX) go(index + (moved < 0 ? 1 : -1))
  }

  return (
    <div
      className="relative group"
      onWheel={onWheel}
      onClickCapture={(e) => {
        if (!suppressClick.current) return
        suppressClick.current = false
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div
        className="overflow-hidden"
        style={{ touchAction: 'pan-y' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <div
          className="flex"
          style={{
            gap: GAP_PX,
            transform: `translateX(calc(${(100 - PAGE) / 2}% - ${index} * (${PAGE}% + ${GAP_PX}px) + ${dx}px))`,
            transition: dragging ? 'none' : 'transform 220ms ease-out',
          }}
        >
          {islands.map((isl, i) => (
            // The neighbours fade: their edges say "there is more this way"
            // without their words reading as stray characters at the cut.
            <div
              key={isl.base}
              className={`flex-none transition-opacity duration-200 ${i === index ? 'opacity-100' : 'opacity-40'}`}
              style={{ width: `${PAGE}%` }}
              aria-hidden={i !== index}
            >
              <IslandCard
                island={isl}
                active={isl.base === current}
                near={Math.abs(i - index) <= 1}
                artHeight={wide ? ART_WIDE : ART_NARROW}
                canForget={!homes.has(isl.base)}
                onForget={onForget}
                onRules={onRules}
              />
            </div>
          ))}
        </div>
      </div>

      {/* The arrows show under the pointer and under keyboard focus, and
          only where there is somewhere to go. */}
      {index > 0 && (
        <button
          type="button"
          onClick={() => go(index - 1)}
          aria-label={t('island.picker.prev')}
          className="absolute left-0 top-20 h-8 w-8 rounded-full bg-surface/85 text-fg-secondary hover:text-fg-primary opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-lg leading-none"
        >
          ‹
        </button>
      )}
      {index < count - 1 && (
        <button
          type="button"
          onClick={() => go(index + 1)}
          aria-label={t('island.picker.next')}
          className="absolute right-0 top-20 h-8 w-8 rounded-full bg-surface/85 text-fg-secondary hover:text-fg-primary opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-lg leading-none"
        >
          ›
        </button>
      )}

      {/* Where you are in the deck. Dots rather than "3 / 5": the count is
          not the point, the fact that there is more to the left and right is.
          7px accent for the page you are on, 5px at 35% for the rest, as on
          Android. */}
      {count > 1 && (
        <div role="tablist" className="mt-2 flex items-center justify-center">
          {islands.map((isl, i) => (
            <button
              key={isl.base}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={t('island.picker.dot', { n: i + 1, total: count })}
              onClick={() => go(i)}
              className="p-1 flex items-center justify-center"
            >
              <span
                className={`block rounded-full transition-all ${
                  i === index ? 'w-[7px] h-[7px] bg-accent' : 'w-[5px] h-[5px] bg-fg-secondary/35'
                }`}
              />
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => islands[index] && onUse(islands[index].base)}
        className="mt-3 w-full h-10 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold transition-colors"
      >
        {t('island.use')}
      </button>
    </div>
  )
}
