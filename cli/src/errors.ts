// What a broken network is called on screen.
//
// Node words every transport failure as the same three characters of undici
// noise: `TypeError: fetch failed`, with the real cause tucked into `e.cause`.
// Offline, one send printed that string four times over (roster, drain, send,
// carbon) and not one of the four lines was a sentence. The rest of the client
// speaks in whole sentences, so the tail of every one of those lines was the
// only place it stopped.
//
// This translates the transport layer and NOTHING else: an island that answers
// with a real refusal keeps its own words, because "the island did not answer"
// would be a lie about a 403.

import { tr } from './i18n'

/// DNS and connection failures undici reports through `cause.code`. Kept apart
/// from the timeout case because "no such host" is a typo in an island URL and
/// "connection refused" is a server that is down, and a person can act on the
/// difference.
const NOT_FOUND = new Set(['ENOTFOUND', 'EAI_AGAIN'])

/// True when the failure was at the TRANSPORT level: nothing answered, rather
/// than something answering with a refusal. The route ladder wants exactly
/// this distinction - an island that says 403 is an island this road reaches,
/// while one that never answers may mean the road itself is gone.
export function isTransportFailure(e: unknown): boolean {
  if (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'TimeoutError') return true
  return e instanceof TypeError && e.message === 'fetch failed'
}

/// One line of plain language for anything thrown at the user.
export function humanError(e: unknown): string {
  // AbortSignal.timeout (see bootstrap.ts) rejects with a DOMException, which
  // is not an Error subclass on every runtime: test the shape, not the class.
  if (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'TimeoutError') {
    return tr('net.timeout')
  }
  if (e instanceof TypeError && e.message === 'fetch failed') {
    const code = (e as { cause?: { code?: string } }).cause?.code
    if (code && NOT_FOUND.has(code)) return tr('net.noHost')
    return tr('net.unreachable')
  }
  // An island's own refusal arrives as the raw JSON body, because a real
  // refusal keeps its own words (see the note at the top). That is right for
  // most of them and wrong for the door: `{"detail":{"code":"invite_required"}}`
  // tells a person nothing about what to do, and on a club island it is the
  // first thing they will ever see.
  const refusal = e instanceof Error ? describeRefusal(e.message) : null
  if (refusal) return refusal
  return e instanceof Error ? e.message : String(e)
}

/// Turn `{"detail":{"code":"..."}}` into a sentence, or null if it is not one.
export function describeRefusal(body: string): string | null {
  const text = (body || '').trim()
  if (!text.startsWith('{')) return null
  let code: string | undefined
  try {
    const parsed = JSON.parse(text) as { detail?: unknown }
    const d = parsed.detail
    if (typeof d === 'string') code = d
    else if (d && typeof d === 'object' && 'code' in d) code = String((d as { code: unknown }).code)
  } catch {
    return null
  }
  // An explicit map, not a computed key: `tr` takes a literal union, and a
  // dynamic lookup would also let any code the island invents reach for a
  // string that does not exist.
  if (code === 'invite_required') return tr('refusal.invite_required')
  if (code === 'invite_invalid') return tr('refusal.invite_invalid')
  return null
}
