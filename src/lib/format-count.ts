/// Compact counts for places that show "how many people" (founder item 27).
///
/// A group of 12 480 printed in full is nine characters of noise in a header
/// that is mostly a name, and it wraps the chat-list row on a narrow window.
/// Every messenger shortens it; the thresholds are the whole of the contract,
/// which is why they live here rather than inline at a call site: iOS and
/// Android are expected to mirror THIS file's rules exactly, so the same room
/// never reads "9,999" on one client and "10K" on another.
///
/// The rules, in full:
///   • below 1000            → the exact number. 999 is "999", not "1K".
///   • 1000 and above        → thousands with ONE decimal, and the decimal is
///                             dropped when it is zero: 1000 → "1K",
///                             1100 → "1.1K", 12 480 → "12.4K".
///   • 1 000 000 and above   → the same shape on "M": 1 500 000 → "1.5M".
///
/// ⚠ TRUNCATED, never rounded (decided 2026-08-23; the web rounded and Android
/// truncated, so the same room read "2K" here and "1.9K" there). A member count
/// that reads HIGHER than the room actually is claims people who are not in it:
/// 1999 members shown as "2K" is a room one person short of a number it never
/// reached, and every screen that prints this is a factual statement about who
/// is present. Reading low is the honest direction: "1.9K" is true of every
/// room from 1900 to 1999. So: 1949 → "1.9K", 1950 → "1.9K", 1999 → "1.9K",
/// 2000 → "2K".
///
/// ⚠ The exact rule the phones mirror, in integer arithmetic only (no
/// floating-point rounding mode to agree on):
///
///     tenths = n * 10 / unit        // integer division, truncating
///     whole  = tenths / 10          // integer division
///     frac   = tenths % 10
///     text   = frac == 0 ? "{whole}{suffix}" : "{whole}.{frac}{suffix}"
///
/// with `unit` = 1000 / suffix "K" for 1000 ≤ n < 1 000 000, and `unit` =
/// 1 000 000 / suffix "M" from 1 000 000 up. Kotlin's `Int`/`Long` division and
/// Swift's `Int` division both truncate toward zero, so both phones get this by
/// writing the four lines above literally. Worked boundaries, all three clients
/// must agree: 999 → "999", 1000 → "1K", 1001 → "1K", 1999 → "1.9K",
/// 9999 → "9.9K", 999 999 → "999.9K", 1 000 000 → "1M", 1 999 999 → "1.9M".
///
/// ⚠ The suffixes are NOT translated. They are the same two letters on every
/// client and in every language we ship, the way a unit symbol is; a localised
/// "тыс." here would disagree with the phones on the same screen.

const K = 1000
const M = 1000 * 1000

function short(n: number, unit: number, suffix: string): string {
  // Truncated tenths, computed as integers: `n * 10 / unit` on two whole
  // numbers, not `(n / unit) * 10` on a float. Same answer for every count a
  // room can have, and it is the form the phones can copy verbatim.
  const tenths = Math.floor((n * 10) / unit)
  const whole = Math.floor(tenths / 10)
  const frac = tenths % 10
  // The zero decimal is dropped rather than printed: "1K", never "1.0K".
  return frac === 0 ? `${whole}${suffix}` : `${whole}.${frac}${suffix}`
}

/// The compact form of a count. Negative or non-finite input is treated as 0:
/// a member count is never either, and a stray NaN in a header is worse than a
/// zero.
export function compactCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  const v = Math.floor(n)
  if (v < K) return String(v)
  // ⚠ No "did it spill into the next unit" guard here any more, and none is
  // needed: truncation cannot carry. Rounding could (999 950 rounded to
  // "1000K"), which is why one used to sit on this branch; the largest value
  // this branch can see is 999 999 and it truncates to "999.9K".
  if (v < M) return short(v, K, 'K')
  return short(v, M, 'M')
}
