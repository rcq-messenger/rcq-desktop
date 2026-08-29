import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { incomingSnapshots } from '../lib/incoming-store'
import { allOutgoingThreads } from '../lib/outgoing-store'
import { useI18n } from '../lib/i18n-context'
import { EmoticonText } from './EmoticonText'
import { PersonAvatar } from './PersonAvatar'
import { GroupAvatar } from './GroupAvatar'
import type { Contact, RCQGroup } from '../lib/api'

/**
 * Search every conversation from the home screen (founder, 29.08): chats by
 * name, messages by text, newest hits first, a tap lands on the message.
 *
 * Runs over what this device already holds (the incoming store's maps and the
 * outgoing store's scoped keys) and nothing else: the server cannot search
 * sealed history for us, and must not learn what we look for. Recomputed per
 * keystroke over plain in-memory rows; even a few thousand rows is a
 * micro-task, so there is no index to build or invalidate.
 */

interface MsgHit {
  isGroup: boolean
  threadId: number
  msgId: string
  text: string
  at: number
  fromUin: number | null
}

const MAX_HITS = 100

export function GlobalSearchOverlay({
  contacts,
  groups,
  onClose,
}: {
  contacts: Contact[]
  groups: RCQGroup[]
  onClose: () => void
}) {
  const { t, lang } = useI18n()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const query = q.trim().toLowerCase()
  const contactByUin = useMemo(() => new Map(contacts.map((c) => [c.uin, c])), [contacts])
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])

  // Chats by name (and a bare uin, the way people quote each other).
  const chatHits = useMemo(() => {
    if (!query) return []
    const cs = contacts
      .filter((c) => (c.nickname || '').toLowerCase().includes(query) || String(c.uin).includes(query))
      .slice(0, 6)
      .map((c) => ({ isGroup: false as const, id: c.uin, title: c.nickname || `#${c.uin}`, c, g: null as RCQGroup | null }))
    const gs = groups
      .filter((g) => (g.name || '').toLowerCase().includes(query))
      .slice(0, 6)
      .map((g) => ({ isGroup: true as const, id: g.id, title: g.name, c: null as Contact | null, g }))
    return [...cs, ...gs]
  }, [query, contacts, groups])

  // Messages by text, both directions, every thread, newest first.
  const msgHits = useMemo<MsgHit[]>(() => {
    if (query.length < 2) return []
    const hits: MsgHit[] = []
    const push = (isGroup: boolean, threadId: number, msgId: string, text: string | undefined, at: number, fromUin: number | null) => {
      if (!text) return
      if (!text.toLowerCase().includes(query)) return
      hits.push({ isGroup, threadId, msgId, text, at, fromUin })
    }
    const snaps = incomingSnapshots()
    for (const [uin, rows] of snaps.peers) for (const r of rows) push(false, uin, r.id, r.text, r.at, uin)
    for (const [gid, rows] of snaps.groups) for (const r of rows) push(true, gid, r.id, r.text, r.at, r.from)
    for (const th of allOutgoingThreads())
      for (const r of th.rows) if (!r.kind || r.kind === 'text') push(th.isGroup, th.id, r.id, r.text, r.sentAt, null)
    hits.sort((a, b) => b.at - a.at)
    return hits.slice(0, MAX_HITS)
  }, [query])

  const threadTitle = (h: MsgHit): string =>
    h.isGroup ? groupById.get(h.threadId)?.name ?? `#${h.threadId}` : contactByUin.get(h.threadId)?.nickname ?? `#${h.threadId}`

  const authorLabel = (h: MsgHit): string | null => {
    if (h.fromUin == null) return t('home.search.you')
    if (!h.isGroup) return null // the thread title already names them
    return contactByUin.get(h.fromUin)?.nickname ?? `#${h.fromUin}`
  }

  /// A window around the first match, not the whole body: a hit inside a long
  /// paragraph should show the words that matched, not its first two lines.
  const snippet = (text: string): string => {
    const i = text.toLowerCase().indexOf(query)
    if (i <= 40) return text.length > 160 ? `${text.slice(0, 160)}…` : text
    const start = i - 40
    const end = Math.min(text.length, i + 120)
    return `…${text.slice(start, end)}${end < text.length ? '…' : ''}`
  }

  const open = (isGroup: boolean, threadId: number, msgId?: string) => {
    navigate(isGroup ? `/chat/g/${threadId}` : `/chat/${threadId}`, msgId ? { state: { jump: msgId } } : undefined)
    onClose()
  }

  const stamp = (at: number): string =>
    new Date(at).toLocaleString(lang === 'ru' ? 'ru-RU' : undefined, {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })

  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-md pt-[10vh]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg mx-4 flex flex-col max-h-[70vh] rounded-xl bg-surface shadow-xl overflow-hidden"
      >
        <div className="p-3 border-b border-line/40">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('home.search.placeholder')}
            className="w-full rounded-lg bg-field px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {query.length < 2 && chatHits.length === 0 && (
            <div className="py-10 text-center text-sm text-fg-dim">{t('home.search.idle')}</div>
          )}
          {chatHits.length > 0 && (
            <>
              <div className="px-4 pt-3 pb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-fg-dim">
                {t('home.search.chats')}
              </div>
              {chatHits.map((h) => (
                <button
                  key={`${h.isGroup ? 'g' : 'p'}${h.id}`}
                  onClick={() => open(h.isGroup, h.id)}
                  className="w-full flex items-center gap-2.5 px-4 py-2 text-left hover:bg-field transition-colors"
                >
                  {h.isGroup ? (
                    <GroupAvatar size={28} mediaId={h.g?.avatar_media_id} mediaKey={h.g?.avatar_media_key} />
                  ) : (
                    <PersonAvatar
                      status={h.c?.status ?? 'offline'}
                      size={28}
                      mediaId={h.c?.avatar_media_id}
                      mediaKey={h.c?.avatar_media_key}
                    />
                  )}
                  <span className="text-sm truncate">{h.title}</span>
                </button>
              ))}
            </>
          )}
          {msgHits.length > 0 && (
            <>
              <div className="px-4 pt-3 pb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-fg-dim">
                {t('home.search.messages')}
              </div>
              {msgHits.map((h) => (
                <button
                  key={`${h.isGroup ? 'g' : 'p'}${h.threadId}:${h.msgId}`}
                  onClick={() => open(h.isGroup, h.threadId, h.msgId)}
                  className="w-full px-4 py-2 text-left hover:bg-field transition-colors"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-semibold truncate">{threadTitle(h)}</span>
                    {authorLabel(h) && <span className="text-[0.625rem] text-fg-dim truncate">{authorLabel(h)}</span>}
                    <span className="ml-auto text-[0.625rem] text-fg-dim tabular-nums flex-none">{stamp(h.at)}</span>
                  </div>
                  <div className="text-sm text-fg-secondary line-clamp-2">
                    <EmoticonText text={snippet(h.text)} emoticonSize={14} />
                  </div>
                </button>
              ))}
            </>
          )}
          {query.length >= 2 && chatHits.length === 0 && msgHits.length === 0 && (
            <div className="py-10 text-center text-sm text-fg-dim">{t('home.search.empty')}</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
