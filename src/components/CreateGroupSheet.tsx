// Create-group sheet. Two-step form: name + multi-select from
// the user's contacts. POST /groups returns the new group; the
// host re-fetches the contacts surface to surface it.

import { useState } from 'react'
import { Api, type Contact } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { StatusIcon } from './StatusIcon'

interface Props {
  contacts: Contact[]
  onClose: () => void
  onCreated: () => void
}

export function CreateGroupSheet({ contacts, onClose, onCreated }: Props) {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!identity) return
    setBusy(true)
    setError(null)
    try {
      await Api.createGroup(identity, name.trim(), [...picked])
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  const sorted = [...contacts]
    .filter((c) => !c.blocked)
    .sort((a, b) => a.nickname.localeCompare(b.nickname))

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface w-full sm:max-w-md sm:rounded-lg rounded-t-2xl shadow-xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-4 border-b border-line">
          <div className="font-semibold">{t('group.create.title')}</div>
          <button
            onClick={onClose}
            className="text-fg-secondary hover:text-fg-primary px-2"
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </header>

        <div className="p-4 space-y-3 border-b border-line">
          <label className="text-xs font-semibold text-fg-secondary uppercase tracking-wide block">
            {t('group.create.name')}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            placeholder={t('group.create.name_placeholder')}
            className="w-full h-10 px-3 rounded-md border border-line bg-surface-dim outline-none focus:border-accent focus:ring-1 focus:ring-accent text-sm"
          />
          <div className="flex items-baseline justify-between">
            <label className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
              {t('group.create.members')}
            </label>
            <span className="text-xs text-fg-dim font-mono">{picked.size}</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sorted.length === 0 && (
            <div className="text-center text-sm text-fg-secondary py-8">
              {t('contacts.empty')}
            </div>
          )}
          <ul className="divide-y divide-line">
            {sorted.map((c) => {
              const on = picked.has(c.uin)
              return (
                <li key={c.uin}>
                  <button
                    onClick={() => {
                      setPicked((prev) => {
                        const next = new Set(prev)
                        if (next.has(c.uin)) next.delete(c.uin)
                        else next.add(c.uin)
                        return next
                      })
                    }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-dim transition-colors text-left"
                  >
                    <StatusIcon status={c.status} size={18} />
                    <span className="flex-1 truncate text-sm">
                      {c.nickname || `#${c.uin}`}
                    </span>
                    <span
                      className={
                        'w-5 h-5 rounded-full border-2 flex items-center justify-center text-[10px] font-bold ' +
                        (on
                          ? 'bg-accent border-accent text-white'
                          : 'border-line')
                      }
                    >
                      {on ? '✓' : ''}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="p-4 border-t border-line space-y-2">
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">
              {error}
            </div>
          )}
          <button
            onClick={() => void submit()}
            disabled={busy || !name.trim() || picked.size === 0}
            className="w-full h-11 rounded-md bg-accent hover:bg-accent-dim text-white font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? t('group.create.busy') : t('group.create.cta')}
          </button>
        </div>
      </div>
    </div>
  )
}
