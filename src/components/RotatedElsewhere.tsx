// What a person sees when this account's keys were changed on another of their
// devices, and this browser still holds the previous ones.
//
// The island answers the old signing key with 404 `identity_rotated` (spec
// 2026-09-15, P0.2 and F3). Until C0 this client could only read a 404 as "the
// account is gone" and signed out. Nothing is gone: the account is alive under
// the new keys, and every message on this device is still here.
//
// ⚠⚠ No wipe, no sign-out, no IndexedDB clear, same as the moved-account
// notice. The only way on is the new recovery phrase, entered on the login
// screen; the way there clears the ACTIVE identity slot and leaves the roster
// row (with the old keys, which a sibling cascade will need) and every local
// store exactly where they are.

import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'

export function RotatedElsewhereNotice() {
  const { rotatedElsewhere, leaveRotatedAccount } = useIdentity()
  const { t } = useI18n()

  if (!rotatedElsewhere) return null

  return (
    // Over everything, like AccountMovedNotice: every authed call answers 401
    // or 404 under the old keys, so nothing behind it still works. No
    // backdrop-filter, for the same WebKit `fixed` reason noted there.
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-sm rounded-xl bg-surface text-fg-primary shadow-lg p-5 space-y-4">
        <p className="text-sm leading-relaxed">{t('auth.rotated_elsewhere')}</p>
        <button
          type="button"
          onClick={leaveRotatedAccount}
          className="h-10 w-full rounded-md bg-accent text-white text-sm font-semibold"
        >
          {t('auth.rotated_elsewhere.enter')}
        </button>
      </div>
    </div>
  )
}
