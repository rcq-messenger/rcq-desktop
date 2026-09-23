/// When a received message is shown as sent, when its envelope does not say.
///
/// ⚠⚠ The moment THIS device filed a row is not when anybody sent it (#1039).
/// A desktop started in the morning drains the night's queue in one go, and
/// every row filed that way carried the drain time: two voice notes sent at
/// 23:18 the evening before sat in the conversation at 09:40, the minute the
/// app was started, the other person's and the one sent from our own phone
/// alike. The envelope's `ts` would settle it, but all three clients put `ts`
/// on the wire only beside a `ttl`, so ordinary traffic never has one. The
/// queue row does have the island's deposit stamp (`received_at`, read by
/// `serverStampMs`), and for a row that sat in a queue overnight that is far
/// nearer the send than the drain. Android files a drained row at exactly that
/// stamp (`Session.disappearAnchorMs`), iOS at the same one.
///
/// ⚠ Only for a row that arrived LATE, not for every row that has a stamp. A
/// live frame carries the island's `server_time` as well, while our own
/// outgoing rows are stamped with THIS computer's clock. On a machine whose
/// clock runs a few minutes fast, moving live incoming rows onto the island's
/// clock would sort a reply above the message it answers, in a live
/// conversation that reads correctly today. A row that reached us within this
/// margin of its stamp keeps the local clock, exactly as before; a backlog
/// that waited longer takes the island's stamp. Android draws the same line by
/// path (live at `now`, drained at the deposit), which a row already persisted
/// here can no longer tell; the margin can, so it also corrects rows filed
/// before this existed.
export const LATE_ARRIVAL_MS = 5 * 60_000

/// `receivedMs` (this device's clock when the row was filed), or the island's
/// stamp when the row reached us more than `LATE_ARRIVAL_MS` after it was
/// deposited. `srvAt` only ever comes out of `serverStampMs`, which already
/// refuses a stamp from the future or an absurdly old one.
export function arrivalAnchorMs(receivedMs: number, srvAt: number | undefined): number {
  if (srvAt == null || !Number.isFinite(srvAt)) return receivedMs
  // ⚠⚠ Compared and returned in THIS device's clock, never the island's. Our
  // own outgoing rows are stamped with the local clock, so an island stamp
  // used raw would sort against them with the whole skew between the two
  // clocks folded in. A computer running six minutes fast put every live
  // incoming row onto the island's clock and every reply above the message it
  // answered — caught by the review of this change before it shipped.
  const srvLocal = srvAt + clockOffsetMs()
  return receivedMs - srvLocal > LATE_ARRIVAL_MS ? srvLocal : receivedMs
}

// ── how far this device's clock is from the island's ─────────────────────
//
// The island answers every socket ping with `{type:"pong", t:<its own UTC
// now>}`, and the web pings every 25 seconds, so a sample of its clock arrives
// all the time at no cost. One sample is `localArrival - islandSend`, which is
// the offset PLUS however long the frame took to arrive; that latency is never
// negative, so the smallest sample over a recent window is the offset with the
// least latency folded in. The window is what lets the estimate follow the
// computer's own clock when it is corrected underneath us (an NTP sync, the
// person fixing the time by hand).
//
// Until the first sample the offset is zero, which is exactly the behaviour
// before this existed; a rendered row re-reads it every time it is drawn.

const OFFSET_WINDOW_MS = 10 * 60_000
let offsetSamples: Array<{ at: number; d: number }> = []
let offsetMs = 0

/// Feed one island stamp paired with the local moment it arrived. Anything
/// unparseable is ignored rather than guessed at.
export function noteIslandClock(islandIso: unknown, localMs: number = Date.now()): void {
  if (typeof islandIso !== 'string') return
  const island = Date.parse(islandIso)
  if (!Number.isFinite(island) || island <= 0) return
  offsetSamples.push({ at: localMs, d: localMs - island })
  offsetSamples = offsetSamples.filter((x) => localMs - x.at <= OFFSET_WINDOW_MS)
  offsetMs = Math.min(...offsetSamples.map((x) => x.d))
}

/// This device's clock minus the island's, as well as it is known right now.
/// Zero until the island has been heard from.
export function clockOffsetMs(): number {
  return offsetMs
}

/// For tests only: forget every sample.
export function resetIslandClock(): void {
  offsetSamples = []
  offsetMs = 0
}
