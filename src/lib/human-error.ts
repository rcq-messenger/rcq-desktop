// What a failure says to the person, as opposed to what it says to us.
//
// `ApiError.message` is `${status}: ${body}`, which is the right thing for a
// log and the wrong thing for a chat bubble. On 13.09.2026 the island ran out
// of database connections for six minutes and every failed send in every
// client carried the line
//
//     500: {"detail":"internal_error"}
//
// in red, under the founder's own message, in front of two thousand people.
// His note: "ещё и ошибка выглядит не для глаз человека".
//
// So the raw string stays on the Error (nothing here throws it away, and the
// console still gets it) and the UI asks for this instead. The mapping is
// deliberately coarse: a person needs to know whether to wait, to fix
// something, or to give up, and nothing finer than that is actionable.
//
// ⚠ Not every failure has a status. `fetch` rejects with a TypeError when the
// request never reached anyone, which is the ordinary case on a phone in a
// lift, and it must not read as "the island is broken".

import { ApiError } from './api'

type T = (key: string, vars?: Record<string, string | number>) => string

/// The i18n key for a failure, or null when the error already carries a
/// sentence somebody wrote on purpose (a thrown `new Error(t(...))`).
function keyFor(e: unknown): string | null {
  if (e instanceof ApiError) {
    // 429 arrives with its own retry-after handling upstream; if it reaches
    // here, say the same thing without a number rather than invent one.
    if (e.status === 429) return 'err.busy_rate'
    if (e.status === 401 || e.status === 403) return 'err.not_allowed'
    if (e.status === 413) return 'err.too_big'
    if (e.status === 404) return 'err.gone'
    // 502/503/504 are the island being restarted or overloaded, 500 is it
    // failing at something. From here they are one thing: not your fault,
    // try again shortly.
    if (e.status >= 500) return 'err.island_busy'
    if (e.status >= 400) return 'err.rejected'
    return 'err.unknown'
  }
  // fetch's own failure: DNS, TLS, no route, blocked. Distinguishable from a
  // server error only here, and the difference is the whole advice.
  if (e instanceof TypeError) return 'err.no_connection'
  return null
}

/// A sentence to show a person. Pass the `t` from useI18n.
///
/// An Error whose message somebody already wrote for a human (every
/// `throw new Error(t('chat.error.…'))` in this codebase) is returned as it
/// is: this function only rescues the ones that were never meant to be read.
export function humanError(e: unknown, t: T, fallbackKey = 'err.unknown'): string {
  const key = keyFor(e)
  if (key) return t(key)
  if (e instanceof Error && e.message && !/^\d{3}: /.test(e.message)) return e.message
  return t(fallbackKey)
}
