import { motion } from 'framer-motion'
import { createPortal } from 'react-dom'
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * The one container for the small anchored menus (contact/group/section
 * actions, the status picker). Three founder items in one place (megalist
 * B4/Л2.23, Л2.32):
 *
 *  - it ANIMATES: 130ms fade + small lift on the way in, mirrored on the way
 *    out when the caller mounts it under an `AnimatePresence`;
 *  - it CLAMPS to the window: a menu opened on the last row of a long list
 *    used to render below the viewport edge, where the only way to see it
 *    was to know it was there and scroll after it. If the panel would cross
 *    the bottom, it flips above its trigger instead;
 *  - it carries `rcq-menu` (translucent surface + backdrop blur) so every
 *    menu looks the same. The blur itself was made more apparent in
 *    index.css (surface alpha down), not here.
 *
 * ⚠⚠ The panel is PORTALLED to the body, and that is what makes the blur
 * work. An element with `backdrop-filter` is a backdrop root: a descendant's
 * own `backdrop-filter` then has only that ancestor's painting to work with,
 * not the page. The status picker lives inside `.rcq-header`, which is
 * blurred, so its menu blurred nothing and rendered as a plain 34%-transparent
 * card with the chat legible straight through it - reported as "меню статусов
 * стало прозрачное, при наведении подсвечивается то, что за ним" (founder,
 * #863, desktop 0.3.53). Out at the body the backdrop is the page again.
 *
 * Positioning contract, unchanged for callers: the trigger's wrapper is
 * `relative`, and `className` carries the width plus the edge to align to
 * (`left-0`, `right-0`, `right-3`). Those classes are read here and turned
 * into the fixed coordinates the portal needs.
 */

/** `right-3` → 12. Tailwind's spacing scale is 4px per step. */
function insetOf(className: string, side: 'left' | 'right'): number | null {
  const m = new RegExp(`(?:^|\\s)${side}-(\\d+)(?:\\s|$)`).exec(className)
  return m ? Number(m[1]) * 4 : null
}

export function MenuPanel({
  className = '',
  children,
  onClick,
  panelRef,
  flipGap = 4,
}: {
  className?: string
  children: ReactNode
  onClick?: (e: React.MouseEvent) => void
  /** For the caller's click-outside check — the measuring ref stays internal. */
  panelRef?: React.MutableRefObject<HTMLDivElement | null>
  /**
   * Distance to leave above the trigger when the panel flips upward.
   *
   * ⚠ Clearing the TRIGGER is not always clearing what the trigger sits in.
   * The attach button lives inside the composer capsule, which has padding of
   * its own, so the default 4px put the panel's bottom edge 9px INSIDE the
   * capsule — measured on the dev build, and the reason it still read as
   * "прямо прикасается с композером" after the first attempt at lifting it.
   * A caller whose trigger is inset like that passes the inset plus the gap it
   * actually wants to see.
   */
  flipGap?: number
}) {
  const anchor = useRef<HTMLSpanElement | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  // null = not yet measured: render invisibly at the first guess for one
  // frame, decide, then animate in at the final spot — flipping AFTER the
  // entrance began would read as a jump, which is the very complaint.
  const [box, setBox] = useState<{ top: number; left?: number; right?: number; flip: boolean } | null>(null)

  const place = useCallback(() => {
    const a = anchor.current
    const el = ref.current
    if (!a) return
    const t = a.getBoundingClientRect()
    const h = el?.getBoundingClientRect().height ?? 0
    const flip = t.bottom + h + 8 > window.innerHeight && t.top > h + flipGap + 12
    const right = insetOf(className, 'right')
    const left = insetOf(className, 'left')
    setBox({
      top: flip ? t.top - h - flipGap : t.bottom + 4,
      ...(right !== null
        ? { right: Math.max(8, window.innerWidth - t.right + right) }
        : { left: Math.max(8, t.left + (left ?? 0)) }),
      flip,
    })
  }, [className, flipGap])

  useLayoutEffect(() => {
    place()
    // A menu is transient, but the list under it can still move (a wheel, a
    // new message). Following the trigger is cheaper than deciding what to do
    // about a menu that has drifted away from it.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    // ⚠⚠ And the PANEL can change height under its own feet. The attach menu
    // swaps its five rows for the eight-row timer list in place, and the flip
    // decision was made once, at mount, against the short version: the tall one
    // then opened downward from a trigger at the bottom of the window and ran
    // straight off the edge, which is "исчезающие сообщения не вмещают
    // выбранную опцию" (founder, 03.09). Re-measuring on resize is the whole
    // fix, and it cannot loop: repositioning does not change the height.
    const ro = new ResizeObserver(place)
    if (ref.current) ro.observe(ref.current)
    return () => {
      ro.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [place])

  const panel = (
    <motion.div
      ref={(el: HTMLDivElement | null) => {
        ref.current = el
        if (panelRef) panelRef.current = el
      }}
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={box === null ? { opacity: 0 } : { opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98 }}
      transition={{ duration: 0.13, ease: 'easeOut' }}
      className={`rcq-menu fixed rounded-lg shadow-lg z-50 ${className}`}
      // The alignment class the caller passed is about the trigger, not the
      // window; these coordinates already carry it, so the unused edge is
      // released rather than left for the class to set.
      style={{
        top: box?.top ?? -9999,
        left: box?.right !== undefined ? 'auto' : (box?.left ?? -9999),
        right: box?.right !== undefined ? box.right : 'auto',
      }}
      // ⚠ The panel is no longer a descendant of the trigger's wrapper, so a
      // caller's click-outside check would fire on a click INSIDE the menu and
      // close it before the item's own handler ran. Nothing that happens in
      // here is any of the document's business.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {children}
    </motion.div>
  )

  return (
    <>
      <span ref={anchor} className="absolute inset-0 pointer-events-none" aria-hidden />
      {createPortal(panel, document.body)}
    </>
  )
}
