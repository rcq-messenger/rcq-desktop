// Opening a referral link: `https://rcq.app/r/<uin>`, with `?h=<host>` for an
// inviter who lives on another island (the same shape as a contact link, and
// read by the same parser).
//
// A referral is two things at once, and which one it is depends on who opens
// it:
//
//  * Somebody without an account is who it is FOR. `/auth/register` takes
//    `inviter_uin` and makes the pair contacts of each other (auth.py,
//    `_connect_inviter`), so the inviter is noted for the create pane and the
//    link itself is remembered as the place to come back to (login-return.ts).
//    A person who restores an existing account instead gets no connection from
//    the island, which is why the way back is this route and not the contact
//    list: signed in, it becomes the next case.
//  * Somebody already signed in has nothing to register, so the link is just a
//    number to add. It goes to the ordinary Add screen, like `/u/<uin>` does.
import { useEffect } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { isFlagship, parseContactLink } from '../lib/federation'
import { useIdentity } from '../lib/identity-context'
import { islandLabel } from '../lib/island-choice'
import { forgetInviter, rememberInviter, rememberReturnTo } from '../lib/login-return'
import { defaultHome } from '../lib/routing'

export function ReferralLink() {
  const { uin } = useParams()
  const [search] = useSearchParams()
  const { identity } = useIdentity()

  let inviterUin: number | null = null
  let inviterHost: string | null = null
  try {
    const { address } = parseContactLink(uin ?? '', search.toString())
    if (Number.isSafeInteger(address.uin) && address.uin > 0) {
      inviterUin = address.uin
      inviterHost = address.host
    }
  } catch {
    /* a link we cannot read is a link we do not act on */
  }

  const signedIn = identity != null
  const ownHost = identity ? islandLabel(identity.apiBase).replace(/\/+$/, '').toLowerCase() : null

  // ⚠ Primitive deps only (numbers, strings, a boolean). `identity` is a new
  // object on every token refresh, and an effect keyed on it would re-run for
  // nothing; nothing here sets state, but the habit is what keeps it that way.
  useEffect(() => {
    if (inviterUin == null || inviterHost == null) return
    if (signedIn) {
      // An account exists, so no registration will spend the note.
      forgetInviter()
      return
    }
    rememberInviter(inviterUin, inviterHost)
    // Only `h` survives into the way back, and only when it is not the
    // flagship: nothing else in the query means anything to this route.
    rememberReturnTo(`/r/${inviterUin}${isFlagship(inviterHost) ? '' : `?h=${encodeURIComponent(inviterHost)}`}`)
  }, [inviterUin, inviterHost, signedIn])

  if (inviterUin == null || inviterHost == null) return <Navigate to="/" replace />
  if (!signedIn) return <Navigate to="/" replace />
  // Following your own link has nobody to add.
  if (inviterUin === identity.uin && inviterHost === ownHost) return <Navigate to={defaultHome()} replace />
  // ⚠ `#123` on our own island, `123@host` on anyone else's. A bare number
  // would search THIS island for it, which for an inviter from another island
  // finds a stranger who happens to hold the same number; `#` is the island's
  // own "exactly this number" (users.py, search), and `@host` is what opens the
  // cross-island row on the Add screen.
  const q = inviterHost === ownHost ? `#${inviterUin}` : `${inviterUin}@${inviterHost}`
  return <Navigate to={`/add?${new URLSearchParams({ q })}`} replace />
}
