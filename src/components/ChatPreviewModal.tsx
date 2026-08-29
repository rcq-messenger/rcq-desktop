import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useGroupIncoming, useIncoming, type IncomingRow } from '../lib/incoming-store'
import { loadPersisted, storageKey, type OutgoingRow } from '../lib/outgoing-store'
import { useI18n } from '../lib/i18n-context'
import { PersonAvatar } from './PersonAvatar'
import { GroupAvatar } from './GroupAvatar'
import type { UserStatus } from '../lib/api'

/**
 * Peek at a conversation without opening it (megalist B12/Л2.25) — the
 * desktop's take on the iOS long-press chat preview. Opened from the row's
 * context menu: a centered card over a blurred, dimmed ground, the last
 * stretch of the thread read-only, and one way in (the open button). Clicking
 * anywhere else, or Escape, puts it away. Deliberately no composer and no
 * read-marking: peeking must not tell the peer anything.
 */
export function ChatPreviewModal({
  kind,
  id,
  title,
  status,
  avatarMediaId,
  avatarMediaKey,
  onClose,
}: {
  kind: 'peer' | 'group'
  id: number
  title: string
  status?: UserStatus
  avatarMediaId?: string | null
  avatarMediaKey?: string | null
  onClose: () => void
}) {
  const { t, lang } = useI18n()
  const incoming = useIncoming(kind === 'peer' ? id : null)
  const groupIncoming = useGroupIncoming(kind === 'group' ? id : null)
  const rows = useMemo(() => {
    const inc: (IncomingRow & { mine?: false })[] = kind === 'peer' ? incoming : groupIncoming
    const out: OutgoingRow[] = loadPersisted(storageKey(kind === 'group', id))
    const merged = [
      ...inc.map((m) => ({ id: m.id, text: m.text, at: m.at, mine: false })),
      ...out.filter((r) => r.kind !== 'call').map((r) => ({ id: r.id, text: r.text, at: r.sentAt, mine: true })),
    ]
    merged.sort((a, b) => a.at - b.at)
    return merged.slice(-30)
  }, [incoming, groupIncoming, kind, id])

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows.length])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        onClick={onClose}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md"
      >
        <motion.div
          initial={{ y: 12, scale: 0.97, opacity: 0 }}
          animate={{ y: 0, scale: 1, opacity: 1 }}
          exit={{ y: 12, scale: 0.97, opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-md h-[60vh] max-h-[560px] mx-4 flex flex-col rounded-xl bg-surface shadow-xl overflow-hidden"
        >
          <header className="flex items-center gap-2.5 px-4 py-3 border-b border-line/40">
            {kind === 'peer' ? (
              <PersonAvatar status={status ?? 'offline'} size={28} mediaId={avatarMediaId} mediaKey={avatarMediaKey} />
            ) : (
              <GroupAvatar size={28} mediaId={avatarMediaId} mediaKey={avatarMediaKey} />
            )}
            <div className="font-medium truncate flex-1">{title}</div>
            <button onClick={onClose} aria-label={t('common.cancel')} className="text-fg-secondary hover:text-fg-primary px-1">
              ✕
            </button>
          </header>
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
            {rows.length === 0 && (
              <div className="h-full flex items-center justify-center text-sm text-fg-dim">
                {t('chat.preview.empty')}
              </div>
            )}
            {rows.map((r) => (
              <div key={r.id} className={`flex ${r.mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-1.5 text-sm break-words ${
                    r.mine ? 'bg-accent/20' : 'bg-field'
                  }`}
                >
                  {r.text || <span className="italic text-fg-dim">{t('chat.preview.media')}</span>}
                  <span className="ml-2 text-[0.625rem] text-fg-dim align-baseline">
                    {new Date(r.at).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <footer className="px-4 py-3 border-t border-line/40">
            <Link
              to={kind === 'peer' ? `/chat/${id}` : `/chat/g/${id}`}
              className="block text-center text-sm font-semibold text-accent hover:underline"
              onClick={onClose}
            >
              {t('contacts.open_chat')}
            </Link>
          </footer>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
