// Create-group sheet. Two-step form: name + multi-select from
// the user's contacts. POST /groups returns the new group; the
// host re-fetches the contacts surface to surface it.

import { useState } from 'react'
import { Api, type Contact } from '../lib/api'
import { groupInviteLink, uinForContactOnIsland } from '../lib/crossisland-groupadd'
import { listCrossIsland, type CrossIslandContact } from '../lib/crossisland-store'
import { deliverCrossIsland } from '../lib/federation-send'
import { newUUIDv4 } from '../lib/crypto'
import { islandLabel } from '../lib/island-choice'
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
      // ⚠ Locals only into the create — a cross-island pick's uin means
      // nothing to OUR island (or worse, names a local stranger on a uin
      // collision). Foreigners then ride the §5c add the member sheet already
      // uses: resolve-or-mint their keys here, add THAT uin, and hand them
      // the invite link in a 1:1 — the only channel that tells them (A3).
      const localPicks = [...picked].filter((u) => !crossByUin.has(u))
      const g = await Api.createGroup(identity, name.trim(), localPicks)
      const notInvited: string[] = []
      for (const u of picked) {
        const ci = crossByUin.get(u)
        if (!ci) continue
        const there = await uinForContactOnIsland(ownHost, {
          identityKey: ci.identityKey,
          signingKey: ci.signingKey,
          nickname: ci.nickname,
          uin: ci.uin,
        })
        if (there == null) {
          notInvited.push(ci.nickname || `#${ci.uin}`)
          continue
        }
        try {
          await Api.addGroupMember(identity, g.id, there)
        } catch {
          notInvited.push(ci.nickname || `#${ci.uin}`)
          continue
        }
        try {
          await deliverCrossIsland(
            identity,
            ci.host,
            ci.uin,
            { kind: 'text', id: newUUIDv4(), text: groupInviteLink(g.id, ownHost) },
            { identityKey: ci.identityKey, signingKey: ci.signingKey },
          )
        } catch {
          notInvited.push(ci.nickname || `#${ci.uin}`)
        }
      }
      if (notInvited.length > 0) {
        setError(t('group.create.cross_not_invited', { names: notInvited.join(', ') }))
        setBusy(false)
        return
      }
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  const ownHost = islandLabel(identity?.apiBase ?? '')
  const cross = listCrossIsland()
  const crossByUin = new Map(cross.map((c) => [c.uin, c] as [number, CrossIslandContact]))
  const sorted: (Contact | (CrossIslandContact & { blocked?: boolean; status?: 'offline' }))[] = [
    ...contacts.filter((c) => !c.blocked),
    // Peers on other islands were simply absent from this picker — the sheet
    // received the server roster and nothing else (A3, web half).
    ...cross.filter((ci) => !contacts.some((c) => c.uin === ci.uin)),
  ].sort((a, b) => a.nickname.localeCompare(b.nickname))

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface w-full sm:max-w-md sm:rounded-lg rounded-t-2xl shadow-xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-4">
          <div className="font-semibold">{t('group.create.title')}</div>
          <button
            onClick={onClose}
            className="text-fg-secondary hover:text-fg-primary px-2"
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </header>

        <div className="p-4 space-y-3">
          <label className="text-xs font-semibold text-fg-secondary uppercase tracking-wide block">
            {t('group.create.name')}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            placeholder={t('group.create.name_placeholder')}
            className="w-full h-10 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
          />
          <div className="flex items-baseline justify-between">
            <label className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
              {t('group.create.members')}
            </label>
            <span className="text-xs text-fg-dim">{picked.size}</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sorted.length === 0 && (
            <div className="text-center text-sm text-fg-secondary py-8">
              {t('contacts.empty')}
            </div>
          )}
          <ul className="">
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
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-field transition-colors text-left"
                  >
                    <StatusIcon status={('host' in c && c.host ? 'offline' : (c as Contact).status) ?? 'offline'} size={18} crossIsland={'host' in c && !!c.host} />
                    <span className="flex-1 truncate text-sm">
                      {c.nickname || `#${c.uin}`}
                      {'host' in c && c.host ? (
                        <span className="ml-1.5 text-xs text-fg-dim">· {c.host}</span>
                      ) : null}
                    </span>
                    <span
                      className={
                        'w-5 h-5 rounded-full border-2 flex items-center justify-center text-[0.625rem] font-bold ' +
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

        <div className="p-4 space-y-2">
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
