/// "Share group" — pick one of your groups and drop its invite link into the
/// conversation you have open (#578 — "на ПК нет 'Поделиться группой'"). This
/// is Android's group picker from the attach menu (ui/ChatScreen.kt:1694), and
/// it produces exactly what the phones produce: the canonical
/// `https://rcq.app/g/<id>@<host>` link, sent as an ordinary text message. Both
/// ends already paint that as a join card (GroupJoinCard), so nothing new goes
/// on the wire — the web simply had no way to type the link.
///
/// The host is never assumed to be ours: a group can live on another island,
/// and there the route id is a local alias that means nothing to anyone else
/// (see `groupShareRef`). Which is why the list is seeded from the contacts
/// snapshot — that is where the aliased cross-island groups already live — and
/// only the local half is refreshed from the island behind it.

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { Api, type RCQGroup } from '../lib/api'
import { contactsCache, restoreSnapshot } from '../lib/contacts-cache'
import { groupShareLink } from '../lib/group-invite'
import { memberCount } from '../lib/group-roster'
import { compactCount } from '../lib/format-count'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { isForeignGroupId } from '../lib/visited-islands'
import { GroupAvatar } from './GroupAvatar'

export function ShareGroupSheet({
  onClose,
  onPick,
}: {
  onClose: () => void
  /// The finished link, ready to be sent into the open thread.
  onPick: (link: string) => void | Promise<void>
}) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [groups, setGroups] = useState<RCQGroup[] | null>(() => {
    if (!identity) return null
    restoreSnapshot(identity.uin)
    return contactsCache.get(identity.uin)?.groups ?? null
  })

  useEffect(() => {
    if (!identity) return
    let alive = true
    // Rosters are not needed to share a link, so ask for the cheap list. The
    // cross-island half keeps its cached alias ids: re-fetching those would
    // hand back the FOREIGN island's own numbering, which builds the wrong
    // link for every one of them.
    void Api.groups(identity, false)
      .then((local) => {
        if (!alive) return
        setGroups((prev) => [...local, ...(prev ?? []).filter((g) => isForeignGroupId(g.id))])
      })
      .catch(() => {
        if (alive) setGroups((prev) => prev ?? [])
      })
    return () => {
      alive = false
    }
  }, [identity])

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
          className="w-full max-w-md max-h-[70vh] flex flex-col rounded-t-xl sm:rounded-xl bg-surface shadow-lg overflow-hidden"
        >
          <header className="flex items-center justify-between gap-2 px-4 py-3">
            <span className="text-sm font-semibold">{t('chat.attach.group')}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="text-fg-secondary hover:text-fg-primary px-1"
            >
              ✕
            </button>
          </header>

          <div className="flex-1 overflow-y-auto pb-2">
            {groups === null && (
              <div className="px-4 py-6 text-center text-sm text-fg-secondary">…</div>
            )}
            {groups?.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-fg-secondary">
                {t('group.share.none')}
              </div>
            )}
            <ul>
              {groups?.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!identity) return
                      onClose()
                      void onPick(groupShareLink(identity, g.id))
                    }}
                    className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-field transition-colors text-left"
                  >
                    <GroupAvatar size={32} mediaId={g.avatar_media_id} mediaKey={g.avatar_media_key} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{g.name}</div>
                      <div className="font-mono text-[0.625rem] text-fg-dim">{compactCount(memberCount(g))}</div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
