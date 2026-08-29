import { motion } from 'framer-motion'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

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
 * Positioning contract: the trigger's wrapper is `relative`, the panel is
 * `absolute` off `top-full`/`bottom-full`. Width and alignment come from
 * `className` so call sites keep their `w-56 right-0` etc.
 */
export function MenuPanel({
  className = '',
  children,
  onClick,
  panelRef,
}: {
  className?: string
  children: ReactNode
  onClick?: (e: React.MouseEvent) => void
  /** For the caller's click-outside check — the measuring ref stays internal. */
  panelRef?: React.MutableRefObject<HTMLDivElement | null>
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  // null = not yet measured: render invisibly at the default spot for one
  // frame, decide, then animate in at the final one — flipping AFTER the
  // entrance began would read as a jump, which is the very complaint.
  const [flip, setFlip] = useState<boolean | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setFlip(r.bottom > window.innerHeight - 8 && r.top > r.height + 16)
  }, [])
  return (
    <motion.div
      ref={(el: HTMLDivElement | null) => {
        ref.current = el
        if (panelRef) panelRef.current = el
      }}
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={flip === null ? { opacity: 0 } : { opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98 }}
      transition={{ duration: 0.13, ease: 'easeOut' }}
      className={`rcq-menu absolute ${flip ? 'bottom-full mb-1' : 'top-full mt-1'} rounded-lg shadow-lg z-30 ${className}`}
      onClick={onClick}
    >
      {children}
    </motion.div>
  )
}
