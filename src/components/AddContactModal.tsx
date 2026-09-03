/// "Add a contact" as a window over the list, not a page you leave the list
/// for. Same body as the /add route — the page component takes an `embedded`
/// flag and drops its own header — so search, the cross-island `uin@host` path
/// and the "requested" pill all behave exactly as they did.

import { AnimatePresence, motion } from 'framer-motion'
import { useI18n } from '../lib/i18n-context'
import { AddContact } from '../pages/AddContact'

export function AddContactModal({
  onClose,
  initialQuery,
}: { onClose: () => void; initialQuery?: string }) {
  const { t } = useI18n()
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        onClick={onClose}
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-md sm:items-center"
      >
        <motion.div
          initial={{ y: 16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 16, opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-md h-[70vh] max-h-[560px] flex flex-col rounded-t-xl sm:rounded-xl bg-surface shadow-lg overflow-hidden"
        >
          <header className="flex items-center justify-between gap-2 px-4 py-3">
            <span className="text-sm font-semibold">{t('add.title')}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="text-fg-secondary hover:text-fg-primary px-1"
            >
              ✕
            </button>
          </header>
          {/* The embedded page body drops its own top padding by contract
            (same as PendingRequests), so the modal owes it. Without this the
            search field sits 12px under the header and its focus ring is
            clipped along the top edge. */}
        <div className="flex-1 overflow-y-auto pt-3">
            <AddContact embedded initialQuery={initialQuery} />
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
