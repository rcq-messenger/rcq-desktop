// Settings — profile link, language picker, privacy navigation,
// sound on/off, sign out, burn account.
//
// Privacy is its own page (`/privacy`) — five tri-state pickers
// took up too much vertical space inline. Settings now just shows
// a nav-row that opens the dedicated surface.

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { currentRecoveryPhrase } from '../lib/auth'
import { exportBackup, importBackup } from '../lib/backup-data'
import { Dropdown, type DropdownOption } from '../components/Dropdown'
import { LanguagePicker } from '../components/LanguagePicker'
import { Logo } from '../components/Logo'
import { MyQRCode } from '../components/MyQRCode'
import { Api } from '../lib/api'
import {
  appVersion,
  bypassStatus,
  checkForUpdatesNow,
  desktopPlatform,
  isTauri,
  relaunchApp,
  setBypassEnabled,
  type BypassStatus,
  addUserRelay,
  removeUserRelay,
  userRelays,
  type UserRelay,
  relayKeyStatus,
  setRelayKey,
  type RelayKeyStatus,
} from '../lib/desktop'
import { uploadReportAttachment } from '../lib/media'
import { useI18n } from '../lib/i18n-context'
import type { UserInfo } from '../lib/api'
import { DEFAULT_API_BASE } from '../lib/auth'
import { snapshotFor } from '../lib/contacts-cache'
import { PersonAvatar } from '../components/PersonAvatar'
import { useIdentity } from '../lib/identity-context'
import { isPresenceSoundEnabled, isSoundEnabled, setPresenceSoundEnabled, setSoundEnabled } from '../lib/sounds'
import { useTheme, type ThemePref } from '../lib/theme-context'
import {
  addBackupIsland,
  disableAutoBackup,
  enableAutoBackup,
  listBackupHomes,
  removeBackupIsland,
  promoteBackupToPrimary,
  type BackupHome,
} from '../lib/multihome'
import { publishHomeIslandRecord } from '../lib/federation-publish'
import { pushHomeRecordToContacts } from '../lib/federation-gossip'

export function Settings() {
  const { identity, accounts, switchAccount, addAccount, signOutAccount, signOut } = useIdentity()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [burnTyped, setBurnTyped] = useState('')
  const [burning, setBurning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [soundOn, setSoundOnState] = useState<boolean>(() => isSoundEnabled())
  const [presenceSoundOn, setPresenceSoundOnState] = useState<boolean>(() => isPresenceSoundEnabled())
  const { pref: themePref, setPref: setThemePref } = useTheme()
  const [backups, setBackups] = useState<BackupHome[]>(() => listBackupHomes())
  const [mhAdding, setMhAdding] = useState(false)
  const [mhHost, setMhHost] = useState('')
  const [mhBusy, setMhBusy] = useState(false)
  const [mhError, setMhError] = useState<string | null>(null)
  const [mhAutoBusy, setMhAutoBusy] = useState(false)
  // The manual block starts open only when a manually-added island exists
  // (self-hosters); everyone else sees just the toggle.
  const [mhAdvanced, setMhAdvanced] = useState(() => listBackupHomes().some((h) => !h.auto))
  const [reportText, setReportText] = useState('')
  const [reportBusy, setReportBusy] = useState(false)
  const [reportSent, setReportSent] = useState(false)
  // Bug-report attachments (#28): up to 3 picked photos/videos, uploaded on send.
  const [reportFiles, setReportFiles] = useState<File[]>([])
  const [reportError, setReportError] = useState<string | null>(null)
  const [hofOptIn, setHofOptIn] = useState(false)
  const [hofAvatar, setHofAvatar] = useState<string | null>(null)
  const [hofBusy, setHofBusy] = useState(false)
  const [hofError, setHofError] = useState<string | null>(null)
  // Desktop only: installed version + on-demand update check. The launch check
  // fires once, so someone who leaves the app open for weeks needs a button.
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateNote, setUpdateNote] = useState<string | null>(null)
  // Desktop only: the bundled sing-box. `bypass` null off desktop.
  const [bypass, setBypass] = useState<BypassStatus | null>(null)
  // 'macos' | 'windows' | 'linux', null in a browser — About names the build.
  const [platform, setPlatform] = useState<string | null>(null)
  const [me, setMe] = useState<UserInfo | null>(null)

  // Seed the HoF toggle + avatar from the server (owner-self echoes both).
  useEffect(() => {
    if (!identity) return
    let alive = true
    void Api.myInfo(identity)
      .then((info) => {
        if (!alive) return
        setHofOptIn(!!info.hof_opt_in)
        setHofAvatar(info.hof_avatar ?? null)
        // The accounts row draws the face and the name from this. A brand-new
        // account has no persisted roster snapshot yet, so without it the row
        // for the account you are signed into showed a blank flower and a bare
        // number — while its profile sat two sections above.
        setMe(info)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [identity])

  useEffect(() => {
    void appVersion().then(setDesktopVersion)
    void bypassStatus().then(setBypass)
    void desktopPlatform().then(setPlatform)
  }, [])

  const [relays, setRelays] = useState<UserRelay[]>([])
  const [relayToken, setRelayToken] = useState('')
  const [relayError, setRelayError] = useState<string | null>(null)

  useEffect(() => {
    void userRelays().then(setRelays)
  }, [])

  const [keyStatus, setKeyStatus] = useState<RelayKeyStatus | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void relayKeyStatus().then(setKeyStatus)
  }, [])

  async function saveKey() {
    const key = keyInput.trim()
    if (!key) return
    setKeyBusy(true)
    setKeyMsg(null)
    const res = await setRelayKey(key)
    setKeyBusy(false)
    // Four outcomes, and they are not interchangeable. Telling somebody their
    // key is wrong when the question never reached the broker is the answer
    // that costs an evening.
    if (res.verdict === 'ok') {
      setKeyInput('')
      setKeyMsg({ ok: true, text: t('settings.bypass.key_ok', { count: res.private_count }) })
    } else if (res.verdict === 'expired') {
      setKeyMsg({ ok: false, text: t('settings.bypass.key_expired') })
    } else if (res.verdict === 'offline') {
      setKeyMsg({ ok: false, text: t('settings.bypass.key_offline') })
    } else {
      setKeyMsg({ ok: false, text: t('settings.bypass.key_unknown') })
    }
    setKeyStatus(await relayKeyStatus())
  }

  async function clearKey() {
    setKeyBusy(true)
    await setRelayKey(null)
    setKeyBusy(false)
    setKeyMsg(null)
    setKeyStatus(await relayKeyStatus())
  }

  async function addRelay() {
    const token = relayToken.trim()
    if (!token) return
    const res = await addUserRelay(token)
    if (!res.ok) {
      setRelayError(t('settings.bypass.relay_bad'))
      return
    }
    setRelayError(null)
    setRelayToken('')
    setRelays(await userRelays())
  }

  async function dropRelay(tag: string) {
    await removeUserRelay(tag)
    setRelays(await userRelays())
  }

  async function toggleBypass(enabled: boolean) {
    if (!(await setBypassEnabled(enabled))) return
    setBypass((s) => (s ? { ...s, enabled, auto: false } : s))
  }

  async function runUpdateCheck() {
    setUpdateBusy(true)
    setUpdateNote(null)
    const outcome = await checkForUpdatesNow(t)
    setUpdateBusy(false)
    if (outcome === 'current') setUpdateNote(t('settings.about.update_current'))
    else if (outcome === 'failed') setUpdateNote(t('settings.about.update_failed'))
  }

  if (!identity) {
    navigate('/', { replace: true })
    return null
  }

  /// Server caps at ~256KB; reject larger client-side with a clear message
  /// rather than a 400. Animated GIFs are kept as-is (the wall animates them).
  const HOF_MAX_BYTES = 256 * 1024

  async function setHof(on: boolean) {
    setHofBusy(true)
    setHofError(null)
    setHofOptIn(on) // optimistic
    try {
      await Api.updateProfile(identity!, { hof_opt_in: on })
    } catch {
      setHofOptIn(!on)
      setHofError(t('settings.hof.error'))
    } finally {
      setHofBusy(false)
    }
  }

  async function setHofAvatarUpload(dataUri: string) {
    setHofBusy(true)
    setHofError(null)
    try {
      await Api.updateProfile(identity!, { hof_avatar: dataUri })
      setHofAvatar(dataUri || null)
    } catch {
      setHofError(t('settings.hof.error'))
    } finally {
      setHofBusy(false)
    }
  }

  async function pickHofImage(file: File | null) {
    if (!file) return
    if (file.size > HOF_MAX_BYTES) {
      setHofError(t('settings.hof.too_large'))
      return
    }
    const dataUri = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(file)
    }).catch(() => null)
    if (!dataUri) {
      setHofError(t('settings.hof.error'))
      return
    }
    await setHofAvatarUpload(dataUri)
  }

  async function submitReport() {
    setReportBusy(true)
    setReportError(null)
    try {
      const atts = (await Promise.all(
        reportFiles.map((f) => uploadReportAttachment(identity!.apiBase, f)),
      )).filter((a): a is NonNullable<typeof a> => a != null)
      await Api.sendReport(identity!, reportText.trim(), atts)
      setReportSent(true)
      setReportText('')
      setReportFiles([])
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      // 429 = the server's 5/hr per-uin rate limit on the reports channel.
      setReportError(
        msg.includes('429') ? t('settings.report.rate_limited') : t('settings.report.error'),
      )
    } finally {
      setReportBusy(false)
    }
  }

  async function addBackup() {
    setMhBusy(true)
    setMhError(null)
    try {
      await addBackupIsland(identity!, mhHost)
      setBackups(listBackupHomes())
      setMhHost('')
      setMhAdding(false)
      // Senders learn the new home from the republished signed record (PUT to
      // islands) AND from a direct self-push to every contact (gossip B1) — so
      // contacts know the new home even if this island later dies.
      void publishHomeIslandRecord(identity!)
      void pushHomeRecordToContacts(identity!)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      const known: Record<string, string> = {
        'invalid host': 'settings.multihome.error.invalid',
        'primary island': 'settings.multihome.error.primary',
        'already added': 'settings.multihome.error.already',
      }
      setMhError(known[msg] ? t(known[msg]) : `${t('settings.multihome.error.generic')}${msg ? ` (${msg})` : ''}`)
    } finally {
      setMhBusy(false)
    }
  }

  function removeBackup(host: string) {
    removeBackupIsland(host)
    setBackups(listBackupHomes())
    void publishHomeIslandRecord(identity!)
    void pushHomeRecordToContacts(identity!)
  }

  // Make a backup island the new primary (one-tap DR for a dead primary). The
  // promote refreshes the target token first and aborts if it's unreachable, so
  // a failed promote never strands you. On success we republish the record with
  // the new order and reload so the whole app re-inits against the new primary.
  const [promoteBusy, setPromoteBusy] = useState<string | null>(null)
  async function makePrimary(host: string) {
    if (!window.confirm(t('settings.multihome.promote_confirm', { host }))) return
    setPromoteBusy(host)
    setMhError(null)
    try {
      const next = await promoteBackupToPrimary(identity!, host)
      await publishHomeIslandRecord(next)
      // Push the new primary order to contacts BEFORE the reload tears the
      // session down (best-effort; contacts also re-resolve via the mirror).
      await pushHomeRecordToContacts(next)
      window.location.reload()
    } catch (e) {
      const msg = String((e as Error).message || e)
      const known: Record<string, string> = {
        'target island unreachable': 'settings.multihome.promote_unreachable',
      }
      setMhError(known[msg] ? t(known[msg]) : `${t('settings.multihome.error.generic')}${msg ? ` (${msg})` : ''}`)
      setPromoteBusy(null)
    }
  }

  // The toggle: ON auto-picks a healthy catalogue island and registers there;
  // OFF disconnects the auto-picked island(s). Manual islands are untouched.
  async function toggleAutoBackup(on: boolean) {
    setMhAutoBusy(true)
    setMhError(null)
    try {
      if (on) {
        await enableAutoBackup(identity!)
      } else {
        disableAutoBackup()
      }
      setBackups(listBackupHomes())
      // Senders learn the new home set from the republished signed record + the
      // direct self-push to contacts.
      void publishHomeIslandRecord(identity!)
      void pushHomeRecordToContacts(identity!)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      setMhError(
        msg === 'no island'
          ? t('settings.multihome.error.none')
          : `${t('settings.multihome.error.generic')}${msg ? ` (${msg})` : ''}`,
      )
    } finally {
      setMhAutoBusy(false)
    }
  }

  async function burn() {
    setBurning(true)
    setError(null)
    try {
      await Api.burnAccount(identity!)
      signOut()
      navigate('/', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.danger.error'))
    } finally {
      setBurning(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="sticky top-0 bg-surface z-10">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to="/contacts" className="text-fg-secondary hover:text-fg-primary px-2">
            ←
          </Link>
          <div className="font-semibold">{t('settings.title')}</div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        <Link
          to="/profile"
          className="block bg-surface rounded-lg p-4 hover:bg-field transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
                {t('settings.section.profile')}
              </div>
              <div className="text-sm font-medium mt-0.5 truncate">
                {t('settings.profile.cta')}
              </div>
            </div>
            <span className="text-fg-dim">→</span>
          </div>
        </Link>

        {/* Accounts. A browser could only ever hold one, so there was no way to
            keep a second number here or to move between them without signing
            out — the phones have had both for as long as they have existed.
            Each row shows that account's own name and face, read from its own
            stored snapshot: nothing is fetched to draw this. */}
        <section className="bg-surface rounded-lg overflow-hidden">
          <div className="px-4 pt-4 pb-2 text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.accounts')}
          </div>
          <ul>
            {accounts.map((a) => {
              const isActive = a.uin === identity?.uin
              // The active account's own profile is already loaded on this
              // screen; the others come from the snapshot each one persisted.
              const who = isActive ? me ?? snapshotFor(a.uin)?.me : snapshotFor(a.uin)?.me
              const name = who?.nickname || `#${a.uin}`
              return (
                <li key={a.uin} className="flex items-center gap-3 px-4 py-2.5 hover:bg-field transition-colors">
                  <button
                    type="button"
                    onClick={() => switchAccount(a.uin)}
                    disabled={isActive}
                    className="flex items-center gap-3 flex-1 min-w-0 text-left disabled:cursor-default"
                  >
                    <PersonAvatar
                      status={who?.status ?? 'offline'}
                      size={32}
                      mediaId={who?.avatar_media_id}
                      mediaKey={who?.avatar_media_key}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate">{name}</span>
                      <span className="block font-mono text-xs text-fg-dim truncate">
                        #{a.uin}
                        {/* The island, but only when it is not the usual one: a
                            host on every row is noise for the people who never
                            leave the flagship, which is most of them. */}
                        {a.apiBase !== DEFAULT_API_BASE && ` · ${a.apiBase.replace(/^https?:\/\//, '')}`}
                      </span>
                    </span>
                    {isActive && <span className="flex-none text-accent text-sm">✓</span>}
                  </button>
                  {accounts.length > 1 && (
                    <button
                      type="button"
                      onClick={() => signOutAccount(a.uin)}
                      title={t('settings.accounts.forget')}
                      aria-label={t('settings.accounts.forget')}
                      className="flex-none h-8 w-8 rounded-full text-fg-dim hover:text-red-500 hover:bg-field transition-colors"
                    >
                      ×
                    </button>
                  )}
                </li>
              )
            })}
            <li>
              <button
                type="button"
                onClick={addAccount}
                className="flex items-center gap-3 w-full px-4 py-2.5 hover:bg-field transition-colors text-left"
              >
                <span className="h-8 w-8 rounded-full bg-field text-accent flex items-center justify-center text-lg leading-none">
                  +
                </span>
                <span className="text-sm font-medium">{t('settings.accounts.add')}</span>
              </button>
            </li>
          </ul>
        </section>

        <section className="bg-surface rounded-lg p-4 space-y-2">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.account')}
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-fg-secondary">{t('settings.field.uin')}</span>
            <span className="font-mono">#{identity.uin}</span>
          </div>
        </section>

        <RecoveryPhraseSection />

        <BackupSection />

        <Link
          to="/market"
          className="block bg-surface rounded-lg p-4 hover:bg-surface-dim transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
                {t('uin_market.title')}
              </div>
              <div className="text-xs text-fg-dim mt-0.5 truncate">{t('uin_market.settings.row')}</div>
            </div>
            <span className="text-fg-dim">→</span>
          </div>
        </Link>

        <section className="bg-surface rounded-lg p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.qr')}
          </div>
          <MyQRCode />
        </section>

        {/* Multihoming (federation v1): this account also registered on a
            second island, messages get deposited into both mailboxes. */}
        <section className="bg-surface rounded-lg p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.multihome')}
          </div>
          <p className="text-xs text-fg-secondary">{t('settings.multihome.body')}</p>

          {/* One toggle for normal users: the island comes from the catalogue. */}
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm pr-3">{t('settings.multihome.auto_label')}</span>
            <input
              type="checkbox"
              checked={backups.some((h) => h.auto)}
              disabled={mhAutoBusy}
              onChange={(e) => void toggleAutoBackup(e.target.checked)}
              className="w-5 h-5 accent-accent cursor-pointer shrink-0"
            />
          </label>
          {mhAutoBusy && (
            <div className="text-xs text-fg-dim">{t('settings.multihome.auto_busy')}</div>
          )}
          {backups
            .filter((h) => h.auto)
            .map((h) => (
              <div key={h.host} className="text-sm">
                <div className="font-mono truncate">{h.host}</div>
                <div className="text-xs text-fg-dim">
                  {t('settings.multihome.row_uin', { uin: h.uin })}
                </div>
              </div>
            ))}
          <p className="text-xs text-fg-dim">{t('settings.multihome.auto_sub')}</p>

          {/* Manual host entry stays for self-hosters, tucked away. */}
          <button
            onClick={() => setMhAdvanced(!mhAdvanced)}
            className="block text-left text-xs text-fg-secondary hover:text-fg-primary transition-colors"
          >
            {mhAdvanced ? '▾' : '▸'} {t('settings.multihome.advanced')}
          </button>
          {mhAdvanced && (
            <>
              {backups
                .filter((h) => !h.auto)
                .map((h) => (
                  <div key={h.host} className="flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <div className="font-mono truncate">{h.host}</div>
                      <div className="text-xs text-fg-dim">
                        {t('settings.multihome.row_uin', { uin: h.uin })}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        onClick={() => makePrimary(h.host)}
                        disabled={promoteBusy != null}
                        className="h-8 px-3 rounded-md bg-field text-xs font-medium text-fg-secondary hover:bg-line/50 transition-colors disabled:opacity-50"
                      >
                        {promoteBusy === h.host ? t('settings.multihome.promoting') : t('settings.multihome.make_primary')}
                      </button>
                      <button
                        onClick={() => removeBackup(h.host)}
                        disabled={promoteBusy != null}
                        className="h-8 px-3 rounded-md bg-field text-xs font-medium text-fg-secondary hover:bg-line/50 transition-colors disabled:opacity-50"
                      >
                        {t('settings.multihome.remove')}
                      </button>
                    </div>
                  </div>
                ))}
              {!mhAdding ? (
                <button
                  onClick={() => setMhAdding(true)}
                  className="w-full h-10 rounded-md bg-field text-sm font-medium hover:bg-line/50 transition-colors"
                >
                  {t('settings.multihome.add')}
                </button>
              ) : (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={mhHost}
                    onChange={(e) => setMhHost(e.target.value)}
                    placeholder={t('settings.multihome.placeholder')}
                    className="w-full h-10 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm font-mono"
                    autoFocus
                    disabled={mhBusy}
                  />
                  <button
                    onClick={() => void addBackup()}
                    disabled={mhBusy || !mhHost.trim()}
                    className="w-full h-10 rounded-md bg-accent hover:opacity-90 text-white text-sm font-semibold disabled:opacity-40 transition-colors"
                  >
                    {mhBusy ? t('settings.multihome.busy') : t('settings.multihome.confirm')}
                  </button>
                  <button
                    onClick={() => {
                      setMhAdding(false)
                      setMhHost('')
                      setMhError(null)
                    }}
                    disabled={mhBusy}
                    className="w-full h-9 text-sm text-fg-secondary hover:text-fg-primary"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              )}
            </>
          )}
          {mhError && (
            <div className="text-sm text-red-600 bg-red-500/5 rounded-md p-2">{mhError}</div>
          )}
          <p className="text-xs text-fg-dim">{t('settings.multihome.footer')}</p>
        </section>

        {/* Privacy — its own page now that there are five pickers.
            See pages/Privacy.tsx for the actual surface. */}
        <Link
          to="/privacy"
          className="block bg-surface rounded-lg p-4 hover:bg-surface-dim transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
                {t('settings.section.privacy')}
              </div>
              <div className="text-xs text-fg-dim mt-0.5 truncate">
                {t('settings.privacy.footer.short')}
              </div>
            </div>
            <span className="text-fg-dim">→</span>
          </div>
        </Link>

        <section className="bg-surface rounded-lg p-4 space-y-2">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.language')}
          </div>
          <LanguagePicker variant="row" />
          <p className="text-xs text-fg-dim">{t('settings.language.footer')}</p>
        </section>

        <section className="bg-surface rounded-lg p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.theme')}
          </div>
          <Dropdown<ThemePref>
            value={themePref}
            options={(['light', 'dark', 'system'] as ThemePref[]).map<DropdownOption<ThemePref>>((opt) => ({
              value: opt,
              label: t(`settings.theme.${opt}`),
            }))}
            onChange={setThemePref}
            ariaLabel={t('settings.section.theme')}
            variant="row"
          />
          <p className="text-xs text-fg-dim">{t('settings.theme.footer')}</p>
        </section>

        <section className="bg-surface rounded-lg p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.sound')}
          </div>
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm">{t('settings.sound.toggle')}</span>
            <input
              type="checkbox"
              checked={soundOn}
              onChange={(e) => {
                setSoundEnabled(e.target.checked)
                setSoundOnState(e.target.checked)
              }}
              className="w-5 h-5 accent-accent cursor-pointer"
            />
          </label>
          <p className="text-xs text-fg-dim">{t('settings.sound.footer')}</p>
          {/* Separate toggle for contact online/offline chimes, like iOS.
              Greyed out when the master switch is off. */}
          <label className={'flex items-center justify-between pt-1 ' + (soundOn ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed')}>
            <span className="text-sm">{t('settings.sound.presence')}</span>
            <input
              type="checkbox"
              checked={presenceSoundOn}
              disabled={!soundOn}
              onChange={(e) => {
                setPresenceSoundEnabled(e.target.checked)
                setPresenceSoundOnState(e.target.checked)
              }}
              className="w-5 h-5 accent-accent cursor-pointer"
            />
          </label>
          <p className="text-xs text-fg-dim">{t('settings.sound.presence_footer')}</p>
        </section>

        {/* Hall of Fame opt-in + optional avatar (federation-independent;
            same PUT /users/me as the mobile clients). */}
        <section className="bg-surface rounded-lg p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.hof')}
          </div>
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm pr-3">{t('settings.hof.toggle')}</span>
            <input
              type="checkbox"
              checked={hofOptIn}
              disabled={hofBusy}
              onChange={(e) => void setHof(e.target.checked)}
              className="w-5 h-5 accent-accent cursor-pointer shrink-0"
            />
          </label>
          {hofOptIn && (
            <div className="flex items-center gap-3 pt-1">
              <div className="w-12 h-12 rounded-full overflow-hidden bg-accent/10 shrink-0 flex items-center justify-center">
                {hofAvatar ? (
                  <img src={hofAvatar} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-lg font-semibold text-accent">
                    {identity.uin.toString().slice(0, 1)}
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-accent cursor-pointer hover:underline">
                  {hofAvatar ? t('settings.hof.change_image') : t('settings.hof.add_image')}
                  <input
                    type="file"
                    accept="image/gif,image/png,image/jpeg,image/webp"
                    className="hidden"
                    disabled={hofBusy}
                    onChange={(e) => void pickHofImage(e.target.files?.[0] ?? null)}
                  />
                </label>
                {hofAvatar && (
                  <button
                    onClick={() => void setHofAvatarUpload('')}
                    disabled={hofBusy}
                    className="text-xs text-fg-dim hover:text-fg-primary text-left"
                  >
                    {t('settings.hof.remove_image')}
                  </button>
                )}
              </div>
            </div>
          )}
          {hofError && <div className="text-sm text-red-600 bg-red-500/5 rounded-md p-2">{hofError}</div>}
          <p className="text-xs text-fg-dim">{t('settings.hof.footer')}</p>
        </section>

        {/* Report a problem — same /reports channel the mobile clients use. */}
        <section className="bg-surface rounded-lg p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.report')}
          </div>
          <p className="text-xs text-fg-secondary">{t('settings.report.body')}</p>
          {reportSent ? (
            <div className="text-sm text-accent bg-accent/5 rounded-md p-2">
              {t('settings.report.sent')}
            </div>
          ) : (
            <>
              <textarea
                value={reportText}
                onChange={(e) => setReportText(e.target.value)}
                placeholder={t('settings.report.placeholder')}
                rows={4}
                maxLength={1000}
                disabled={reportBusy}
                className="w-full px-3 py-2 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm resize-y"
              />
              <div className="flex items-center gap-2 flex-wrap">
                {reportFiles.map((f, i) => (
                  <div key={i} className="relative">
                    {f.type.startsWith('image/') ? (
                      <img src={URL.createObjectURL(f)} alt="" className="w-12 h-12 rounded-md object-cover" />
                    ) : (
                      <div className="w-12 h-12 rounded-md bg-field flex items-center justify-center text-fg-secondary text-xs">▶</div>
                    )}
                    <button
                      onClick={() => setReportFiles(reportFiles.filter((_, j) => j !== i))}
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/60 text-white text-[10px] leading-none"
                    >×</button>
                  </div>
                ))}
                {reportFiles.length < 3 && !reportBusy && (
                  <label className="w-12 h-12 rounded-md bg-field flex items-center justify-center text-accent text-xl cursor-pointer hover:bg-accent/5">
                    +
                    <input
                      type="file"
                      accept="image/*,video/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) setReportFiles((prev) => [...prev, f].slice(0, 3))
                        e.target.value = ''
                      }}
                    />
                  </label>
                )}
              </div>
              <button
                onClick={() => void submitReport()}
                disabled={reportBusy || !reportText.trim()}
                className="w-full h-10 rounded-md bg-accent hover:opacity-90 text-white text-sm font-semibold disabled:opacity-40 transition-colors"
              >
                {reportBusy ? t('settings.report.busy') : t('settings.report.send')}
              </button>
            </>
          )}
          {reportError && (
            <div className="text-sm text-red-600 bg-red-500/5 rounded-md p-2">{reportError}</div>
          )}
        </section>

        {/* Desktop only: the bundled sing-box. The webview proxy is fixed when
            the webview is built, so flipping this needs a restart. */}
        {bypass && (
          <section className="bg-surface rounded-lg p-4 space-y-3">
            <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
              {t('settings.section.bypass')}
            </div>
            <label
              className={
                'flex items-center justify-between ' +
                (bypass.supported ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed')
              }
            >
              <span className="text-sm pr-3">{t('settings.bypass.toggle')}</span>
              <input
                type="checkbox"
                checked={bypass.enabled || bypass.auto}
                disabled={!bypass.supported}
                onChange={(e) => void toggleBypass(e.target.checked)}
                className="w-5 h-5 accent-accent cursor-pointer"
              />
            </label>
            <p className="text-xs text-fg-dim">{t('settings.bypass.footer')}</p>
            {!bypass.supported && (
              <p className="text-xs text-fg-dim">{t('settings.bypass.unsupported')}</p>
            )}
            {bypass.auto && <p className="text-xs text-fg-dim">{t('bypass.auto_note')}</p>}
            {bypass.supported && (bypass.enabled || bypass.auto) !== bypass.running && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-fg-dim">
                  {bypass.enabled && bypass.tried_at_startup
                    ? t('settings.bypass.failed')
                    : t('settings.bypass.restart_note')}
                </p>
                <button
                  onClick={() => void relaunchApp()}
                  className="shrink-0 h-8 px-3 rounded-md bg-field text-xs font-medium hover:bg-line/50 transition-colors"
                >
                  {t('settings.bypass.restart_now')}
                </button>
              </div>
            )}
            {bypass.running && (
              <p className="text-xs text-fg-dim">
                {t('settings.bypass.running', { count: bypass.relay_count })}
                {bypass.relay_config_version != null &&
                  ` · ${t('settings.bypass.list_version', { version: bypass.relay_config_version })}`}
              </p>
            )}
            {/* A paid tenancy's access key. No prices and no purchase here on
                purpose: this is the field, the buying happens on the site. */}
            <div className="pt-1 space-y-2">
              <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
                {t('settings.bypass.key_title')}
              </div>
              <p className="text-xs text-fg-dim">{t('settings.bypass.key_hint')}</p>
              {keyStatus?.present ? (
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-fg-secondary">
                    {t('settings.bypass.key_present', { count: keyStatus.private_count })}
                  </span>
                  <button
                    onClick={() => void clearKey()}
                    disabled={keyBusy}
                    className="shrink-0 text-fg-dim hover:text-red-500 transition-colors disabled:opacity-40"
                  >
                    {t('settings.bypass.key_remove')}
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveKey()
                    }}
                    placeholder={t('settings.bypass.key_placeholder')}
                    spellCheck={false}
                    className="flex-1 min-w-0 h-9 px-3 rounded-md bg-field text-sm font-mono"
                  />
                  <button
                    onClick={() => void saveKey()}
                    disabled={keyBusy || !keyInput.trim()}
                    className="shrink-0 h-9 px-3 rounded-md bg-field text-xs font-medium hover:bg-line/50 transition-colors disabled:opacity-40"
                  >
                    {keyBusy ? t('settings.bypass.key_checking') : t('common.save')}
                  </button>
                </div>
              )}
              {keyMsg && (
                <p className={`text-xs ${keyMsg.ok ? 'text-fg-secondary' : 'text-red-500'}`}>
                  {keyMsg.text}
                </p>
              )}
            </div>
                        {/* Hand-added bridges. The signed list and the broker both arrive
                over names a censor can enumerate, so when those are gone this
                is the only way left to point the app at something that works —
                a token pasted from a chat, a note, or read aloud. */}
            <div className="pt-1 space-y-2">
              <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
                {t('settings.bypass.relay_add')}
              </div>
              <div className="flex gap-2">
                <input
                  value={relayToken}
                  onChange={(e) => setRelayToken(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addRelay()
                  }}
                  placeholder="rcq-relay://…"
                  spellCheck={false}
                  className="flex-1 min-w-0 h-9 px-3 rounded-md bg-field text-sm font-mono"
                />
                <button
                  onClick={() => void addRelay()}
                  disabled={!relayToken.trim()}
                  className="shrink-0 h-9 px-3 rounded-md bg-field text-xs font-medium hover:bg-line/50 transition-colors disabled:opacity-40"
                >
                  {t('common.save')}
                </button>
              </div>
              {relayError && <p className="text-xs text-red-500">{relayError}</p>}
              {relays.length > 0 && (
                <ul className="space-y-1">
                  {relays.map((r) => (
                    <li key={r.tag} className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-mono text-fg-secondary truncate">
                        {r.server}:{r.port} · {r.proto}
                      </span>
                      <button
                        onClick={() => void dropRelay(r.tag)}
                        className="shrink-0 text-fg-dim hover:text-red-500 transition-colors"
                      >
                        {t('settings.bypass.relay_remove')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-fg-dim">{t('settings.bypass.relay_note')}</p>
            </div>

            <Link
              to="/diagnostics"
              className="block text-xs font-medium text-accent hover:underline"
            >
              {t('diag.title')}
            </Link>
          </section>
        )}

        <section className="bg-surface rounded-lg p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.about')}
          </div>
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{t('brand.name')}</div>
              <div className="text-xs text-fg-dim">{t('login.tagline')}</div>
            </div>
            {/* The version belongs next to the name, where every app puts it.
                It was already on this screen, one row further down and only
                after the eye had passed the blurb, and a tester asked outright
                where to see which version was installed. */}
            {isTauri() && (
              <span className="font-mono text-xs text-fg-secondary shrink-0">
                {desktopVersion ?? '…'}
              </span>
            )}
          </div>
          {/* The desktop is not the web client and shouldn't say it is; each
              build names its own OS. */}
          <p className="text-xs text-fg-secondary leading-relaxed">
            {t(platform ? `settings.about.body_${platform}` : 'settings.about.body')}
          </p>
          {isTauri() && (
            <>
              <div className="flex items-center justify-between text-xs pt-1">
                <span className="text-fg-secondary">{t('settings.about.version')}</span>
                <span className="font-mono text-fg-secondary">{desktopVersion ?? '…'}</span>
              </div>
              <button
                onClick={() => void runUpdateCheck()}
                disabled={updateBusy}
                className="w-full h-10 rounded-md bg-field text-sm font-medium hover:bg-line/50 disabled:opacity-40 transition-colors"
              >
                {updateBusy ? t('settings.about.update_checking') : t('settings.about.update_check')}
              </button>
              {updateNote && <p className="text-xs text-fg-dim">{updateNote}</p>}
            </>
          )}
          <a
            href="https://rcq.app"
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs font-medium text-accent hover:underline"
          >
            rcq.app
          </a>
        </section>

        <section className="bg-surface rounded-lg p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.session')}
          </div>
          <button
            onClick={signOut}
            className="w-full h-10 rounded-md bg-field text-sm font-medium hover:bg-line/50 transition-colors"
          >
            {t('settings.session.unlink')}
          </button>
          <p className="text-xs text-fg-dim">{t('settings.session.unlink_footer')}</p>
        </section>

        {/* Burn account — redesigned off the old "red-outlined everything"
            look (founder disliked the red lines): a NEUTRAL card with a single
            warning glyph; red is reserved for the one truly destructive action
            (the final confirm button) so it reads as deliberate, not alarming. */}
        <section className="bg-surface rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-secondary">
            <WarnIcon />
            {t('settings.section.danger')}
          </div>
          <p className="text-xs text-fg-secondary">{t('settings.danger.body')}</p>
          {!confirming ? (
            <button
              onClick={() => setConfirming(true)}
              className="w-full h-10 rounded-md bg-field text-sm font-medium text-red-600 hover:bg-line/50 transition-colors"
            >
              {t('settings.danger.cta')}
            </button>
          ) : (
            <div className="space-y-2">
              {/* Anti-fat-finger: must type the literal UIN before
                  the confirm button activates. iOS doesn't gate
                  burn this way (the destructive system dialog is
                  considered enough), but on web a misclick is
                  much easier — typing the UIN forces a deliberate
                  action. */}
              <p className="text-xs text-fg-secondary">
                {t('settings.danger.type_uin', { uin: identity.uin })}
              </p>
              <input
                type="text"
                value={burnTyped}
                onChange={(e) => setBurnTyped(e.target.value)}
                placeholder={String(identity.uin)}
                className="w-full h-10 px-3 rounded-md bg-field outline-none focus:ring-1 focus:ring-accent text-sm font-mono text-center"
                autoFocus
              />
              <button
                onClick={() => void burn()}
                disabled={burning || burnTyped.trim() !== String(identity.uin)}
                className="w-full h-10 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-semibold disabled:opacity-40 transition-colors"
              >
                {burning ? t('settings.danger.busy') : t('settings.danger.confirm')}
              </button>
              <button
                onClick={() => {
                  setConfirming(false)
                  setBurnTyped('')
                }}
                disabled={burning}
                className="w-full h-9 text-sm text-fg-secondary hover:text-fg-primary"
              >
                {t('common.cancel')}
              </button>
            </div>
          )}
          {error && (
            <div className="text-sm text-red-600 bg-red-500/5 rounded-md p-2">
              {error}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

function WarnIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-red-600">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

/// Reveal-on-tap recovery phrase. Only shown for seed-backed accounts (a
/// phone-linked or legacy raw-key session has no phrase — currentRecoveryPhrase
/// returns null and we render nothing). Lets a user back up later if they
/// skipped the create-time card.

/// Export the history to a file, or add a file's history back. Deliberately a
/// plain file and nothing of ours: the person keeps it where they keep things,
/// so there is nothing for us to lose and nothing for us to be made to hand
/// over. The container is shared with the phones (see backup.ts).
function BackupSection() {
  const { t } = useI18n()
  const { identity } = useIdentity()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const words = currentRecoveryPhrase()
  if (!identity || !words) return null
  const phrase = words.join(' ')

  async function save() {
    setBusy(true); setErr(null); setNote(null)
    try {
      const blob = await exportBackup(identity!.uin, phrase)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `rcq-${new Date().toISOString().slice(0, 10)}.rcqbak`
      // In the document and revoked a task later: Firefox and Safari start the
      // download asynchronously, and revoking in the same task raced it into a
      // zero-byte file while the screen still said it had been saved.
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      setTimeout(() => {
        a.remove()
        URL.revokeObjectURL(url)
      }, 60_000)
      setNote(t('settings.backup.saved'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function restore(file: File | null) {
    if (!file) return
    setBusy(true); setErr(null); setNote(null)
    try {
      const r = await importBackup(await file.arrayBuffer(), phrase, identity!.uin)
      // What could not be read and what the browser cannot hold are said out
      // loud rather than folded into "already here".
      const parts = [t('settings.backup.restored', { added: r.added, skipped: r.skipped })]
      if (r.unreadable > 0) parts.push(t('settings.backup.restoredUnreadable', { n: r.unreadable }))
      if (r.mediaIgnored > 0) parts.push(t('settings.backup.restoredMediaIgnored', { n: r.mediaIgnored }))
      if (r.expired > 0) parts.push(t('settings.backup.restoredExpired', { n: r.expired }))
      setNote(parts.join(' '))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="bg-surface rounded-lg p-4 space-y-3">
      <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
        {t('settings.backup.title')}
      </div>
      <p className="text-xs text-fg-dim leading-relaxed">{t('settings.backup.body')}</p>
      <button
        onClick={() => void save()}
        disabled={busy}
        className="w-full h-9 rounded-md bg-field hover:bg-line/40 text-sm font-medium disabled:opacity-40 transition-colors"
      >
        {t('settings.backup.save')}
      </button>
      <p className="text-xs text-fg-dim leading-relaxed">{t('settings.backup.restore_body')}</p>
      <label className="block w-full h-9 leading-9 text-center rounded-md bg-field hover:bg-line/40 text-sm font-medium cursor-pointer transition-colors">
        {t('settings.backup.restore')}
        <input
          type="file"
          className="hidden"
          disabled={busy}
          onChange={(e) => void restore(e.target.files?.[0] ?? null)}
        />
      </label>
      {note && <p className="text-xs text-accent">{note}</p>}
      {err && <p className="text-xs text-red-500">{err}</p>}
      <p className="text-xs text-fg-dim leading-relaxed">{t('settings.backup.warning')}</p>
    </section>
  )
}

function RecoveryPhraseSection() {
  const { t } = useI18n()
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const words = currentRecoveryPhrase()
  if (!words) return null
  return (
    <section className="bg-surface rounded-lg p-4 space-y-3">
      <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
        {t('settings.recovery.title')}
      </div>
      <p className="text-xs text-fg-dim leading-relaxed">{t('settings.recovery.body')}</p>
      {!revealed ? (
        <button
          onClick={() => setRevealed(true)}
          className="w-full h-9 rounded-md bg-field hover:bg-line/40 text-sm font-medium transition-colors"
        >
          {t('settings.recovery.reveal')}
        </button>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-surface-dim p-3">
            {words.map((w, i) => (
              <div key={i} className="flex items-baseline gap-1 text-sm">
                <span className="font-mono text-[10px] text-fg-dim w-5 text-right shrink-0">{i + 1}</span>
                <span className="font-medium break-all">{w}</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(words.join(' ')).catch(() => {})
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
            className="w-full h-9 rounded-md bg-field hover:bg-line/40 text-sm font-medium transition-colors"
          >
            {copied ? t('login.phrase.copied') : t('login.phrase.copy')}
          </button>
        </div>
      )}
    </section>
  )
}

