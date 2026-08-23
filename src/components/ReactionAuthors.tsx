// Who reacted, and with what.
//
// The reaction chips only ever showed a picture and a count, so on a group
// message with five reactions there was no way to find out who any of them came
// from. The client has known the answer all along (the store is keyed by uin),
// it simply had nowhere to say it. Opened by right-click on a chip on desktop
// and by long-press on touch; a plain tap keeps toggling your own reaction,
// which is the common action and must not become two-step.
//
// The rows are LINKS (founder item 22). They were inert: a name and a number
// sitting there looking exactly like every other clickable name in this app and
// doing nothing when you pressed it. Whether a given person's card may be opened
// at all is decided upstream, in the surface that builds these rows, and lands
// here as `profileTo`: a route, or null for "draw the row, do not link it".
// This component never consults the privacy store itself: it does not know
// whose thread it is in, who the viewer is, or which of these people are
// contacts, and a component that has to guess at those is a component that gets
// them wrong.

import { useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Link } from 'react-router-dom'
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
  /// Where tapping this person goes, or null when their card may not be opened
  /// (see the header). Already carries the `?i=<host>` a cross-island card
  /// needs (the own-island profile route would 404 for them).
  profileTo?: string | null
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
  // Grouped by reaction, biggest group first: the same shape both phones use.
  // A flat list repeated the same smiley down the right-hand edge once per
  // person, so "six people liked this" had to be counted by eye, and the one
  // question the sheet exists to answer (who reacted with WHAT) was the hardest
  // thing to read on it.
  const groups = useMemo(() => {
    const by = new Map<string, ReactionAuthor[]>()
    for (const a of authors) {
      const list = by.get(a.asset)
      if (list) list.push(a)
      else by.set(a.asset, [a])
    }
    return [...by.entries()].sort((x, y) => y[1].length - x[1].length)
  }, [authors])
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-md sm:items-center"
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
            <div className="flex-1 overflow-y-auto pb-2">
              {groups.map(([asset, people]) => (
                <section key={asset}>
                  {/* The smiley is the subject of the group, so it is drawn at
                      the size a subject deserves rather than as a trailing
                      marker (same call the phones made). */}
                  <div className="flex items-center gap-2 px-4 pt-3 pb-1">
                    <img
                      src={emoticonAssetURL(asset)}
                      alt={asset}
                      className="h-7 w-7 flex-none select-none"
                      draggable={false}
                    />
                    <span className="text-sm text-fg-secondary tabular-nums">{people.length}</span>
                  </div>
                  <ul>
                    {people.map((a) => {
                      // Identical markup either way, so a row nobody may open
                      // is not visibly a second-class row, it simply does not
                      // respond, exactly like the member lists that are already
                      // gated. The hover tint and the pointer are the only
                      // difference, and they are the honest ones: they promise
                      // something will happen, and something does.
                      const body = (
                        <>
                          <PersonAvatar
                            status={a.status}
                            size={28}
                            mediaId={a.avatarMediaId}
                            mediaKey={a.avatarMediaKey}
                            crossIsland={a.crossIsland}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm">{a.name}</div>
                            <div className="font-mono text-[0.625rem] text-fg-dim">#{a.uin}</div>
                          </div>
                        </>
                      )
                      return (
                        <li key={`${a.uin}-${asset}`}>
                          {a.profileTo ? (
                            <Link
                              to={a.profileTo}
                              // Navigating away unmounts this sheet with the
                              // whole chat, but closing first keeps the state
                              // honest for the back button: returning to the
                              // thread should not land on a sheet the user
                              // already left.
                              onClick={onClose}
                              className="flex items-center gap-3 pl-8 pr-4 py-1.5 transition-colors hover:bg-field"
                            >
                              {body}
                            </Link>
                          ) : (
                            <div className="flex items-center gap-3 pl-8 pr-4 py-1.5">{body}</div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
