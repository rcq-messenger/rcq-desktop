/// Full-size view for a chat photo, over the app rather than away from it.
///
/// A tap used to call `window.open(blobUrl)`. In a browser that is a popup the
/// blocker may eat; in the desktop build it is worse than that, because the
/// Tauri shell sends outbound navigations to the system browser and a `blob:`
/// URL from the app's own webview means nothing there. So clicking a photo did
/// nothing at all, which is how it was reported: "в вебе/десктопе нельзя
/// открыть фото".
///
/// Staying inside the window also gets the behaviour people expect from a
/// messenger: dark backdrop, picture centred, click anywhere or press Escape to
/// dismiss.

import { useEffect, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

export function MediaLightbox({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  // Escape closes, and the page behind must not scroll while it is up: on a
  // phone the backdrop is the whole screen and a stray drag would scroll the
  // thread underneath.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={onClose}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute top-3 right-4 h-9 w-9 rounded-full bg-white/10 text-white text-xl leading-none hover:bg-white/20 transition-colors"
          >
            ×
          </button>
          {/* The media itself does not close on click: a video needs its own
              controls, and a photo should survive a stray tap on it. */}
          <motion.div
            initial={{ scale: 0.97 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="max-h-full max-w-full"
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
