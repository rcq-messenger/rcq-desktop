/// Who this account is talking to in a random chat, as seen from a device that
/// has no random chat of its own.
///
/// ⚠⚠ THE WEB AND THE DESKTOP HAVE NO RANDOM CHAT, AND THAT IS EXACTLY WHY THIS
/// EXISTS. A random-chat message is an ordinary sealed 1:1 envelope — nothing
/// on the wire marks it, because the island must not be able to tell either —
/// and undelivered queue rows go to EVERY device of the account. So a phone in
/// a random chat had its anonymous conversation written into a permanent
/// ordinary thread on the owner's web session, with the stranger's number in
/// the roster and their nickname fetched a moment later. Not after the session
/// ended, as on the phones: from the first message, while it was still running.
///
/// Whoever had the web open had no anonymity in random chat at all.
///
/// The island tells every device of the account when a pair starts and ends
/// (`random_match` / `random_end`, fanned out to all sessions), so this device
/// can know who to ignore without ever being able to join the conversation.
///
/// ⚠ Persisted, because a reload is not a session boundary: the queue row that
/// leaks is drained on the next load. Numbers and timestamps only, swept after
/// a day — long enough to cover anything still in flight, short enough that it
/// never becomes a list of who somebody talked to.

const KEY = 'rcq.random.peers'

/// How long after a session ends a message from that stranger is still treated
/// as belonging to the session that is over. Matches the phones.
const GRACE_MS = 24 * 60 * 60 * 1000

type Store = { active: number | null; ended: Record<string, number> }

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { active: null, ended: {} }
    const p = JSON.parse(raw) as Store
    return { active: typeof p.active === 'number' ? p.active : null, ended: p.ended ?? {} }
  } catch {
    return { active: null, ended: {} }
  }
}

function write(s: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* a private window with no storage still gets the in-tab behaviour below */
  }
}

let memo: Store | null = null

function store(): Store {
  if (!memo) memo = read()
  return memo
}

function save(s: Store): void {
  memo = s
  write(s)
}

/// A pair started. Called from the `random_match` frame.
export function randomMatched(peerUIN: number): void {
  const s = store()
  save({ ...s, active: peerUIN })
}

/// A pair ended, from either side. Called from `random_end`.
export function randomEnded(): void {
  const s = store()
  if (s.active == null) return
  const ended = { ...s.ended, [String(s.active)]: Date.now() }
  save({ active: null, ended: prune(ended) })
}

function prune(ended: Record<string, number>): Record<string, number> {
  const cutoff = Date.now() - GRACE_MS
  const out: Record<string, number> = {}
  for (const [uin, at] of Object.entries(ended)) if (at > cutoff) out[uin] = at
  return out
}

/// Should a message from this number be dropped rather than filed?
///
/// ⚠ `isContact` is asked by the caller and it matters: two people CAN swap
/// contacts during a random chat, and once they have they are not strangers.
/// Dropping their messages would break the one feature that lets a random chat
/// become a real conversation.
export function isRandomTraffic(senderUIN: number, isContact: boolean): boolean {
  if (isContact) return false
  const s = store()
  if (s.active === senderUIN) return true
  const at = s.ended[String(senderUIN)]
  return typeof at === 'number' && Date.now() - at < GRACE_MS
}

/// Signing out clears it with everything else: it is per-account state.
export function clearRandomPeers(): void {
  memo = null
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}
