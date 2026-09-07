// Opening a shared contact link: `https://rcq.app/u/<uin>?h=<host>#c=<card>`.
//
// ⚠⚠ THE FRAGMENT IS THE POINT. A guest card is a live credential with no
// expiry, so it rides after the hash, where no server ever sees it: not
// rcq.app, not the CDN in front of it, not a Referer. This route is what
// finally reads it in the browser and on the desktop — until now the card in a
// link reached the phones and nothing else, because this app had no route for
// its own share link at all.
//
// It stores the card FIRST and routes to Add second, on purpose: a person who
// looks at the confirm screen and closes it has still been given the only way
// to reach that person on a closed island, and asking them to find the link
// again is asking for something they may not have.
import { useEffect } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { parseContactLink } from '../lib/federation'
import { rememberTheirCard } from '../lib/guest-card'

export function ContactLink() {
  const { uin } = useParams()
  const [search] = useSearchParams()
  let target: string | null = null
  let host: string | null = null

  try {
    const parsed = parseContactLink(uin ?? '', search.toString(), window.location.hash)
    target = String(parsed.address.uin)
    host = parsed.address.host
    // Stored outside the effect would run twice under StrictMode; stored inside
    // an effect would race the redirect below. It is idempotent either way —
    // the store compares before writing — so the effect is the honest home.
    var card = parsed.card ?? null
  } catch {
    /* a link we cannot read is a link we do not act on */
  }

  useEffect(() => {
    if (target && card) rememberTheirCard(Number(target), host, card)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, host])

  if (!target) return <Navigate to="/" replace />
  // Hand the address to the ordinary add screen rather than duplicating its
  // logic: it already knows how to tell a same-island number from `uin@host`,
  // and it is where the "this island is closed" sentence lives.
  const q = new URLSearchParams({ q: host ? `${target}@${host}` : target })
  return <Navigate to={`/add?${q}`} replace />
}
