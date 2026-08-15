// @-mentions: the one vocabulary the whole client agrees on.
//
// The web knew about mentions in exactly one place — the pinned banner turned
// `#<uin>` into a name — and nowhere else. A message that called you by name in
// a group of forty looked like every other message, there was no way to reach
// it, and typing a name meant typing it exactly right by hand. Both phones have
// had the full set for months; this is the same set, so a group behaves the
// same wherever you read it.
//
// Two forms are mentions, matching `Session.bodyMentionsMe` on Android and the
// iOS reader:
//   • `@<nickname>` — what people type. Nicks contain spaces and punctuation
//     (".:example", "JO f3 JO"), so this cannot be a word regex: it is a
//     LONGEST-MATCH against the group roster, anchored at the '@'.
//   • `#<uin>` — what a link or a pin carries. Unambiguous, always resolvable.

import { useSyncExternalStore } from 'react'
import { scopedKey } from './account-scope'

/// A member as far as mentions care: a number and a name.
export interface MentionRoster {
  uin: number
  nickname: string
}

/// Longest roster nick that follows the '@' at `at`, or null.
///
/// Longest wins so that "@Ann" inside a roster holding both "Ann" and "Anna"
/// resolves to Anna when the text says Anna. The trailing boundary is what
/// keeps "@bob" from lighting up inside "@bobsled".
export function matchMentionAt(
  body: string,
  at: number,
  roster: MentionRoster[],
): { uin: number; length: number } | null {
  const after = body.slice(at + 1)
  const lower = after.toLowerCase()
  let best: { uin: number; length: number } | null = null
  for (const m of roster) {
    const nick = m.nickname
    if (!nick) continue
    if (!lower.startsWith(nick.toLowerCase())) continue
    if (best && nick.length <= best.length) continue
    const tail = after.charAt(nick.length)
    // A letter or digit right after means the nick was only a prefix of a
    // longer word, not a mention.
    if (tail && /[\p{L}\p{N}]/u.test(tail)) continue
    best = { uin: m.uin, length: nick.length }
  }
  return best
}

/// Does this body call ME by name? Mirrors Android `bodyMentionsMe`: either my
/// number or my nickname, the nickname case-insensitively.
export function mentionsMe(body: string, myUin: number, myNick?: string | null): boolean {
  if (!body) return false
  if (body.includes(`#${myUin}`)) return true
  const nick = (myNick || '').trim()
  if (!nick) return false
  return body.toLowerCase().includes(`@${nick.toLowerCase()}`)
}

// ── The @ inbox: groups that called your name while you were elsewhere ──
//
// Kept per account, and only for GROUPS: a 1:1 body cannot mention you as a
// third party, so the marker would mean nothing there. Same gate Android uses.

const INBOX_KEY = () => scopedKey('mention.inbox')
const SEEN_KEY = () => scopedKey('mention.seen')

let inbox: Set<string> | null = null
let seen: Record<string, number> | null = null
const listeners = new Set<() => void>()
let version = 0

function loadInbox(): Set<string> {
  if (inbox) return inbox
  try {
    const raw = JSON.parse(localStorage.getItem(INBOX_KEY()) || '[]') as unknown
    inbox = new Set(Array.isArray(raw) ? (raw as string[]) : [])
  } catch {
    inbox = new Set()
  }
  return inbox
}

function loadSeen(): Record<string, number> {
  if (seen) return seen
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY()) || '{}') as unknown
    seen = raw && typeof raw === 'object' ? (raw as Record<string, number>) : {}
  } catch {
    seen = {}
  }
  return seen
}

function emit() {
  version++
  for (const l of listeners) l()
}

export function subscribeMentions(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function mentionsVersion(): number {
  return version
}

/// Raise the marker on a group. Called from the receive path for an inbound
/// group message that mentions me and is not in the thread I am looking at.
export function markMention(groupId: number): void {
  const s = loadInbox()
  if (s.has(`g:${groupId}`)) return
  s.add(`g:${groupId}`)
  try {
    localStorage.setItem(INBOX_KEY(), JSON.stringify([...s]))
  } catch {
    /* quota — the marker is cosmetic, the message is not lost */
  }
  emit()
}

export function clearMention(groupId: number): void {
  const s = loadInbox()
  if (!s.delete(`g:${groupId}`)) return
  try {
    localStorage.setItem(INBOX_KEY(), JSON.stringify([...s]))
  } catch {
    /* quota */
  }
  emit()
}

export function hasMention(groupId: number): boolean {
  return loadInbox().has(`g:${groupId}`)
}

/// The marker, for a row in the chat list.
export function useHasMention(groupId: number | null): boolean {
  return useSyncExternalStore(subscribeMentions, () =>
    groupId == null ? false : loadInbox().has(`g:${groupId}`),
  )
}

/// Newest mention this group has already shown me, epoch ms. The jump button
/// counts only what is newer, so re-opening a chat does not offer to walk you
/// through mentions you have already read.
export function mentionSeenAt(groupId: number): number {
  return loadSeen()[String(groupId)] ?? 0
}

/// Move the cut-off forward. Monotonic on purpose — a stale render calling
/// this with an older timestamp must not resurrect what was read.
export function markMentionSeen(groupId: number, at: number): void {
  if (!Number.isFinite(at) || at <= 0) return
  const s = loadSeen()
  const key = String(groupId)
  if ((s[key] ?? 0) >= at) return
  s[key] = at
  try {
    localStorage.setItem(SEEN_KEY(), JSON.stringify(s))
  } catch {
    /* quota */
  }
  emit()
}

/// Drop the caches when the account changes (the identity provider reloads the
/// page on a switch, but a signed-out tab keeps the module alive).
export function resetMentionState(): void {
  inbox = null
  seen = null
  emit()
}
