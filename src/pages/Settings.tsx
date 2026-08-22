// Settings — profile link, language picker, privacy navigation,
// sound on/off, sign out, burn account.
//
// Privacy is its own page (`/privacy`) — five tri-state pickers
// took up too much vertical space inline. Settings now just shows
// a nav-row that opens the dedicated surface.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { currentRecoveryPhrase, forgetRecoverySeed, revokedAccounts } from '../lib/auth'
import { myAccountDevices, myDeviceId, splitToOwnSlot } from '../lib/signal-device'
import { exportBackup, importBackup } from '../lib/backup-data'
import { Dropdown, type DropdownOption } from '../components/Dropdown'
import { LanguagePicker } from '../components/LanguagePicker'
import { Logo } from '../components/Logo'
import { MyQRCode } from '../components/MyQRCode'
import { Api, REPORT_TAG, reportTextLimit } from '../lib/api'
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
import { PinSettings } from '../components/PinSettings'
import { flushVaultWriter } from '../lib/pin-gate'
import { useToast } from '../lib/toast'
import type { UserInfo } from '../lib/api'
import { DEFAULT_API_BASE } from '../lib/auth'
import { snapshotFor } from '../lib/contacts-cache'
import { PersonAvatar } from '../components/PersonAvatar'
import { useIdentity } from '../lib/identity-context'
import { isPresenceSoundEnabled, isSentSoundEnabled, isSoundEnabled, setPresenceSoundEnabled, setSentSoundEnabled, setSoundEnabled } from '../lib/sounds'
import {
  FONT_SCALES,
  getFontScale,
  setFontScale,
  subscribeFontScale,
  type FontScale,
} from '../lib/fontscale'
import { useTheme, type ThemePref } from '../lib/theme-context'
import {
  addBackupIsland,
  adoptHomesFromOwnRecord,
  disableAutoBackup,
  enableAutoBackup,
  listBackupHomes,
  removeBackupIsland,
  promoteBackupToPrimary,
  scrubFrontAliasHomes,
  type BackupHome,
} from '../lib/multihome'
import { publishHomeIslandRecord } from '../lib/federation-publish'
import { pushHomeRecordToContacts } from '../lib/federation-gossip'
import { useServerInfo, DEFAULT_CAPABILITIES } from '../lib/server-info'

export function Settings() {
  const { identity, accounts, switchAccount, addAccount, signOutAccount, signOut } = useIdentity()
  const [revoked] = useState<number[]>(() => revokedAccounts())
  const { t } = useI18n()
  // Who this island says it is, and which surfaces it runs. Permissive while
  // the answer is in flight, so nothing blinks out and back in on open.
  const islandInfo = useServerInfo(identity?.apiBase)
  const caps = islandInfo?.capabilities ?? DEFAULT_CAPABILITIES
  const islandName = islandInfo?.name.trim() || null
  const islandRules = islandInfo?.welcome.trim() || null
  const islandHost = (identity?.apiBase ?? '').replace(/^https?:\/\//, '')
  const [showRules, setShowRules] = useState(false)
  // The account's key slots (#643): every install with its own encryption
  // keys, which is the one list a phrase login must show up in. null while
  // loading; [] when the island could not answer.
  const [accountDevices, setAccountDevices] = useState<Array<{ device_id: number; label: string | null }> | null>(null)
  const [ownDeviceId, setOwnDeviceId] = useState<number | null>(null)
  /// Slot the revoke confirm is armed for (пункт 13), and the one in flight.
  const [revokeArmed, setRevokeArmed] = useState<number | null>(null)
  const [revokingSlot, setRevokingSlot] = useState<number | null>(null)
  const [splitArmed, setSplitArmed] = useState(false)
  useEffect(() => {
    if (!identity) return
    let alive = true
    void myAccountDevices(identity)
      .then((list) => { if (alive) setAccountDevices(list) })
      .catch(() => { if (alive) setAccountDevices([]) })
    void myDeviceId(identity)
      .then((d) => { if (alive) setOwnDeviceId(d) })
      .catch(() => {})
    return () => { alive = false }
  }, [identity])

  /// Retire a key slot. Two-tap confirm in place, no modal; a cooldown 403
  /// from the island turns into the human sentence it means.
  async function revokeSlot(deviceId: number) {
    if (!identity || revokingSlot != null) return
    setRevokeArmed(null)
    setRevokingSlot(deviceId)
    try {
      await Api.revokeDeviceSlot(identity, deviceId)
      setAccountDevices((list) => list?.filter((d) => d.device_id !== deviceId) ?? list)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (/revoke_cooldown/.test(msg)) {
        const h = Math.max(1, Math.ceil(Number(/"wait_seconds"\s*:\s*(\d+)/.exec(msg)?.[1] ?? 86400) / 3600))
        toast(t('settings.devices.revoke_cooldown', { h: String(h) }), 'error')
      } else {
        toast(t('settings.devices.revoke_failed'), 'error')
      }
    } finally {
      setRevokingSlot(null)
    }
  }
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [burnTyped, setBurnTyped] = useState('')
  const [burning, setBurning] = useState(false)
  const { toast } = useToast()
  const [soundOn, setSoundOnState] = useState<boolean>(() => isSoundEnabled())
  const [presenceSoundOn, setPresenceSoundOnState] = useState<boolean>(() => isPresenceSoundEnabled())
  const [sentSoundOn, setSentSoundOnState] = useState<boolean>(() => isSentSoundEnabled())
  const { pref: themePref, setPref: setThemePref } = useTheme()
  const fontScalePref = useSyncExternalStore(subscribeFontScale, getFontScale)
  const [backups, setBackups] = useState<BackupHome[]>(() => listBackupHomes())
  const [mhAdding, setMhAdding] = useState(false)
  const [mhHost, setMhHost] = useState('')
  const [mhBusy, setMhBusy] = useState(false)
  const [mhError, setMhError] = useState<string | null>(null)
  const [mhAutoBusy, setMhAutoBusy] = useState(false)
  // What the toggle is doing right now, so a ten-second errand does not look
  // like a dead switch (#605). null while idle.
  const [mhStage, setMhStage] = useState<string | null>(null)
  // True while we are checking our own published record for homes this browser
  // has not adopted yet (#605) — the section is not trustworthy until it lands.
  const [mhSyncing, setMhSyncing] = useState(true)
  // The manual block starts open only when a manually-added island exists
  // (self-hosters); everyone else sees just the toggle.
  const [mhAdvanced, setMhAdvanced] = useState(() =>
    listBackupHomes().some((h) => !h.auto && !h.adopted),
  )
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

  // #605: the backup island lives in the signed home-island record the island
  // serves, not only in this browser's storage — so a browser that never added
  // one itself still has to show the one a phone added, instead of a switch
  // that reads "off" for an account that plainly has a backup. Boot does this
  // too; repeating it here covers a Settings opened before boot got to it, and
  // costs one request when there is nothing to adopt.
  useEffect(() => {
    if (!identity) return
    let alive = true
    // Same order as boot: scrub phantom front homes first, so the screen
    // cannot show cdn.rcq.app as a "backup island" (it is the flagship's own
    // front — the very screenshot this fix exists because of).
    scrubFrontAliasHomes(identity)
    void adoptHomesFromOwnRecord(identity).then(() => {
      if (!alive) return
      setBackups(listBackupHomes())
      setMhSyncing(false)
    })
    return () => {
      alive = false
    }
  }, [identity])

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
    if (outcome.kind === 'current') setUpdateNote(t('settings.about.update_current'))
    // The reason is appended verbatim. It is not pretty, and it is the only
    // thing that turns "it didn't work" into a report anybody can act on.
    else if (outcome.kind === 'failed') {
      setUpdateNote(`${t('settings.about.update_failed')} ${outcome.reason}`.trim())
    } else if (outcome.kind === 'install_failed') {
      setUpdateNote(`${t('settings.about.update_install_failed')} ${outcome.reason}`.trim())
    }
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

  // The tag the admin queue sees. Every desktop report used to arrive as
  // "[Web]", which on a Windows app is simply wrong and hid the platform of
  // the three reports this very build answers. Android has named itself
  // "[Android 0.110]" for a long time.
  const reportTag =
    platform && desktopVersion ? `[Desktop ${desktopVersion} ${platform}]` : REPORT_TAG

  async function submitReport() {
    setReportBusy(true)
    setReportError(null)
    try {
      const atts = (await Promise.all(
        reportFiles.map((f) => uploadReportAttachment(identity!.apiBase, f)),
      )).filter((a): a is NonNullable<typeof a> => a != null)
      await Api.sendReport(identity!, reportText.trim(), atts, reportTag)
      setReportSent(true)
      setReportText('')
      setReportFiles([])
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      // 429 = the server's per-uin rate limit on the reports channel
      // (20/hr for bug reports; the 5/hr budget is for abuse reports).
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
      // The promoted identity is a vault write on desktop — land it before
      // the reload tears the page down (see flushVaultWriter).
      await flushVaultWriter()
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
    // ⚠ #605: "switching the backup on in the web takes a long time, but then
    // it does give the right number". It is a catalogue fetch, a health probe
    // of every candidate island and a registration handshake — ten seconds and
    // more — and it reported none of it, so the only signal was a checkbox that
    // stayed off. Name the stage, and name the island once we have one.
    setMhStage(on ? t('settings.multihome.auto_busy') : null)
    try {
      if (on) {
        await enableAutoBackup(identity!, (stage) => {
          setMhStage(
            stage.kind === 'picking'
              ? t('settings.multihome.auto_busy')
              : t('settings.multihome.auto_connecting', { host: stage.host }),
          )
        })
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
      // Three different failures, and telling them apart is the whole point:
      // "the list did not arrive" is usually a blocked network and has nothing
      // to do with any island, which is how #579 came in as an island being
      // down when GitHub was simply unreachable from there.
      const known: Record<string, string> = {
        'no catalogue': 'settings.multihome.error.catalogue',
        'no island': 'settings.multihome.error.none',
      }
      setMhError(
        known[msg]
          ? t(known[msg])
          : `${t('settings.multihome.error.generic')}${msg ? ` (${msg})` : ''}`,
      )
    } finally {
      setMhAutoBusy(false)
      setMhStage(null)
    }
  }

  async function burn() {
    setBurning(true)
    try {
      await Api.burnAccount(identity!)
      signOut()
      navigate('/', { replace: true })
    } catch (e) {
      toast(e instanceof Error ? e.message : t('settings.danger.error'), 'error')
    } finally {
      setBurning(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-dim">
      <header className="rcq-header sticky top-0 z-10">
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
                      // THIS account's island, not the active one. Otherwise a
                      // row for an account living on another island asks the
                      // wrong server for its picture and falls back to the
                      // flower.
                      apiBase={a.apiBase}
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
                      {/* Without this the row just bounced to login on every
                          tap, with nothing on screen saying the session had
                          been ended from the phone. */}
                      {revoked.includes(a.uin) && (
                        <span className="block text-xs text-fg-dim">
                          {t('settings.accounts.revoked')}
                        </span>
                      )}
                    </span>
                    {isActive && <span className="flex-none text-accent text-sm">✓</span>}
                  </button>
                  {(accounts.length > 1 || revoked.includes(a.uin)) && (
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

        {/* These link-cards hover to `field`, not to `surface-dim`: in the
            true-black dark theme surface-dim IS the page, so the old hover
            sank the card into the background instead of lifting it — a block
            that goes black under the cursor reads as disappearing, not as
            responding (founder, 21.08). Same fix on every card below. */}
        <Link
          to="/market"
          className="block bg-surface rounded-lg p-4 hover:bg-field transition-colors"
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
          <MyQRCode me={me} />
        </section>

        {/* The island this account lives on, in its own words. Both fields are
            typed by the operator in the admin panel and have been served on
            /server/info since islands existed; no browser ever read them, so
            the admin panel carried a note saying they changed nothing. Shown
            for EVERY island including the flagship, which has a name and rules
            of its own. */}
        <section className="bg-surface rounded-lg p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.island')}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{islandName ?? islandHost}</div>
            {/* The host repeats under a name and nowhere else: two lines
                saying the same host is one line of noise. */}
            {islandName && (
              <div className="font-mono text-xs text-fg-dim truncate">{islandHost}</div>
            )}
          </div>
          {islandRules && (
            <>
              <button
                onClick={() => setShowRules(!showRules)}
                className="block text-left text-xs text-fg-secondary hover:text-fg-primary transition-colors"
              >
                {showRules ? '▾' : '▸'} {t('settings.island.rules')}
              </button>
              {/* Opened in place rather than in an overlay. Both bars on this
                  app carry a backdrop-filter, which makes them the containing
                  block for anything `fixed` inside them, and a sheet is how
                  that trap gets sprung. */}
              {showRules && (
                <p className="text-xs text-fg-secondary leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto">
                  {islandRules}
                </p>
              )}
            </>
          )}
        </section>

        {/* #643: the account's key slots. The QR-linked web registry lives on
            the phone's screen; THIS list is the cryptographic one — every
            install that can read v=2 holds a slot here, so a phrase login
            cannot stay out of it. Read-only in v1: revoking a slot is a key
            operation with its own consequences, not a button to add lightly. */}
        <section className="bg-surface rounded-lg p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.devices')}
          </div>
          <p className="text-xs text-fg-secondary">{t('settings.devices.body')}</p>
          {accountDevices != null && (
            <ul className="space-y-1.5">
              {accountDevices.map((d) => (
                <li key={d.device_id} className="flex items-center gap-2 text-sm min-w-0">
                  <span className="font-mono text-xs text-fg-dim flex-none">#{d.device_id}</span>
                  <span className="truncate">
                    {d.device_id === 1 ? t('settings.devices.primary') : d.label || t('settings.devices.unnamed')}
                  </span>
                  {ownDeviceId != null && d.device_id === ownDeviceId && (
                    <span className="text-xs text-accent flex-none">{t('settings.devices.this')}</span>
                  )}
                  {/* Пункт 13: a slot that is neither the primary nor OUR OWN
                      can be retired. Two taps: arm, then the red confirm. */}
                  {d.device_id !== 1 && d.device_id !== ownDeviceId && (
                    <button
                      onClick={() => (revokeArmed === d.device_id ? void revokeSlot(d.device_id) : setRevokeArmed(d.device_id))}
                      disabled={revokingSlot != null}
                      className={`ml-auto flex-none text-xs rounded px-2 py-0.5 transition-colors ${
                        revokeArmed === d.device_id
                          ? 'bg-red-500/15 text-red-500 font-semibold'
                          : 'text-fg-dim hover:text-red-500'
                      }`}
                    >
                      {revokingSlot === d.device_id
                        ? '…'
                        : revokeArmed === d.device_id
                          ? t('settings.devices.revoke_confirm')
                          : t('settings.devices.revoke')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {/* Пункт 13, вторая половина: a legacy session (linked before
              per-device slots — no recovery phrase of its own) riding the
              phone's slot 1 can split into a slot of its own. */}
          {ownDeviceId === 1 && currentRecoveryPhrase() == null && (
            <div className="pt-1 space-y-1.5">
              <p className="text-xs text-fg-dim">{t('settings.devices.split.hint')}</p>
              <button
                onClick={() => {
                  if (!identity) return
                  if (!splitArmed) return setSplitArmed(true)
                  splitToOwnSlot(identity)
                }}
                className={`text-xs rounded px-2 py-1 transition-colors ${
                  splitArmed ? 'bg-accent text-white font-semibold' : 'text-accent hover:underline'
                }`}
              >
                {splitArmed ? t('settings.devices.split.confirm') : t('settings.devices.split')}
              </button>
            </div>
          )}
        </section>

        {/* Multihoming (federation v1): this account also registered on a
            second island, messages get deposited into both mailboxes. */}
        <section className="bg-surface rounded-lg p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.multihome')}
          </div>
          <p className="text-xs text-fg-secondary">{t('settings.multihome.body')}</p>

          {/* One toggle for normal users: the island comes from the catalogue.
              ⚠ #605: an ADOPTED home (one this browser learned from our own
              published record rather than added itself) counts as on. The
              record cannot say whether it was auto-picked or typed by hand, but
              it does say the account has a backup island, and that is what this
              switch claims to answer. */}
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm pr-3">{t('settings.multihome.auto_label')}</span>
            {mhAutoBusy ? (
              // In the checkbox's own place, and its own size, so the row does
              // not jump: an unchecked box next to a line of small grey text is
              // exactly what read as "nothing is happening" (#605).
              <span className="w-5 h-5 shrink-0 flex items-center justify-center text-accent">
                <Spinner />
              </span>
            ) : (
              <input
                type="checkbox"
                checked={backups.some((h) => h.auto || h.adopted)}
                disabled={mhSyncing}
                onChange={(e) => void toggleAutoBackup(e.target.checked)}
                className="w-5 h-5 accent-accent cursor-pointer shrink-0"
              />
            )}
          </label>
          {/* Not `text-fg-dim`: this section's hints are already that colour,
              and a live status the same shade as the static advice underneath
              it is one more grey line, not an answer to "is it doing anything"
              (#605). */}
          {mhStage && <div className="text-xs text-fg-secondary">{mhStage}</div>}
          {backups
            .filter((h) => h.auto || h.adopted)
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
                .filter((h) => !h.auto && !h.adopted)
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
          <p className="text-xs text-fg-dim">{t(isTauri() ? 'settings.multihome.footer.desktop' : 'settings.multihome.footer')}</p>
        </section>

        {/* Privacy — its own page now that there are five pickers.
            See pages/Privacy.tsx for the actual surface. */}
        <Link
          to="/privacy"
          className="block bg-surface rounded-lg p-4 hover:bg-field transition-colors"
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

        {/* Permanent, not an onboarding step. The three questions this answers
            arrive on the third day of using the app, by which time a first-run
            screen is long gone. */}
        <Link
          to="/how"
          className="block bg-surface rounded-lg p-4 hover:bg-field transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
                {t('how.title')}
              </div>
              <div className="text-xs text-fg-dim mt-0.5 truncate">{t('how.footer.short')}</div>
            </div>
            <span className="text-fg-dim">→</span>
          </div>
        </Link>

        {/* Desktop only — renders nothing in a browser tab, where a PIN
            could not be honest. */}
        <PinSettings />

        {/* We ask people to trust a client they cannot open up. This is the
            nearest thing to opening it up: everything this browser is holding,
            measured live, with the switch that removes it. */}
        <Link
          to="/storage"
          className="block bg-surface rounded-lg p-4 hover:bg-field transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
                {t(isTauri() ? 'storage.title.desktop' : 'storage.title')}
              </div>
              <div className="text-xs text-fg-dim mt-0.5 truncate">{t('storage.footer.short')}</div>
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

        {/* Text size (#477). Its own card rather than a row inside the theme
            one: the RU header there reads «Оформление», but the EN header is
            "Theme", and text size is not a theme. */}
        <section className="bg-surface rounded-lg p-4 space-y-3">
          <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
            {t('settings.section.textsize')}
          </div>
          <Dropdown<FontScale>
            value={fontScalePref}
            options={FONT_SCALES.map<DropdownOption<FontScale>>((opt) => ({
              value: opt,
              label: t(`settings.textsize.${opt}`),
            }))}
            onChange={setFontScale}
            ariaLabel={t('settings.section.textsize')}
            variant="row"
          />
          <p className="text-xs text-fg-dim">{t('settings.textsize.footer')}</p>
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
          {/* Your own send chime. It had no switch of its own, so the only
              way to silence it was the master one, which also took the
              incoming chime with it. */}
          <label className={'flex items-center justify-between pt-1 ' + (soundOn ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed')}>
            <span className="text-sm">{t('settings.sound.sent')}</span>
            <input
              type="checkbox"
              checked={sentSoundOn}
              disabled={!soundOn}
              onChange={(e) => {
                setSentSoundEnabled(e.target.checked)
                setSentSoundOnState(e.target.checked)
              }}
              className="w-5 h-5 accent-accent cursor-pointer"
            />
          </label>
          <p className="text-xs text-fg-dim">{t('settings.sound.sent_footer')}</p>
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

        {/* An island may run no report desk at all, and then it gets neither
            entry: the form would be answered 403 and the screen would stay
            empty forever, which is worse than an absent menu item. Same rule
            and same permissive default as Android. */}
        {caps.reports && (<>
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
                // The server's 1000 counts the tag we prepend, so a flat 1000
                // here let a full-length report be typed and then refused with
                // a 422 the UI reported as "could not send" — a network error
                // for a report the network delivered perfectly.
                maxLength={reportTextLimit(reportTag)}
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
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/60 text-white text-[0.625rem] leading-none"
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

        {/* The other half of the channel above: what you sent and what came
            back (#475). Directly under the form, because the question a
            reporter has after sending is "did anyone answer". */}
        <Link
          to="/reports"
          className="block bg-surface rounded-lg p-4 hover:bg-field transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
                {t('myreports.title')}
              </div>
              <div className="text-xs text-fg-dim mt-0.5 truncate">
                {t('settings.myreports.footer.short')}
              </div>
            </div>
            <span className="text-fg-dim">→</span>
          </div>
        </Link>
        </>)}

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
            {/* The explanation uses the word "relay" on purpose, so it has to
                come with a way to find out what one is. Deep-links to the FAQ
                answer; on desktop main.tsx turns target="_blank" into the
                system browser, because wry has no window.open. */}
            <a
              href="https://rcq.app/faq#relays"
              target="_blank"
              rel="noreferrer"
              className="inline-block text-xs text-accent underline-offset-2 hover:underline"
            >
              {t('settings.bypass.learn')}
            </a>
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
          <p className="text-xs text-fg-dim">{t(isTauri() ? 'settings.session.unlink_footer.desktop' : 'settings.session.unlink_footer')}</p>
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

/// The in-progress mark for the backup-island toggle (#605). Same drawing as
/// the market's, kept local because that one is private to its page.
function Spinner() {
  return (
    <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
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
  const { toast } = useToast()
  const words = currentRecoveryPhrase()
  if (!identity || !words) return null
  const phrase = words.join(' ')

  async function save() {
    setBusy(true)
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
      toast(t('settings.backup.saved'))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function restore(file: File | null) {
    if (!file) return
    setBusy(true)
    try {
      const r = await importBackup(await file.arrayBuffer(), phrase, identity!.uin)
      // What could not be read and what the browser cannot hold are said out
      // loud rather than folded into "already here".
      const parts = [t('settings.backup.restored', { added: r.added, skipped: r.skipped })]
      if (r.unreadable > 0) parts.push(t('settings.backup.restoredUnreadable', { n: r.unreadable }))
      if (r.mediaIgnored > 0) parts.push(t('settings.backup.restoredMediaIgnored', { n: r.mediaIgnored }))
      if (r.expired > 0) parts.push(t('settings.backup.restoredExpired', { n: r.expired }))
      toast(parts.join(' '))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
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
      <p className="text-xs text-fg-dim leading-relaxed">{t('settings.backup.warning')}</p>
    </section>
  )
}

function RecoveryPhraseSection() {
  const { t } = useI18n()
  const { toast } = useToast()
  const [revealed, setRevealed] = useState(false)
  const [confirmForget, setConfirmForget] = useState(false)
  // Re-read after forgetting rather than hold the words in state: the point of
  // the control is that they stop being here.
  const [version, setVersion] = useState(0)
  const words = useMemo(() => currentRecoveryPhrase(), [version])
  if (!words) return null
  return (
    <section className="bg-surface rounded-lg p-4 space-y-3">
      <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
        {t('settings.recovery.title')}
      </div>
      <p className="text-xs text-fg-dim leading-relaxed">{t(isTauri() ? 'settings.recovery.body.desktop' : 'settings.recovery.body')}</p>
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
                <span className="font-mono text-[0.625rem] text-fg-dim w-5 text-right shrink-0">{i + 1}</span>
                <span className="font-medium break-all">{w}</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(words.join(' ')).catch(() => {})
              toast(t('login.phrase.copied'))
            }}
            className="w-full h-9 rounded-md bg-field hover:bg-line/40 text-sm font-medium transition-colors"
          >
            {t('login.phrase.copy')}
          </button>

          {/* Once the words are on screen, the honest next question is whether
              they should keep living in this browser. They are the strongest
              thing here — the keys open this account, the phrase re-creates it
              on any island, forever — and nothing in a browser can hide them
              from a script in the same origin or from someone holding an
              unlocked laptop. Offered only after a reveal, never by default:
              for a lot of people this is the only copy. */}
          {!confirmForget ? (
            <button
              onClick={() => setConfirmForget(true)}
              className="w-full h-9 rounded-md text-sm font-medium text-red-600 hover:bg-red-500/10 transition-colors"
            >
              {t('settings.recovery.forget')}
            </button>
          ) : (
            <div className="space-y-2 rounded-md bg-surface-dim p-3">
              <p className="text-xs text-fg-secondary leading-relaxed">
                {t('settings.recovery.forget.warn')}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmForget(false)}
                  className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/40 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => {
                    forgetRecoverySeed()
                    setConfirmForget(false)
                    setRevealed(false)
                    setVersion((v) => v + 1)
                    toast(t('settings.recovery.forgotten'))
                  }}
                  className="flex-1 h-9 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-colors"
                >
                  {t('settings.recovery.forget.confirm')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

