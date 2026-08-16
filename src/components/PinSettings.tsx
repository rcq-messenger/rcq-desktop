// The PIN section in Settings — desktop only, and it renders nothing at all
// in a browser tab.
//
// ⚠ That absence is the honest answer, not an oversight. A browser hands its
// storage to any script in the origin and to anyone holding the unlocked
// machine, so a PIN there would be a lock drawn on a door that has no frame.
// The desktop has a directory the page cannot read by itself, which is what
// makes the difference real (src-tauri/src/vault.rs).

import { useEffect, useState } from 'react'
import { useI18n } from '../lib/i18n-context'
import { useToast } from '../lib/toast'
import {
  AUTOLOCK_CHOICES,
  autoLockMinutes,
  disablePin,
  enablePin,
  lockNow,
  setAutoLockMinutes,
} from '../lib/pin-gate'
import { vaultState, vaultSupported } from '../lib/desktop-vault'

type Mode = 'idle' | 'setting' | 'removing'

export function PinSettings() {
  const { t } = useI18n()
  const { toast } = useToast()
  const [exists, setExists] = useState<boolean | null>(null)
  const [mode, setMode] = useState<Mode>('idle')
  const [pin, setPin] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autolock, setAutolock] = useState(() => autoLockMinutes())

  useEffect(() => {
    if (!vaultSupported()) return
    void vaultState().then((s) => setExists(s.exists))
  }, [])

  if (!vaultSupported() || exists === null) return null

  function reset() {
    setMode('idle')
    setPin('')
    setConfirm('')
    setError(null)
  }

  async function onSet() {
    if (pin.length < 4) return setError(t('pin.error.short'))
    if (pin !== confirm) return setError(t('pin.error.mismatch'))
    setBusy(true)
    try {
      await enablePin(pin)
      setExists(true)
      reset()
      toast(t('pin.set.done'))
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  async function onRemove() {
    setBusy(true)
    try {
      await disablePin(pin)
      setExists(false)
      reset()
      toast(t('pin.off.done'))
    } catch (e) {
      const code = String((e as Error)?.message ?? e)
      setError(code.includes('wrong_pin') ? t('pin.error.wrong') : code)
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="bg-surface rounded-lg p-4 space-y-3">
      <div className="text-xs font-semibold text-fg-secondary uppercase tracking-wide">
        {t('pin.title')}
      </div>
      <p className="text-sm text-fg-secondary leading-relaxed whitespace-pre-line">
        {exists ? t('pin.on.body') : t('pin.off.body')}
      </p>

      {mode === 'idle' && !exists && (
        <button
          onClick={() => setMode('setting')}
          className="w-full h-9 rounded-md bg-field text-sm font-medium hover:bg-line/40 transition-colors"
        >
          {t('pin.set')}
        </button>
      )}

      {/* Only meaningful once a PIN exists — an auto-lock with nothing to lock
          would just be a setting that does nothing. */}
      {mode === 'idle' && exists && (
        <div className="space-y-2">
          <div className="text-sm text-fg-secondary">{t('pin.autolock')}</div>
          <div className="flex gap-1.5">
            {AUTOLOCK_CHOICES.map((m) => (
              <button
                key={m}
                onClick={() => {
                  setAutoLockMinutes(m)
                  setAutolock(m)
                }}
                className={`flex-1 h-8 rounded-md text-xs font-medium transition-colors ${
                  autolock === m
                    ? 'bg-accent text-ink-black'
                    : 'bg-field text-fg-secondary hover:bg-line/40'
                }`}
              >
                {m === 0 ? t('pin.autolock.never') : t('pin.autolock.minutes', { n: m })}
              </button>
            ))}
          </div>
          <p className="text-xs text-fg-dim leading-relaxed">{t('pin.autolock.help')}</p>
        </div>
      )}

      {mode === 'idle' && exists && (
        <div className="flex gap-2">
          <button
            onClick={() => void lockNow()}
            className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/40 transition-colors"
          >
            {t('pin.lock_now')}
          </button>
          <button
            onClick={() => setMode('removing')}
            className="flex-1 h-9 rounded-md text-sm font-medium text-red-600 hover:bg-red-500/10 transition-colors"
          >
            {t('pin.remove')}
          </button>
        </div>
      )}

      {mode === 'setting' && (
        <div className="space-y-2">
          <input
            autoFocus
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={t('pin.placeholder')}
            className="w-full h-9 rounded-md bg-field px-3 text-sm outline-none focus:ring-2 focus:ring-accent/60"
          />
          <input
            type="password"
            inputMode="numeric"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={t('pin.placeholder.again')}
            className="w-full h-9 rounded-md bg-field px-3 text-sm outline-none focus:ring-2 focus:ring-accent/60"
          />
          {/* Said before it is set, not after: there is no recovery path for a
              forgotten PIN, by design — a way back in for the owner is a way in
              for whoever took the laptop. */}
          <p className="text-xs text-fg-dim leading-relaxed">{t('pin.set.warn')}</p>
          {error && <div className="text-xs text-red-500">{error}</div>}
          <div className="flex gap-2">
            <button
              onClick={reset}
              className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/40 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              disabled={busy}
              onClick={() => void onSet()}
              className="flex-1 h-9 rounded-md bg-accent text-ink-black text-sm font-semibold disabled:opacity-40 transition-opacity"
            >
              {t('pin.set.confirm')}
            </button>
          </div>
        </div>
      )}

      {mode === 'removing' && (
        <div className="space-y-2">
          <p className="text-xs text-fg-secondary leading-relaxed">{t('pin.remove.warn')}</p>
          <input
            autoFocus
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder={t('pin.placeholder')}
            className="w-full h-9 rounded-md bg-field px-3 text-sm outline-none focus:ring-2 focus:ring-accent/60"
          />
          {error && <div className="text-xs text-red-500">{error}</div>}
          <div className="flex gap-2">
            <button
              onClick={reset}
              className="flex-1 h-9 rounded-md bg-field text-sm font-medium hover:bg-line/40 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              disabled={busy || pin.length < 4}
              onClick={() => void onRemove()}
              className="flex-1 h-9 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-semibold disabled:opacity-40 transition-colors"
            >
              {t('pin.remove.confirm')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
