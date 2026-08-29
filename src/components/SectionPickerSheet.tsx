// The plus button on a user section: which chats live in it.
//
// One sheet, one write. Ticking five people and closing costs the account one
// vault put, not five (the write budget is 240 an hour and a section is not
// worth a fifth of one per name).
//
// The list is contacts, cross-island peers and groups together, because that
// is what a section holds. Rows are identified by the MEMBER KEY, built by the
// caller from sections.ts (`p:<uin>[@host]`, `g:<id>[@host]`): a uin is
// per-island and a foreign group's local id is a per-device alias, so nothing
// here ever sees a bare number.

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../lib/i18n-context'
import { MAX_MEMBERS_PER_SECTION } from '../lib/sections'
import { GroupAvatar } from './GroupAvatar'
import { PersonAvatar } from './PersonAvatar'
import type { UserStatus } from '../lib/api'

export interface SectionCandidate {
  /// The member key. Stable across devices; this is what goes in the slot.
  key: string
  title: string
  subtitle: string
  kind: 'peer' | 'group'
  status?: UserStatus
  crossIsland?: boolean
  avatarMediaId?: string | null
  avatarMediaKey?: string | null
}

interface Props {
  sectionName: string
  candidates: SectionCandidate[]
  /// Member keys already in this section, as they were when the sheet opened.
  selected: string[]
  onClose: () => void
  /// What the user actually did: the keys they ticked and the keys they
  /// unticked, both relative to the membership this sheet opened on.
  ///
  /// ⚠⚠ NOT "the full membership after the sheet". The caller used to diff the
  /// returned list against the CURRENT tree, and the tree moves under an open
  /// sheet: the phone files a chat into this same section, the `vault_changed`
  /// nudge folds it into the cache, and pressing Save on a row the user never
  /// touched wrote a tombstone over the phone's add, at a later ts, so the
  /// merge kept the undo. A sheet reports its own edits and nothing else.
  onSave: (added: string[], removed: string[]) => void
}

export function SectionPickerSheet({ sectionName, candidates, selected, onClose, onSave }: Props) {
  const { t } = useI18n()
  const [picked, setPicked] = useState<Set<string>>(() => new Set(selected))
  /// What the section held when this sheet opened. Frozen on purpose: it is
  /// the other half of the diff above, and re-seeding it from a later render
  /// would put the stale-snapshot bug back in a different place.
  const [baseline] = useState<Set<string>>(() => new Set(selected))
  const [query, setQuery] = useState('')

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return candidates
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.subtitle.toLowerCase().includes(q))
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [candidates, query])

  const full = picked.size > MAX_MEMBERS_PER_SECTION

  return createPortal(
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface w-full sm:max-w-md sm:rounded-lg rounded-t-2xl shadow-xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-4">
          <div className="font-semibold truncate">{t('sections.picker.title', { name: sectionName })}</div>
          <button onClick={onClose} className="text-fg-secondary hover:text-fg-primary px-2" aria-label={t('common.close')}>
            ✕
          </button>
        </header>

        <div className="px-4 pb-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sections.picker.search')}
            className="w-full h-10 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {rows.length === 0 && (
            <div className="text-center text-sm text-fg-secondary px-6 py-8">{t('sections.picker.nobody')}</div>
          )}
          <ul>
            {rows.map((c) => {
              const on = picked.has(c.key)
              return (
                <li key={c.key}>
                  <button
                    type="button"
                    onClick={() =>
                      setPicked((prev) => {
                        const next = new Set(prev)
                        if (next.has(c.key)) next.delete(c.key)
                        else next.add(c.key)
                        return next
                      })
                    }
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-field transition-colors text-left"
                  >
                    {c.kind === 'group' ? (
                      <GroupAvatar size={28} mediaId={c.avatarMediaId} mediaKey={c.avatarMediaKey} />
                    ) : (
                      <PersonAvatar
                        size={28}
                        status={c.status ?? 'offline'}
                        crossIsland={c.crossIsland}
                        mediaId={c.avatarMediaId}
                        mediaKey={c.avatarMediaKey}
                      />
                    )}
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-sm">{c.title}</span>
                      <span className="block truncate text-xs text-fg-dim">{c.subtitle}</span>
                    </span>
                    <span
                      className={
                        'flex-none w-5 h-5 rounded-md flex items-center justify-center ' +
                        (on ? 'bg-accent text-white' : 'bg-field')
                      }
                      aria-hidden
                    >
                      {on ? '✓' : ''}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <footer className="p-4 space-y-2">
          {full && <div className="text-xs text-red-500">{t('sections.err.section_full')}</div>}
          <button
            type="button"
            disabled={full}
            onClick={() => {
              onSave(
                [...picked].filter((k) => !baseline.has(k)),
                [...baseline].filter((k) => !picked.has(k)),
              )
              onClose()
            }}
            className="w-full h-10 rounded-md bg-accent hover:bg-accent-dim disabled:opacity-50 text-white text-sm font-semibold transition-colors"
          >
            {t('sections.picker.save')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
