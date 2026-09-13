// Which name goes on a group member (#982).
//
// The name above a group bubble used to come from the CURRENT roster only, and
// the island hard-deletes the membership row when somebody leaves, so every
// message a former member ever wrote turned into their number. The quote block
// under a reply kept the name, because a quote carries its author label inside
// the envelope. Worse, replying to such a message wrote the NUMBER into the new
// quote's author label, and that went out to everyone in the room.
//
// Pure on purpose: no storage, no React, so the order can be tested from the
// CLI bundle (cli/test/member-name.mjs).

export interface MemberNameSources {
  /// My own name for them. DEVICE-ONLY: the caller passes it for what the
  /// screen shows and never for anything that is sealed into an envelope.
  alias?: string | null
  /// The roster as it stands now.
  roster?: string | null
  /// The newest nickname any roster fetch of this group ever showed for them.
  lastKnown?: string | null
  /// Their nickname on my contact list, when they are on it.
  contact?: string | null
  /// The author label of a quote of one of their messages, found in what this
  /// chat has loaded.
  quoted?: string | null
}

function usable(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.trim() !== ''
}

/// A quote whose author label is only digits is a quote that was itself made
/// while the name was already lost: taking it would put the number back.
export function isNumberOnly(s: string): boolean {
  return /^\d+$/.test(s.trim())
}

/// alias -> roster -> last known -> contact -> quoted author -> the number.
export function memberName(uin: number, s: MemberNameSources): string {
  if (usable(s.alias)) return s.alias
  if (usable(s.roster)) return s.roster
  if (usable(s.lastKnown)) return s.lastKnown
  if (usable(s.contact)) return s.contact
  if (usable(s.quoted) && !isNumberOnly(s.quoted)) return s.quoted
  return `${uin}`
}

/// Author labels of quotes, per quoted member, out of the rows a chat holds.
///
/// `senders` are the received rows (who wrote which message id); `quoting` is
/// every row that may carry a quote, mine included. A quote of a message that
/// is not loaded names nobody we can tell, so it is skipped. The newest quote
/// wins, by `at`.
export function quotedAuthorNames(
  senders: ReadonlyArray<{ id: string; from: number }>,
  quoting: ReadonlyArray<{ at: number; replyTo?: { id: string; authorName: string } | null }>,
): Map<number, string> {
  const fromById = new Map<string, number>()
  for (const r of senders) fromById.set(r.id, r.from)
  const best = new Map<number, { at: number; name: string }>()
  for (const r of quoting) {
    const q = r.replyTo
    if (!q || !usable(q.authorName) || isNumberOnly(q.authorName)) continue
    const from = fromById.get(q.id)
    if (from == null) continue
    const cur = best.get(from)
    if (!cur || r.at >= cur.at) best.set(from, { at: r.at, name: q.authorName })
  }
  const out = new Map<number, string>()
  for (const [uin, v] of best) out.set(uin, v.name)
  return out
}
