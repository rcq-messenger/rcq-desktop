// What a person sees when the account this window is signed in as has moved to
// another number and this window could not follow it.
//
// The happy path never reaches here: the island confirms the move, the tab
// adopts the new number and reloads, and the only thing anyone notices is the
// reload. This is the other ending — the old number is not vacant any more, or
// the signing key is carried by more than one account and POST /auth/refresh
// refuses to guess which one (a handful of keys on the flagship are). Then the
// session really is over on this number and only the recovery phrase gets the
// person back in.
//
// ⚠⚠ It says "nothing was deleted" because nothing was. This screen is the
// deliberate opposite of the burn: no wipe, no IndexedDB clear, not even a
// sign-out. The way out of it clears the ACTIVE identity slot and leaves every
// message, every contact and every other account exactly where they are.

import { useIdentity } from '../lib/identity-context'
import { useI18n } from '../lib/i18n-context'

export function AccountMovedNotice() {
  const { movedStranded, followAccountMove, leaveMovedAccount } = useIdentity()
  const { t } = useI18n()

  // Almost always nothing: a follow that works ends in a reload, and the
  // identity provider deliberately does not raise this state for the attempt
  // itself. `busy` here is a RE-try, pressed by the person, and it keeps the
  // dialog on screen with the button disabled rather than blinking it away.
  if (!movedStranded) return null

  return (
    // Over everything, and no way past it: every request this window makes now
    // answers 401, so there is nothing behind this dialog that still works.
    // No backdrop-filter — a `fixed` child inside a blurred ancestor is
    // positioned against the ancestor in WebKit, and the desktop build is a
    // WebKit webview.
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-sm rounded-xl bg-surface text-fg-primary shadow-lg p-5 space-y-4">
        <h2 className="text-base font-semibold">{t('account_moved.title')}</h2>
        <p className="text-sm leading-relaxed text-fg-dim">
          {t('account_moved.body', { uin: movedStranded.from })}
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => followAccountMove()}
            disabled={movedStranded.busy}
            className="h-10 rounded-md bg-accent text-white text-sm font-semibold disabled:opacity-60"
          >
            {t('account_moved.retry')}
          </button>
          <button
            type="button"
            onClick={leaveMovedAccount}
            className="h-10 rounded-md bg-black/5 dark:bg-white/10 text-sm font-medium"
          >
            {t('account_moved.signin')}
          </button>
        </div>
      </div>
    </div>
  )
}
