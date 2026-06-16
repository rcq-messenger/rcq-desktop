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
import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'
import { StatusIcon } from './StatusIcon'

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

  useEffect(() => {
    if (!visible || !identity) return
    setLoading(true)
    void Promise.all([Api.contacts(identity), Api.groups(identity)])
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

  const empty = useMemo(
    () => !loading && contacts.length === 0 && groups.length === 0,
    [loading, contacts, groups],
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
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onClick={onClose}
        >
          <motion.div
            className="w-full max-w-md max-h-[80vh] flex flex-col rounded-t-xl sm:rounded-xl bg-surface border border-line shadow-lg overflow-hidden"
            initial={{ y: 40, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 30, opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
        <header className="flex items-center justify-between px-4 py-3 border-b border-line">
          <h2 className="text-sm font-semibold">{t('chat.forward.title')}</h2>
          <button
            onClick={onClose}
            className="text-fg-secondary hover:text-fg-primary text-sm font-mono"
          >
            {t('chat.forward.cancel')}
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="px-4 py-6 text-center text-sm text-fg-secondary">…</div>
          )}

          {empty && (
            <div className="px-4 py-6 text-center text-sm text-fg-secondary">
              {t('chat.forward.no_targets')}
            </div>
          )}

          {contacts.length > 0 && (
            <Section title={t('chat.forward.contacts')}>
              {contacts.map((c) => {
                const key = `peer-${c.uin}`
                return (
                  <Row
                    key={key}
                    busy={busyTargetKey === key}
                    onClick={() =>
                      void handlePick({ kind: 'peer', uin: c.uin, name: c.nickname, contact: c })
                    }
                  >
                    <StatusIcon status={c.status} size={18} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{c.nickname}</div>
                      <div className="font-mono text-[10px] text-fg-dim">#{c.uin}</div>
                    </div>
                  </Row>
                )
              })}
            </Section>
          )}

          {groups.length > 0 && (
            <Section title={t('chat.forward.groups')}>
              {groups.map((g) => {
                const key = `group-${g.id}`
                return (
                  <Row
                    key={key}
                    busy={busyTargetKey === key}
                    onClick={() =>
                      void handlePick({ kind: 'group', id: g.id, name: g.name, group: g })
                    }
                  >
                    <div className="w-[18px] h-[18px] rounded-full bg-accent/15 text-accent flex items-center justify-center text-[10px] font-bold flex-none">
                      {g.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{g.name}</div>
                      <div className="font-mono text-[10px] text-fg-dim">
                        {g.members.length}
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
    <div className="border-b border-line last:border-b-0">
      <div className="px-4 pt-3 pb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-fg-dim">
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
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-surface-dim disabled:opacity-50 disabled:cursor-progress transition-colors"
      >
        {children}
      </button>
    </li>
  )
}
