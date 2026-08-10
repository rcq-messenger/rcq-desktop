// Profile surface — own (with edit mode) and peer (read-only).
// Route: `/profile` for own, `/profile/:uin` for peer. The same
// component handles both: it inspects `useParams()` and the active
// identity to decide.

import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { PersonAvatar } from '../components/PersonAvatar'
import { Api, type UserInfo } from '../lib/api'
import { useI18n } from '../lib/i18n-context'
import { useIdentity } from '../lib/identity-context'
import { getCrossIsland } from '../lib/crossisland-store'
import { useContactAliases } from '../lib/local-store'
import { uploadEncryptedImage } from '../lib/media'

const GENDER_OPTIONS: { value: string; key: string }[] = [
  { value: '', key: 'profile.gender.dont_share' },
  { value: 'male', key: 'profile.gender.male' },
  { value: 'female', key: 'profile.gender.female' },
  { value: 'other', key: 'profile.gender.other' },
]

export function Profile() {
  const { identity } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()
  const params = useParams<{ uin?: string }>()
  const [searchParams] = useSearchParams()
  const targetUIN = params.uin ? Number(params.uin) : identity?.uin
  const isSelf = !!identity && targetUIN === identity.uin
  // §5c: `?i=<host>` marks a cross-island peer — render from the local card
  // (own-island /users/{uin}/info would 404). Read-only, never editable.
  const crossIslandHost = !isSelf ? searchParams.get('i') : null

  const [info, setInfo] = useState<UserInfo | null>(null)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Editable copies — only used when `editing`.
  const [draft, setDraft] = useState<UserInfo | null>(null)

  useEffect(() => {
    if (!identity || !targetUIN) return
    // Cross-island peer: build a minimal read-only profile from the stored card.
    if (crossIslandHost) {
      const ci = getCrossIsland(targetUIN, crossIslandHost)
      setInfo({
        uin: targetUIN,
        nickname: ci?.nickname || `${targetUIN}@${crossIslandHost}`,
        status: 'offline',
        status_message: ci?.statusMessage ?? null,
        gender: ci?.gender ?? null,
      } as UserInfo)
      return
    }
    void (async () => {
      try {
        const data = await Api.userInfo(identity, targetUIN)
        setInfo(data)
      } catch (e) {
        setError(e instanceof Error ? e.message : t('profile.error'))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, targetUIN, crossIslandHost])

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  function startEdit() {
    if (!info) return
    setDraft({ ...info })
    setEditing(true)
  }

  async function save() {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      const updated = await Api.updateProfile(identity!, {
        nickname: draft.nickname,
        first_name: draft.first_name ?? null,
        last_name: draft.last_name ?? null,
        age: draft.age ?? null,
        gender: draft.gender || null,
        city: draft.city ?? null,
        country: draft.country ?? null,
        about: draft.about ?? null,
        homepage: draft.homepage ?? null,
        status_message: draft.status_message ?? null,
      })
      setInfo(updated)
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('profile.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="rcq-header sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link
            to={isSelf ? '/contacts' : '/contacts'}
            className="text-fg-secondary hover:text-fg-primary px-2"
          >
            ←
          </Link>
          <div className="font-semibold">
            {isSelf ? t('profile.title.self') : t('profile.title.peer')}
          </div>
          {isSelf && !editing && info && (
            <button
              onClick={startEdit}
              className="ml-auto px-3 h-9 text-sm font-semibold text-accent hover:text-accent-dim"
            >
              {t('profile.edit')}
            </button>
          )}
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

        {info && !editing && <ReadView info={info} t={t} isSelf={isSelf} navigate={navigate} crossIslandHost={crossIslandHost} />}
        {info && editing && draft && (
          <EditView
            draft={draft}
            setDraft={setDraft}
            saving={saving}
            onSave={save}
            onCancel={() => setEditing(false)}
            t={t}
          />
        )}
      </main>
    </div>
  )
}

// -----------------------------------------------------------
// Read view
// -----------------------------------------------------------

function ReadView({
  info,
  t,
  isSelf,
  navigate,
  crossIslandHost,
}: {
  info: UserInfo
  t: (k: string, p?: Record<string, string | number>) => string
  isSelf: boolean
  navigate: ReturnType<typeof useNavigate>
  crossIslandHost?: string | null
}) {
  // My own name for them. Device-only, and shown alongside what they call
  // themselves so a rename never hides who you are actually talking to.
  const { aliasFor, setAlias } = useContactAliases()
  const alias = aliasFor(info.uin)
  const [editingAlias, setEditingAlias] = useState<string | null>(null)
  const fullName = [info.first_name, info.last_name].filter(Boolean).join(' ')
  const location = [info.city, info.country].filter(Boolean).join(', ')

  return (
    <div className="space-y-4">
      <section className="bg-surface rounded-lg p-4 space-y-1">
        <div className="flex items-center gap-2">
          {/* Cross-island: presence doesn't cross islands → gray flower, and
              the picture lives on their island, so it stays a flower too. */}
          <PersonAvatar
            status={info.status}
            size={44}
            mediaId={info.avatar_media_id}
            mediaKey={info.avatar_media_key}
            crossIsland={!!crossIslandHost}
          />
          <div className="min-w-0">
            <div className="text-2xl font-bold truncate">{alias || info.nickname || `#${info.uin}`}</div>
            {alias && info.nickname && alias !== info.nickname && (
              <div className="text-xs text-fg-secondary truncate">
                {t('profile.their_name', { name: info.nickname })}
              </div>
            )}
          </div>
        </div>
        <div className="font-mono text-xs text-fg-dim">
          #{info.uin}{crossIslandHost ? ` · ${crossIslandHost}` : ''}
        </div>
        {info.status_message && (
          <div className="text-sm text-fg-secondary pt-1">{info.status_message}</div>
        )}
        {!isSelf && editingAlias === null && (
          <button
            type="button"
            onClick={() => setEditingAlias(alias ?? '')}
            className="text-xs text-accent hover:underline"
          >
            {alias ? t('profile.name.change') : t('profile.name.set')}
          </button>
        )}
        {!isSelf && editingAlias !== null && (
          <div className="flex flex-col gap-1 pt-1">
            <input
              value={editingAlias}
              onChange={(e) => setEditingAlias(e.target.value.slice(0, 48))}
              placeholder={info.nickname}
              className="h-9 rounded-md bg-field px-3 text-sm outline-none focus:ring-1 focus:ring-accent"
            />
            <div className="text-xs text-fg-dim">{t('profile.name.hint')}</div>
            <div className="flex gap-3 text-sm">
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => { setAlias(info.uin, editingAlias); setEditingAlias(null) }}
              >
                {t('common.save')}
              </button>
              {alias && (
                <button
                  type="button"
                  className="text-fg-secondary hover:underline"
                  onClick={() => { setAlias(info.uin, null); setEditingAlias(null) }}
                >
                  {t('profile.name.clear')}
                </button>
              )}
              <button type="button" className="text-fg-secondary hover:underline" onClick={() => setEditingAlias(null)}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
        {!isSelf && (
          <div className="mt-3">
            <button
              onClick={() => navigate(crossIslandHost ? `/chat/${info.uin}?i=${encodeURIComponent(crossIslandHost)}` : `/chat/${info.uin}`)}
              className="w-full h-10 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold transition-colors"
            >
              {t('profile.cta.send_message')}
            </button>
          </div>
        )}
      </section>

      {(fullName || info.age != null || info.gender) && (
        <Field title={t('profile.section.personal')}>
          {fullName && <Row k={t('profile.field.name')} v={fullName} />}
          {info.age != null && <Row k={t('profile.field.age')} v={String(info.age)} />}
          {info.gender && <Row k={t('profile.field.gender')} v={t(`profile.gender.${info.gender}`)} />}
        </Field>
      )}

      {location && (
        <Field title={t('profile.section.location')}>
          <Row k="" v={location} />
        </Field>
      )}

      {(info.about || info.homepage) && (
        <Field title={t('profile.section.about')}>
          {info.about && (
            <p className="text-sm text-fg-primary whitespace-pre-wrap">{info.about}</p>
          )}
          {info.homepage && (
            <a
              href={info.homepage}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-accent hover:underline break-all"
            >
              {info.homepage}
            </a>
          )}
        </Field>
      )}
    </div>
  )
}

function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-surface rounded-lg p-4 space-y-2">
      <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">{title}</div>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-fg-secondary">{k}</span>
      <span className="text-fg-primary text-right">{v}</span>
    </div>
  )
}

// -----------------------------------------------------------
// Edit view (own profile only)
// -----------------------------------------------------------

function EditView({
  draft,
  setDraft,
  saving,
  onSave,
  onCancel,
  t,
}: {
  draft: UserInfo
  setDraft: (d: UserInfo) => void
  saving: boolean
  onSave: () => void
  onCancel: () => void
  t: (k: string, p?: Record<string, string | number>) => string
}) {
  function patch<K extends keyof UserInfo>(key: K, value: UserInfo[K]) {
    setDraft({ ...draft, [key]: value })
  }
  const [picBusy, setPicBusy] = useState(false)
  const { identity } = useIdentity()
  // The blob is encrypted here and uploaded like any other image; the island
  // only ever stores ciphertext plus the key it hands to people allowed to see
  // it. Clearing sends two blank strings, which is how the island reads
  // "remove" (leaving the fields out means "do not touch").
  async function pickPicture(file: File | null) {
    if (!file || !identity) return
    setPicBusy(true)
    try {
      const up = await uploadEncryptedImage(identity.apiBase, file)
      if (up) {
        await Api.updateProfile(identity, { avatar_media_id: up.mediaId, avatar_media_key: up.keyB64 })
        setDraft({ ...draft, avatar_media_id: up.mediaId, avatar_media_key: up.keyB64 })
      }
    } finally {
      setPicBusy(false)
    }
  }
  async function clearPicture() {
    if (!identity) return
    setPicBusy(true)
    try {
      await Api.updateProfile(identity, { avatar_media_id: '', avatar_media_key: '' })
      setDraft({ ...draft, avatar_media_id: null, avatar_media_key: null })
    } finally {
      setPicBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <section className="bg-surface rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-3">
          <PersonAvatar
            status={draft.status}
            size={56}
            mediaId={draft.avatar_media_id}
            mediaKey={draft.avatar_media_key}
          />
          <div className="flex flex-col gap-1">
            <label className="text-sm text-accent cursor-pointer hover:underline">
              {draft.avatar_media_id ? t('profile.picture.change') : t('profile.picture.set')}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={picBusy}
                onChange={(e) => void pickPicture(e.target.files?.[0] ?? null)}
              />
            </label>
            {draft.avatar_media_id && (
              <button
                type="button"
                disabled={picBusy}
                onClick={() => void clearPicture()}
                className="text-xs text-fg-secondary hover:underline text-left"
              >
                {t('profile.picture.remove')}
              </button>
            )}
          </div>
        </div>
        <Input
          label={t('profile.field.nickname')}
          value={draft.nickname}
          onChange={(v) => patch('nickname', v)}
        />
        <Input
          label={t('profile.field.status_message')}
          value={draft.status_message ?? ''}
          onChange={(v) => patch('status_message', v)}
        />
      </section>

      <Field title={t('profile.section.personal')}>
        <Input
          label={t('profile.field.first_name')}
          value={draft.first_name ?? ''}
          onChange={(v) => patch('first_name', v)}
        />
        <Input
          label={t('profile.field.last_name')}
          value={draft.last_name ?? ''}
          onChange={(v) => patch('last_name', v)}
        />
        <Input
          label={t('profile.field.age')}
          value={draft.age != null ? String(draft.age) : ''}
          onChange={(v) => patch('age', v ? Number(v) : null)}
          type="number"
        />
        <SelectField
          label={t('profile.field.gender')}
          value={draft.gender ?? ''}
          onChange={(v) => patch('gender', v || null)}
          options={GENDER_OPTIONS.map((o) => ({ value: o.value, label: t(o.key) }))}
        />
      </Field>

      <Field title={t('profile.section.location')}>
        <Input
          label={t('profile.field.city')}
          value={draft.city ?? ''}
          onChange={(v) => patch('city', v)}
        />
        <Input
          label={t('profile.field.country')}
          value={draft.country ?? ''}
          onChange={(v) => patch('country', v)}
        />
      </Field>

      <Field title={t('profile.section.about')}>
        <TextareaField
          label={t('profile.field.about')}
          value={draft.about ?? ''}
          onChange={(v) => patch('about', v)}
        />
        <Input
          label={t('profile.field.homepage')}
          value={draft.homepage ?? ''}
          onChange={(v) => patch('homepage', v)}
        />
      </Field>

      <div className="flex items-center gap-2">
        <button
          onClick={onCancel}
          disabled={saving}
          className="flex-1 h-10 rounded-md bg-field text-sm font-medium hover:bg-line/50 disabled:opacity-40 transition-colors"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={onSave}
          disabled={saving || !draft.nickname.trim()}
          className="flex-1 h-10 rounded-md bg-accent hover:bg-accent-dim text-white text-sm font-semibold disabled:opacity-40 transition-colors"
        >
          {saving ? t('profile.saving') : t('profile.save')}
        </button>
      </div>
    </div>
  )
}

function Input({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-fg-secondary uppercase tracking-wide block">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-10 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
        spellCheck={false}
      />
    </div>
  )
}

function TextareaField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-fg-secondary uppercase tracking-wide block">
        {label}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="w-full px-3 py-2 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm resize-none"
      />
    </div>
  )
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-fg-secondary uppercase tracking-wide block">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-10 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
