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
  return e instanceof Error ? e.message : String(e)
}
