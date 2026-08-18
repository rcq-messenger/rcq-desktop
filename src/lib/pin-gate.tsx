// The desktop lock screen, and everything that turns a PIN on and off.
//
// Sits ABOVE the identity provider on purpose: while the app is locked there
// is no account in the page at all, not a hidden one. The rows come out of the
// vault (src-tauri/src/vault.rs) only after the PIN is typed, and go straight
// into memory — never back to disk.
//
// The conversations go with it (pin-seal.ts): the received history, every
// outgoing log and the picture cache are sealed under a key that lives only
// inside the vault. What is still in the clear — the libsignal device, the
// contact snapshot, the sender keys — is named on the "what is in this
// browser" screen, because a lock icon that implies more than it does is worse
// than no lock icon.

import { useEffect, useState, type ReactNode } from 'react'
import { useI18n } from './i18n-context'
import { useToast } from './toast'
import {
  accountRowsOnDisk,
  adoptVaultedRows,
  clearAccountRowsOnDisk,
  restoreAccountRowsToDisk,
  setVaultWriter,
  wipeLocalAccountData,
} from './auth'
import {
  vaultCreate,
  vaultLock,
  vaultRemove,
  vaultState,
  vaultSupported,
  vaultRead,
  vaultUnlock,
  vaultDestroy,
  vaultWrite,
} from './desktop-vault'
import { adoptSealedOutgoing, releaseSealedOutgoing } from './outgoing-store'
import {
  HISTORY_KEY_ROW,
  newHistoryKeyB64,
  releaseExistingHistory,
  sealExistingHistory,
  setHistoryKey,
} from './pin-seal'

/// Wire the in-memory account rows to the vault, so every later change (a
/// refreshed token, a second account, a sign-out) is re-sealed.
///
/// Writes are coalesced: adopting an account fires several in a row, and each
/// one is an Argon2-free but still real file write.
function attachWriter(): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let latest: Record<string, string> | null = null
  setVaultWriter((rows) => {
    latest = rows
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const payload = latest
      latest = null
      if (payload) void vaultWrite(JSON.stringify(payload)).catch(() => {})
    }, 120)
  })
}

/// Take the account off the disk and put it behind `pin`. Order matters: the
/// vault has to confirm it holds the rows BEFORE they are deleted.
///
/// The history key rides inside the same sealed JSON (pin-seal.ts). It is
/// generated here and never exists anywhere else, so switching a PIN on is
/// also the moment the conversations stop being readable on this disk.
export async function enablePin(pin: string): Promise<void> {
  const rows = { ...accountRowsOnDisk(), [HISTORY_KEY_ROW]: newHistoryKeyB64() }
  await vaultCreate(pin, JSON.stringify(rows))
  clearAccountRowsOnDisk()
  adoptVaultedRows(rows)
  attachWriter()
  await setHistoryKey(rows[HISTORY_KEY_ROW])
  // What is already on the disk, in both stores. Awaited: the settings screen
  // says "PIN set" when this returns, and it should be true by then.
  await sealExistingHistory()
  await adoptSealedOutgoing()
}

/// Hand the account back to the disk. Needs the PIN — this is the one action
/// that makes the data readable again without it.
export async function disablePin(pin: string): Promise<void> {
  const payload = await vaultRemove(pin)
  const rows = JSON.parse(payload) as Record<string, string>
  // Unseal BEFORE dropping the key, or the history becomes unreadable by the
  // very action whose whole meaning is "make this readable again".
  await setHistoryKey(rows[HISTORY_KEY_ROW] ?? null)
  await releaseExistingHistory()
  await releaseSealedOutgoing()
  await setHistoryKey(null)
  delete rows[HISTORY_KEY_ROW]
  restoreAccountRowsToDisk(rows)
}

/// Lock without quitting: forget the key in Rust, then reload so no module in
/// the page is left holding an account in a closure. The reload lands on the
/// lock screen because the vault answers "not unlocked".
export async function lockNow(): Promise<void> {
  await vaultLock()
  window.location.assign('/')
}

// ── auto-lock ────────────────────────────────────────────────────────────────
//
// A PIN that is only asked at launch protects a machine that gets rebooted.
// The one that gets left open in a kitchen, or handed over "just to look at
// something", is the case people actually meet — so the app locks itself after
// a stretch of no input.
//
// Off by default: locking is disruptive, and a lock nobody asked for teaches
// people to turn the whole thing off.
export const AUTOLOCK_KEY = 'rcq.desktop.pin.autolock'
/// Minutes. 0 = never.
export const AUTOLOCK_CHOICES = [0, 5, 15, 60] as const

export function autoLockMinutes(): number {
  const raw = Number(localStorage.getItem(AUTOLOCK_KEY) ?? '0')
  return AUTOLOCK_CHOICES.includes(raw as (typeof AUTOLOCK_CHOICES)[number]) ? raw : 0
}

export function setAutoLockMinutes(m: number): void {
  localStorage.setItem(AUTOLOCK_KEY, String(m))
}

/// Watches for idleness while unlocked. Mounted only on the desktop, and only
/// once a vault exists — there is nothing to lock otherwise.
function AutoLock() {
  useEffect(() => {
    const minutes = autoLockMinutes()
    if (minutes <= 0) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void lockNow(), minutes * 60_000)
    }
    // Anything that means a person is here. `visibilitychange` counts too: a
    // window that comes back to the front should get its full stretch again
    // rather than locking a second later.
    const events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'visibilitychange']
    for (const e of events) window.addEventListener(e, arm, { passive: true })
    arm()
    return () => {
      if (timer) clearTimeout(timer)
      for (const e of events) window.removeEventListener(e, arm)
    }
  }, [])
  return null
}

/// Take the vault's contents into the page: the account rows, the history key,
/// and the outgoing logs that have to be decrypted before anything renders.
/// Shared by the PIN prompt and by the already-unlocked reload path, because
/// the two must not drift.
async function adoptRows(rows: Record<string, string>): Promise<void> {
  adoptVaultedRows(rows)
  attachWriter()
  await setHistoryKey(rows[HISTORY_KEY_ROW] ?? null)
  await adoptSealedOutgoing()
}

async function adoptUnlockedVault(): Promise<void> {
  const rows = JSON.parse(await vaultRead()) as Record<string, string>
  if (!rows[HISTORY_KEY_ROW]) {
    rows[HISTORY_KEY_ROW] = newHistoryKeyB64()
    await vaultWrite(JSON.stringify(rows)).catch(() => {})
  }
  await adoptRows(rows)
}

/// `95` → `1:35`, `9` → `0:09`. The cap is five minutes, so hours never happen.
function mmss(total: number): string {
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function PinGate({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  // null = still asking Rust; true = show the lock screen.
  const [locked, setLocked] = useState<boolean | null>(vaultSupported() ? null : false)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  /// Seconds left before another attempt is allowed. The back-off is a ladder,
  /// not a flat wall: five wrong PINs cost 5s, then 10, 20, 40 and so on to a
  /// five-minute cap. Shown as a live count because "try again later" without a
  /// number is indistinguishable from a broken field.
  const [cooldown, setCooldown] = useState(0)
  const [forgot, setForgot] = useState(false)
  const { toast } = useToast()

  // Tick it down. Also re-read on mount below: a cool-down survives quitting
  // the app, and coming back to a field that silently refuses is the same
  // dead-end this replaces.
  useEffect(() => {
    if (cooldown <= 0) return
    const h = setInterval(() => setCooldown((n) => (n <= 1 ? 0 : n - 1)), 1000)
    return () => clearInterval(h)
  }, [cooldown > 0])

  useEffect(() => {
    if (!vaultSupported()) return
    void vaultState().then(async (s) => {
      if (!s.exists) {
        setLocked(false)
        return
      }
      // A vault that is ALREADY unlocked belongs to this same run: the page
      // reloads itself on an account switch and on an island switch, and both
      // used to land back on the lock screen and ask for the PIN a second time
      // in one session. The key is still in Rust, so take the contents back and
      // carry on. Only a fresh launch (or Lock now) has no key and asks.
      if (s.cooldown > 0) setCooldown(s.cooldown)
      if (s.unlocked) {
        try {
          await adoptUnlockedVault()
          setLocked(false)
          return
        } catch {
          /* the key went away between the two calls — ask properly */
        }
      }
      setLocked(true)
    })
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !pin || cooldown > 0) return
    setBusy(true)
    try {
      const payload = await vaultUnlock(pin)
      const rows = JSON.parse(payload) as Record<string, string>
      // A vault created before the history was sealed has no key in it. Mint
      // one on this unlock rather than leaving those installs unsealed forever
      // — the vault is already open, so this costs nothing and needs no PIN
      // prompt. Sweeping what is already on disk happens later, once the
      // account scope names the right database (pin-seal.ts).
      if (!rows[HISTORY_KEY_ROW]) {
        rows[HISTORY_KEY_ROW] = newHistoryKeyB64()
        await vaultWrite(JSON.stringify(rows)).catch(() => {})
      }
      // Before anything below the gate renders: Chat builds its state from the
      // outgoing log during a render and cannot wait on a decrypt, so the logs
      // are in memory by the time it mounts.
      await adoptRows(rows)
      setPin('')
      setLocked(false)
    } catch (err) {
      const code = String((err as Error)?.message ?? err)
      // ⚠ Every one of these used to render UNDER the input, which moved the
      // input. Type the wrong PIN twice and the field jumped down, up and down
      // again, because the line is cleared at the start of the next attempt and
      // painted again at its end. A notice is not a state of this screen; it
      // belongs in the same corner as every other passing notice in the app.
      if (code.startsWith('locked_out:')) {
        const secs = Number(code.split(':')[1] ?? 0)
        setCooldown(secs > 0 ? secs : 5)
      } else if (code.includes('wrong_pin')) {
        toast(t('pin.error.wrong'), 'error')
      } else if (code.includes('corrupt_vault')) {
        toast(t('pin.error.corrupt'), 'error')
      } else {
        toast(code, 'error')
      }
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  /// Drop the vault unopened and land on the login screen, where "recover by
  /// phrase" and "new account" already live. Nothing here can hand the old
  /// conversations back: they are sealed under a key that only existed inside
  /// the vault, which is the point of the PIN.
  async function resetVault() {
    setBusy(true)
    try {
      await vaultDestroy()
      wipeLocalAccountData()
      window.location.assign('/')
    } catch (err) {
      toast(String((err as Error)?.message ?? err), 'error')
      setBusy(false)
    }
  }

  if (locked === null) return null
  if (!locked) {
    return (
      <>
        {vaultSupported() && <AutoLock />}
        {children}
      </>
    )
  }

  // No card, no glass, no blur: the field simply stands in the middle of a
  // quiet background. The frosted pane was tried and read as a dialog on top of
  // something, which is wrong here — there is nothing underneath while the app
  // is locked, because the account is not in the page at all.
  return (
    <div className="relative h-screen [height:100dvh] overflow-hidden bg-surface-dim">
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-br from-accent/10 via-surface-dim to-surface-dim"
      />
      <div className="relative h-full flex flex-col items-center justify-center px-6">
      {forgot ? (
        /* Deliberately a whole panel and not a confirm(): what goes is not
           obvious, and a one-line browser dialog would have been read as "are
           you sure you want to continue" rather than "this erases the history
           on this computer". The account itself is not in danger IF the phrase
           is written down, and that "if" is the whole message. */
        <div className="w-full max-w-xs space-y-4">
          <div className="text-sm font-semibold">{t('pin.forgot.title')}</div>
          <p className="text-xs text-fg-secondary leading-relaxed">{t('pin.forgot.body')}</p>
          <button
            type="button"
            onClick={() => void resetVault()}
            disabled={busy}
            className="w-full h-11 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold disabled:opacity-40 transition-colors"
          >
            {t('pin.forgot.confirm')}
          </button>
          <button
            type="button"
            onClick={() => setForgot(false)}
            className="w-full h-11 rounded-lg bg-field text-sm hover:bg-line/50 transition-colors"
          >
            {t('common.cancel')}
          </button>
        </div>
      ) : (
      <form onSubmit={submit} className="w-full max-w-xs space-y-4 text-center">
        {/* The padlock with our flower tucked into its bottom-right corner, so
            the locked screen still says whose app this is.
            ⚠ The offsets are INSIDE the span, not negative. An emoji glyph is
            drawn narrower than its box, so `-right-2` put the flower past the
            padlock's own right edge with a gap between them — two marks side by
            side rather than one, and the flower looked as if it had slipped off
            (founder). Overlapping the corner is what "tucked" was supposed to
            mean. */}
        <div className="relative inline-block select-none">
          <span className="text-5xl leading-none">🔒</span>
          <img
            src="/logo.png"
            alt=""
            aria-hidden
            className="absolute bottom-0.5 right-1 w-5 h-5 drop-shadow"
          />
        </div>
        <div className="text-sm text-fg-secondary">{t('pin.locked')}</div>
        {/* The count-down lives IN the field, in its place, so nothing on this
            screen moves while it runs. A disabled empty box would have said
            "broken"; a number that goes down says "wait, and how long". */}
        {cooldown > 0 ? (
          <div className="w-full h-11 rounded-lg bg-field px-3 flex items-center justify-center text-sm text-fg-secondary tabular-nums">
            {t('pin.cooldown', { t: mmss(cooldown) })}
          </div>
        ) : (
          <input
            autoFocus
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={t('pin.placeholder')}
            // The wide tracking is for the dots of a typed PIN; on the empty
            // field it stretched the placeholder into a ransom note.
            className={`w-full h-11 rounded-lg bg-field px-3 text-center outline-none focus:ring-2 focus:ring-accent/60 ${pin ? 'tracking-[0.3em]' : ''}`}
          />
        )}
        <button
          type="submit"
          disabled={busy || pin.length < 4 || cooldown > 0}
          className="w-full h-11 rounded-lg bg-accent text-ink-black font-semibold disabled:opacity-40 transition-opacity"
        >
          {busy ? t('pin.checking') : t('pin.unlock')}
        </button>
        {/* The way out of "I forgot it". Without it the only exits were the
            OS file manager and giving up, which is a trap the owner falls into
            and nobody else. */}
        <button
          type="button"
          onClick={() => setForgot(true)}
          className="text-xs text-fg-secondary hover:text-fg-primary transition-colors"
        >
          {t('pin.forgot.link')}
        </button>
      </form>
      )}
      </div>
    </div>
  )
}
