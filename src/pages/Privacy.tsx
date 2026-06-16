// Privacy settings — split out of `Settings` once the picker count
// hit five. Mirrors iOS `PrivacySettingsView`. Five tri-state
// scopes: last_seen / gender_visibility / group_invites /
// trade_offers / calls. PUT /users/me writes through optimistic UI;
// the backend echoes the active values via GET so a reload
// reconciles in case a write actually failed.

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Api, type UserInfo } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'

type Scope = 'everyone' | 'contacts' | 'nobody'

export function Privacy() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [info, setInfo] = useState<UserInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!identity) return
    void (async () => {
      try {
        setInfo(await Api.myInfo(identity))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed')
      }
    })()
  }, [identity])

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  async function patch(field: keyof UserInfo, value: Scope) {
    setInfo((cur) => (cur ? { ...cur, [field]: value } : cur))
    try {
      // Mirror call_policy into the dedicated localStorage cache so
      // future surfaces (chat call buttons, etc.) react immediately
      // without a re-fetch round-trip.
      if (field === 'call_policy') {
        localStorage.setItem('rcq.privacy.callPolicy', value)
      }
      await Api.updateProfile(identity!, { [field]: value } as never)
    } catch {
      // Soft-fail — backend echoes via GET on next mount; UI stays
      // optimistic in the meantime.
    }
  }

  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="sticky top-0 bg-surface border-b border-line z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/settings" className="text-fg-secondary hover:text-fg-primary px-2">
            ←
          </Link>
          <div className="font-semibold">{t('settings.section.privacy')}</div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {!info && !error && (
          <div className="text-center text-sm text-fg-secondary py-12">
            {t('contacts.loading')}
          </div>
        )}

        {info && (
          <section className="bg-surface rounded-lg border border-line p-4 divide-y divide-line">
            <div className="pb-3">
              <ScopePicker
                label={t('settings.privacy.last_seen')}
                description={t('settings.privacy.last_seen_desc')}
                value={(info.last_seen_visibility as Scope) ?? 'everyone'}
                onChange={(v) => patch('last_seen_visibility', v)}
                t={t}
              />
            </div>
            <div className="py-3">
              <ScopePicker
                label={t('settings.privacy.gender_visible')}
                description={t('settings.privacy.gender_desc')}
                value={(info.gender_visibility as Scope) ?? 'nobody'}
                onChange={(v) => patch('gender_visibility', v)}
                t={t}
                disabled={!info.gender}
                disabledHint={t('settings.privacy.gender_first')}
              />
            </div>
            <div className="pt-3">
              <ScopePicker
                label={t('settings.privacy.group_invites')}
                description={t('settings.privacy.group_invites_desc')}
                value={(info.group_invite_policy as Scope) ?? 'everyone'}
                onChange={(v) => patch('group_invite_policy', v)}
                t={t}
              />
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

function ScopePicker({
  label,
  description,
  value,
  onChange,
  t,
  disabled,
  disabledHint,
}: {
  label: string
  description?: string
  value: Scope
  onChange: (v: Scope) => void
  t: (k: string, p?: Record<string, string | number>) => string
  disabled?: boolean
  disabledHint?: string
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm flex-1 min-w-0 truncate">{label}</label>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as Scope)}
          disabled={disabled}
          className="bg-surface-dim border border-line rounded-md px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent disabled:opacity-40 flex-none"
        >
          <option value="everyone">{t('settings.privacy.scope.everyone')}</option>
          <option value="contacts">{t('settings.privacy.scope.contacts')}</option>
          <option value="nobody">{t('settings.privacy.scope.nobody')}</option>
        </select>
      </div>
      {/* Per-setting description, right under its control (not a single
          combined block at the bottom). */}
      {description && <p className="text-xs text-fg-dim">{description}</p>}
      {disabled && disabledHint && (
        <p className="text-[10px] text-fg-dim">{disabledHint}</p>
      )}
    </div>
  )
}
