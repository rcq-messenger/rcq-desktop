// The desktop lock screen, and everything that turns a PIN on and off.
//
// Sits ABOVE the identity provider on purpose: while the app is locked there
// is no account in the page at all, not a hidden one. The rows come out of the
// vault (src-tauri/src/vault.rs) only after the PIN is typed, and go straight
// into memory — never back to disk.
//
// ⚠ What this does NOT do yet: the message history in IndexedDB stays
// unencrypted, so a locked app still has readable conversations on disk. The
// "what is in this browser" screen says so in as many words rather than
// letting a lock icon imply otherwise. The account itself — keys, recovery
// seed, session tokens — is what this closes, and it is the piece that lets a
// stolen laptop BECOME you somewhere else.

import { useEffect, useState, type ReactNode } from 'react'
import { useI18n } from './i18n-context'
import {
  accountRowsOnDisk,
  adoptVaultedRows,
  clearAccountRowsOnDisk,
  restoreAccountRowsToDisk,
  setVaultWriter,
} from './auth'
import {
  vaultCreate,
  vaultLock,
  vaultRemove,
  vaultState,
  vaultSupported,
  vaultUnlock,
  vaultWrite,
} from './desktop-vault'

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
export async function enablePin(pin: string): Promise<void> {
  const rows = accountRowsOnDisk()
  await vaultCreate(pin, JSON.stringify(rows))
  clearAccountRowsOnDisk()
  adoptVaultedRows(rows)
  attachWriter()
}

/// Hand the account back to the disk. Needs the PIN — this is the one action
/// that makes the data readable again without it.
export async function disablePin(pin: string): Promise<void> {
  const payload = await vaultRemove(pin)
  const rows = JSON.parse(payload) as Record<string, string>
  restoreAccountRowsToDisk(rows)
}

/// Lock without quitting: forget the key in Rust, then reload so no module in
/// the page is left holding an account in a closure. The reload lands on the
/// lock screen because the vault answers "not unlocked".
export async function lockNow(): Promise<void> {
  await vaultLock()
  window.location.assign('/')
}

export function PinGate({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  // null = still asking Rust; true = show the lock screen.
  const [locked, setLocked] = useState<boolean | null>(vaultSupported() ? null : false)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!vaultSupported()) return
    void vaultState().then((s) => {
      if (!s.exists) {
        setLocked(false)
        return
      }
      // A vault that is already unlocked belongs to this same run (a reload
      // after unlocking, say): re-adopt its contents instead of asking again.
      setLocked(true)
    })
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !pin) return
    setBusy(true)
    setError(null)
    try {
      const payload = await vaultUnlock(pin)
      adoptVaultedRows(JSON.parse(payload) as Record<string, string>)
      attachWriter()
      setPin('')
      setLocked(false)
    } catch (err) {
      const code = String((err as Error)?.message ?? err)
      if (code.startsWith('locked_out:')) {
        setError(t('pin.error.wait', { n: code.split(':')[1] ?? '?' }))
      } else if (code.includes('wrong_pin')) {
        setError(t('pin.error.wrong'))
      } else if (code.includes('corrupt_vault')) {
        setError(t('pin.error.corrupt'))
      } else {
        setError(code)
      }
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  if (locked === null) return null
  if (!locked) return <>{children}</>

  return (
    <div className="h-screen [height:100dvh] flex flex-col items-center justify-center bg-surface-dim px-6">
      <form onSubmit={submit} className="w-full max-w-xs space-y-4 text-center">
        <div className="text-4xl select-none">🔒</div>
        <div className="text-sm text-fg-secondary">{t('pin.locked')}</div>
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
        {error && <div className="text-xs text-red-500">{error}</div>}
        <button
          type="submit"
          disabled={busy || pin.length < 4}
          className="w-full h-11 rounded-lg bg-accent text-ink-black font-semibold disabled:opacity-40 transition-opacity"
        >
          {busy ? t('pin.checking') : t('pin.unlock')}
        </button>
        <p className="text-xs text-fg-dim leading-relaxed">{t('pin.forgot')}</p>
      </form>
    </div>
  )
}
