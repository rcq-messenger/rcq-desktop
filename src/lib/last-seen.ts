/**
 * The humanised "last seen".
 *
 * ⚠ Buckets with WORDS, not numbers, and that is the point (founder, 31.08).
 * "was here 47 minutes ago" is an activity pattern: read it a few times a day
 * and you know when someone wakes up, when they commute and when they sleep.
 * Nobody needs that to decide whether to write to them — "recently" answers
 * the same question. The island already floors what it serves to the hour
 * (`coarse_last_seen`, A7), so the minutes were never real anyway; this stops
 * the client from dressing a floored hour up as precision it does not have.
 *
 * The island still gates the timestamp by the peer's `last_seen_visibility`
 * (null = hidden, and online users get null too), so callers only ever format
 * what they were allowed to see. Live "online" is the status field, not this.
 */
export function relativeLastSeen(
  iso: string,
  t: (k: string, vars?: Record<string, string | number>) => string,
  _lang: string,
): string {
  const date = new Date(iso)
  const now = new Date()
  const secs = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000))
  if (secs < 3600) return t('contact.last_seen.recently')

  // Calendar days, not 24-hour blocks: "yesterday" has to mean yesterday to a
  // person, not "between 24 and 48 hours ago".
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const seenAt = date.getTime()
  if (seenAt >= midnight) return t('contact.last_seen.today')
  if (seenAt >= midnight - 86400_000) return t('contact.last_seen.yesterday')
  if (seenAt >= midnight - 6 * 86400_000) return t('contact.last_seen.this_week')
  if (seenAt >= midnight - 29 * 86400_000) return t('contact.last_seen.this_month')
  return t('contact.last_seen.long_ago')
}
