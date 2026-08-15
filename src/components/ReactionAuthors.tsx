// Who reacted, and with what.
//
// The reaction chips only ever showed a picture and a count, so on a group
// message with five reactions there was no way to find out who any of them came
// from — the client has known the answer all along (the store is keyed by uin),
// it simply had nowhere to say it. Opened by right-click on a chip on desktop
// and by long-press on touch; a plain tap keeps toggling your own reaction,
// which is the common action and must not become two-step.

import { AnimatePresence, motion } from 'framer-motion'
import { emoticonAssetURL } from '../lib/emoticons'
import { useI18n } from '../lib/i18n-context'
import { PersonAvatar } from './PersonAvatar'
import type { UserStatus } from '../lib/api'

export interface ReactionAuthor {
  uin: number
  asset: string
  name: string
  status: UserStatus
  avatarMediaId?: string | null
  avatarMediaKey?: string | null
  /// Their picture lives on another island, so it is not fetchable from ours.
  crossIsland?: boolean
}

export function ReactionAuthors({
  visible,
  authors,
  onClose,
}: {
  visible: boolean
  authors: ReactionAuthor[]
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onClick={onClose}
        >
          <motion.div
            className="w-full max-w-xs max-h-[60vh] flex flex-col rounded-t-xl sm:rounded-xl bg-surface shadow-lg overflow-hidden"
            initial={{ y: 40, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 30, opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between px-4 py-3">
              <h2 className="text-sm font-semibold">{t('chat.reactions.who')}</h2>
              <button
                onClick={onClose}
                className="font-mono text-sm text-fg-secondary transition-colors hover:text-fg-primary"
              >
                {t('chat.forward.cancel')}
              </button>
            </header>
            <ul className="flex-1 overflow-y-auto pb-2">
              {authors.map((a) => (
                <li key={`${a.uin}-${a.asset}`} className="flex items-center gap-3 px-4 py-2">
                  <PersonAvatar
                    status={a.status}
                    size={32}
                    mediaId={a.avatarMediaId}
                    mediaKey={a.avatarMediaKey}
                    crossIsland={a.crossIsland}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{a.name}</div>
                    <div className="font-mono text-[0.625rem] text-fg-dim">#{a.uin}</div>
                  </div>
                  <img
                    src={emoticonAssetURL(a.asset)}
                    alt={a.asset}
                    className="h-5 w-5 flex-none select-none"
                    draggable={false}
                  />
                </li>
              ))}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
