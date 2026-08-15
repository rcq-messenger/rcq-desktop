// Modal that lets the user pick a forward target — any contact or
// group. Loads both lists on open via `Api.contacts` + `Api.groups`,
// shows them grouped, and on tap fires `onPick({kind, id})` upstream
// so the parent can encrypt + ship the forwarded text envelope.
//
// Phase-1 scope: forward your own outgoing message text. We don't
// support forwarding incoming messages because we don't render
// them yet.

import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Api, type Contact, type RCQGroup } from '../lib/api'
import { memberCount } from '../lib/group-roster'
import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'
import { contactAlias } from '../lib/local-store'
import { PersonAvatar } from './PersonAvatar'

export type ForwardTarget =
  | { kind: 'peer'; uin: number; name: string; contact: Contact }
  | { kind: 'group'; id: number; name: string; group: RCQGroup }

export function ForwardModal({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean
  onClose: () => void
  onPick: (target: ForwardTarget) => Promise<void> | void
}) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [groups, setGroups] = useState<RCQGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [busyTargetKey, setBusyTargetKey] = useState<string | null>(null)
  /// Anyone with more than a screenful of contacts was scrolling a flat list to
  /// find one person. Filters both sections at once, by name or by number.
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!visible || !identity) return
    setLoading(true)
    // Without rosters: this list shows a name and a count, and the forward
    // itself fetches the roster for the one group the user actually picks.
    void Promise.all([Api.contacts(identity), Api.groups(identity, false)])
      .then(([cs, gs]) => {
        setContacts(cs)
        setGroups(gs)
      })
      .catch(() => {
        // Best effort. Upstream will surface a generic forward
        // failure if the user picks anyway, which can't happen on an
        // empty list.
      })
      .finally(() => setLoading(false))
  }, [visible, identity])

  // Reset the filter between openings; a leftover query reads as an empty list.
  useEffect(() => {
    if (!visible) setQuery('')
  }, [visible])

  /// The name to show and to search on: my own name for them wins over the nick
  /// they chose, exactly as it does in the chat header and the thread.
  const displayName = (c: Contact) => contactAlias(c.uin) ?? c.nickname

  const q = query.trim().toLowerCase()
  const shownContacts = useMemo(
    () =>
      q
        ? contacts.filter(
            (c) => displayName(c).toLowerCase().includes(q) || String(c.uin).includes(q),
          )
        : contacts,
    [contacts, q],
  )
  const shownGroups = useMemo(
    () => (q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups),
    [groups, q],
  )

  const empty = useMemo(
    () => !loading && shownContacts.length === 0 && shownGroups.length === 0,
    [loading, shownContacts, shownGroups],
  )

  async function handlePick(target: ForwardTarget) {
    const key = target.kind === 'peer' ? `peer-${target.uin}` : `group-${target.id}`
    setBusyTargetKey(key)
    try {
      await onPick(target)
    } finally {
      setBusyTargetKey(null)
    }
  }

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
            className="w-full max-w-md h-[70vh] max-h-[560px] flex flex-col rounded-t-xl sm:rounded-xl bg-surface shadow-lg overflow-hidden"
            initial={{ y: 40, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 30, opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
        <header className="flex items-center justify-between px-4 py-3">
          <h2 className="text-sm font-semibold">{t('chat.forward.title')}</h2>
          <button
            onClick={onClose}
            className="text-fg-secondary hover:text-fg-primary text-sm font-mono"
          >
            {t('chat.forward.cancel')}
          </button>
        </header>

        <div className="px-4 pb-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('chat.forward.search')}
            className="w-full rounded-lg bg-field px-3 py-2 text-sm text-fg-primary placeholder:text-fg-dim outline-none"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="px-4 py-6 text-center text-sm text-fg-secondary">…</div>
          )}

          {empty && (
            <div className="px-4 py-6 text-center text-sm text-fg-secondary">
              {t('chat.forward.no_targets')}
            </div>
          )}

          {shownContacts.length > 0 && (
            <Section title={t('chat.forward.contacts')}>
              {shownContacts.map((c) => {
                const key = `peer-${c.uin}`
                const name = displayName(c)
                return (
                  <Row
                    key={key}
                    busy={busyTargetKey === key}
                    onClick={() => void handlePick({ kind: 'peer', uin: c.uin, name, contact: c })}
                  >
                    {/* The picture, not a bare status dot. Picking a person out
                        of a list is the one place a face beats a name, and every
                        other list in the app already shows one. */}
                    <PersonAvatar
                      status={c.status}
                      size={32}
                      mediaId={c.avatar_media_id}
                      mediaKey={c.avatar_media_key}
                    />
                    <div className="flex-1 min-w-0 text-left">
                      <div className="text-sm truncate">{name}</div>
                      <div className="font-mono text-[0.625rem] text-fg-dim">#{c.uin}</div>
                    </div>
                  </Row>
                )
              })}
            </Section>
          )}

          {shownGroups.length > 0 && (
            <Section title={t('chat.forward.groups')}>
              {shownGroups.map((g) => {
                const key = `group-${g.id}`
                return (
                  <Row
                    key={key}
                    busy={busyTargetKey === key}
                    onClick={() =>
                      void handlePick({ kind: 'group', id: g.id, name: g.name, group: g })
                    }
                  >
                    {/* Sized to match the person avatar beside it; the two
                        sections used to be 18px and 18px of different shapes,
                        which is what made the list look ragged. */}
                    <div className="w-8 h-8 rounded-full bg-accent/15 text-accent flex items-center justify-center text-xs font-bold flex-none">
                      {g.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0 text-left">
                      <div className="text-sm truncate">{g.name}</div>
                      <div className="font-mono text-[0.625rem] text-fg-dim">
                        {memberCount(g)}
                      </div>
                    </div>
                  </Row>
                )
              })}
            </Section>
          )}
        </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-4 pt-3 pb-1 font-mono text-[0.625rem] uppercase tracking-[0.2em] text-fg-dim">
        {title}
      </div>
      <ul>{children}</ul>
    </div>
  )
}

function Row({
  busy,
  onClick,
  children,
}: {
  busy: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <li>
      <button
        onClick={onClick}
        disabled={busy}
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-field disabled:opacity-50 disabled:cursor-progress transition-colors"
      >
        {children}
      </button>
    </li>
  )
}
