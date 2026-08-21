/// Managing a group from the desktop. Until now there was none: web/desktop
/// group info was a read-only card with one destructive button, so an owner who
/// wanted to rename their own group, change its picture, edit the pinned
/// announcement or close it to new members had to pick up a phone. Founder:
/// "если я владелец группы, то у меня нет никаких настроек для управления,
/// надо один в один как в приложениях".
///
/// Section order is iOS's (photo, name, description, pinned text, then the
/// owner-only audience block), because that is the screen people already know.
/// The gates are the backend's own: `info` capability edits the first four,
/// only the OWNER decides who may post, whether the group is closed, and
/// whether the roster is hidden.

import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import { Api, type RCQGroup } from '../lib/api'
import type { WebIdentity } from '../lib/crypto'
import { useI18n } from '../lib/i18n-context'
import { uploadEncryptedImage } from '../lib/media'
import { GroupAvatar } from './GroupAvatar'

export function GroupSettingsModal({
  group,
  ident,
  gid,
  isOwner,
  onSaved,
  onClose,
}: {
  group: RCQGroup
  /// The identity to call WITH — a guest identity for a cross-island group.
  ident: WebIdentity
  /// The group's id ON ITS OWN island (never the local negative alias).
  gid: number
  isOwner: boolean
  onSaved: (g: RCQGroup) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState(group.name)
  const [description, setDescription] = useState(group.description ?? '')
  const [pinned, setPinned] = useState(group.pinned_text ?? '')
  const [ownerOnly, setOwnerOnly] = useState(group.post_policy === 'owner_only')
  const [closed, setClosed] = useState(!!group.is_closed)
  const [hidden, setHidden] = useState(!!group.members_hidden)
  // Content policy + slowmode (owner-only, like the three above). The
  // toggles read as restrictions — ON means "switched off in this room" —
  // while the wire carries the allowed-flags, hence the inversions.
  const [noLinks, setNoLinks] = useState(group.links_allowed === false)
  const [noFiles, setNoFiles] = useState(group.files_allowed === false)
  const [slowmode, setSlowmode] = useState(group.slowmode_sec ?? 0)
  const [busy, setBusy] = useState(false)
  const [picBusy, setPicBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const body: Parameters<typeof Api.patchGroup>[2] = {}
      if (name.trim() && name.trim() !== group.name) body.name = name.trim()
      if (description !== (group.description ?? '')) body.description = description
      if (pinned !== (group.pinned_text ?? '')) body.pinned_text = pinned
      if (isOwner) {
        if (ownerOnly !== (group.post_policy === 'owner_only')) {
          body.post_policy = ownerOnly ? 'owner_only' : 'all'
        }
        if (closed !== !!group.is_closed) body.is_closed = closed
        if (hidden !== !!group.members_hidden) body.members_hidden = hidden
        if (noLinks !== (group.links_allowed === false)) body.links_allowed = !noLinks
        if (noFiles !== (group.files_allowed === false)) body.files_allowed = !noFiles
        if (slowmode !== (group.slowmode_sec ?? 0)) body.slowmode_sec = slowmode
      }
      // Nothing changed: don't spend a round trip saying so.
      const updated = Object.keys(body).length ? await Api.patchGroup(ident, gid, body) : group
      onSaved(updated)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('group.settings.error'))
    } finally {
      setBusy(false)
    }
  }

  async function pickPicture(file: File | null) {
    if (!file) return
    setPicBusy(true)
    setError(null)
    try {
      const up = await uploadEncryptedImage(ident.apiBase, file)
      if (up) {
        onSaved(await Api.patchGroup(ident, gid, { avatar_media_id: up.mediaId, avatar_media_key: up.keyB64 }))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('group.settings.error'))
    } finally {
      setPicBusy(false)
    }
  }

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
          className="w-full max-w-md max-h-[85vh] flex flex-col rounded-t-xl sm:rounded-xl bg-surface shadow-lg overflow-hidden"
        >
          <header className="flex items-center justify-between gap-2 px-4 py-3">
            <span className="text-sm font-semibold">{t('group.settings.title')}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="text-fg-secondary hover:text-fg-primary px-1"
            >
              ✕
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
            {error && <div className="rounded-md bg-red-50 p-2 text-xs text-red-600">{error}</div>}

            <div className="flex items-center gap-3">
              <GroupAvatar size={56} mediaId={group.avatar_media_id} mediaKey={group.avatar_media_key} />
              <label className="text-sm text-accent cursor-pointer hover:underline">
                {group.avatar_media_id ? t('group.settings.picture.change') : t('group.settings.picture.set')}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={picBusy}
                  onChange={(e) => void pickPicture(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>

            <Field label={t('group.settings.name')}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 64))}
                className="w-full h-10 rounded-md bg-field px-3 text-sm outline-none focus:ring-1 focus:ring-accent"
              />
            </Field>

            <Field label={t('group.settings.description')}>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, 500))}
                rows={2}
                className="w-full rounded-md bg-field px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent resize-none"
              />
            </Field>

            <Field label={t('chat.pin.title')}>
              <textarea
                value={pinned}
                onChange={(e) => setPinned(e.target.value.slice(0, 2000))}
                rows={3}
                className="w-full rounded-md bg-field px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent resize-none"
              />
            </Field>

            {isOwner && (
              <div className="space-y-1 pt-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-fg-secondary">
                  {t('group.settings.audience')}
                </div>
                <Toggle
                  label={t('group.settings.owner_only')}
                  hint={t('group.settings.owner_only.hint')}
                  on={ownerOnly}
                  onChange={setOwnerOnly}
                />
                <Toggle
                  label={t('group.settings.closed')}
                  hint={t('group.settings.closed.hint')}
                  on={closed}
                  onChange={setClosed}
                />
                <Toggle
                  label={t('group.settings.hide_members')}
                  hint={t('group.settings.hide_members.hint')}
                  on={hidden}
                  onChange={setHidden}
                />
                <Toggle
                  label={t('group.settings.no_links')}
                  hint={t('group.settings.no_links.hint')}
                  on={noLinks}
                  onChange={setNoLinks}
                />
                <Toggle
                  label={t('group.settings.no_files')}
                  hint={t('group.settings.no_files.hint')}
                  on={noFiles}
                  onChange={setNoFiles}
                />
                <div className="px-1 py-2">
                  <span className="block text-sm">{t('group.settings.slowmode')}</span>
                  <span className="block text-xs text-fg-dim">{t('group.settings.slowmode.hint')}</span>
                  <div className="mt-2 flex gap-1.5">
                    {[0, 5, 10, 30, 60].map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSlowmode(s)}
                        className={`flex-1 h-8 rounded-md text-xs font-medium transition-colors ${
                          slowmode === s
                            ? 'bg-accent text-white'
                            : 'bg-field text-fg-secondary hover:bg-line/50'
                        }`}
                      >
                        {s === 0
                          ? t('group.settings.slowmode.off')
                          : s < 60
                            ? t('group.settings.slowmode.sec', { s: String(s) })
                            : t('group.settings.slowmode.min')}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 px-4 pb-4">
            <button
              onClick={onClose}
              disabled={busy}
              className="flex-1 h-10 rounded-md bg-field text-sm font-medium hover:bg-line/50 disabled:opacity-40 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => void save()}
              disabled={busy || !name.trim()}
              className="flex-1 h-10 rounded-md bg-accent text-sm font-semibold text-white hover:bg-accent-dim disabled:opacity-40 transition-colors"
            >
              {busy ? t('profile.saving') : t('common.save')}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-semibold uppercase tracking-wide text-fg-secondary">
        {label}
      </label>
      {children}
    </div>
  )
}

function Toggle({
  label,
  hint,
  on,
  onChange,
}: {
  label: string
  hint: string
  on: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="w-full flex items-start gap-3 rounded-md px-1 py-2 text-left hover:bg-field/60 transition-colors"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-fg-dim">{hint}</span>
      </span>
      <span
        className={`mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-line'}`}
      >
        <span
          className={`block h-4 w-4 rounded-full bg-surface transition-transform mt-0.5 ${on ? 'translate-x-[1.125rem]' : 'translate-x-0.5'}`}
        />
      </span>
    </button>
  )
}
