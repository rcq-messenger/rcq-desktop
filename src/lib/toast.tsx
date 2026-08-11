/// One place for everything the app says in passing: "copied", "saved",
/// "could not reach the island".
///
/// Before this, every screen answered that question for itself. Chat had a
/// tidy pill that faded in at the top; Settings had two more states of its own
/// and drew a red panel and a grey line inside the section; the recovery phrase
/// answered by relabelling the button to "Copied"; Login did the same trick
/// separately. Four idioms for one idea, none of them in the same corner of the
/// screen, and a person who copied their phrase in Settings got a different
/// experience from one who copied a message in a chat.
///
/// So: a provider at the root, a `toast()` from anywhere, and one host that
/// renders the stack. Notices are transient by definition — none of them is a
/// state worth keeping, which is why they are not stored on the screens that
/// raise them.
///
/// ⚠ Deliberately NOT the same surface as MessageToasts. Those are incoming
/// messages, they are actionable and they sit top-right; these are answers to
/// something the person just did and belong near their hands, bottom-centre. A
/// shared stack would mix "someone wrote to you" with "copied", and the first
/// would be lost among the second.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

export type ToastKind = 'info' | 'error'

interface Notice {
  id: number
  text: string
  kind: ToastKind
}

interface ToastApi {
  /** Say something and forget it. Errors linger a little longer than
   *  confirmations: "copied" is read in a glance, a failure is read twice. */
  toast: (text: string, kind?: ToastKind) => void
}

const ToastContext = createContext<ToastApi>({ toast: () => {} })

const DISMISS_MS: Record<ToastKind, number> = { info: 3000, error: 5000 }
const MAX_VISIBLE = 3

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([])

  const toast = useCallback((text: string, kind: ToastKind = 'info') => {
    if (!text.trim()) return
    const id = nextId++
    // Keep the newest at the end, drop the oldest past the cap: a burst (a
    // failing action retried three times) must not build a column that covers
    // the composer.
    setNotices((cur) => [...cur, { id, text, kind }].slice(-MAX_VISIBLE))
    window.setTimeout(
      () => setNotices((cur) => cur.filter((n) => n.id !== id)),
      DISMISS_MS[kind],
    )
  }, [])

  const api = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Clear of the composer. At a smaller offset the pill landed ON the
          message field, and "Скопировано" sat across the placeholder — the one
          place on the screen a person is about to look at or type into. */}
      <div className="fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 px-4 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] pointer-events-none">
        <AnimatePresence initial={false}>
          {notices.map((n) => (
            <motion.div
              key={n.id}
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className={
                'max-w-md rounded-full px-4 py-2 text-xs font-medium shadow-lg text-center break-words ' +
                // The page's own tokens inverted, so it has contrast in both
                // themes without naming a colour: `--c-ink-black` is a
                // near-white in dark mode and burned an earlier version of this
                // pill, which put white text on a near-white bar.
                (n.kind === 'error'
                  ? 'bg-red-500/95 text-white'
                  : 'bg-fg-primary/90 text-surface-dim')
              }
            >
              {n.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  return useContext(ToastContext)
}
