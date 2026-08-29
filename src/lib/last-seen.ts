/**
 * The humanised "last seen" (megalist B1). The exact buckets of the iOS
 * client's `relativeLastSeen` — just now / minutes / hours / days, and a
 * short localised date past a week — so the same person reads the same on
 * every client. The island already gates the timestamp by the peer's
 * `last_seen_visibility` (null = hidden, and online users get null too), so
 * callers only ever format what they were allowed to see.
 */
export function relativeLastSeen(
  iso: string,
  t: (k: string, vars?: Record<string, string | number>) => string,
  lang: string,
): string {
  const date = new Date(iso)
  const secs = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (secs < 60) return t('contact.last_seen.just_now')
  const mins = Math.floor(secs / 60)
  if (mins < 60) return t('contact.last_seen.minutes', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('contact.last_seen.hours', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return t('contact.last_seen.days', { n: days })
  return date.toLocaleDateString(lang === 'ru' ? 'ru-RU' : undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}
