// The island catalogue: what the phones draw as a carousel, printed as a list.
//
// The console cannot swipe through pictures, and it does not need to: what a
// person actually has to decide is WHICH island they register on, and the
// answer is a URL. So this prints the same catalogue the site publishes, in a
// numbered list, and lets `--island` take either a number from that list or a
// URL typed in full.
//
// ⚠ Display only, exactly like the site. This list is NOT the signed
// auto-island file the clients use to pick a fallback on a blocked network
// (`relay-config.ts`): a tampered catalogue must never be able to steer that.
// Here it only ever fills in a URL a person then chooses on purpose.

import { tr } from './i18n'
import { err, out } from './style'

const CATALOGUE_URL = 'https://rcq.app/servers.json'
/// The island every build points at with no flag. Named here so it can lead
/// the list even when the published catalogue does not carry it.
export const FLAGSHIP = 'https://api.rcq.app'

export interface Island {
  url: string
  name: string
  description?: string
  region?: string
}

/// The published catalogue, flagship first. Throws with a human sentence when
/// it cannot be read: on a blocked network this is one more thing that does
/// not answer, and "no islands" would read as "there are none".
export async function fetchIslands(): Promise<Island[]> {
  let body: unknown
  try {
    const res = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    body = await res.json()
  } catch (e) {
    throw new Error(tr('islands.unreachable', { err: e instanceof Error ? e.message : String(e) }))
  }
  const rows = Array.isArray(body) ? body : ((body as { servers?: unknown[] })?.servers ?? [])
  const list: Island[] = []
  for (const row of rows) {
    const r = row as Partial<Island>
    const url = typeof r.url === 'string' ? r.url.replace(/\/+$/, '') : ''
    if (!url.startsWith('https://')) continue // never offer a plaintext island
    list.push({ url, name: typeof r.name === 'string' ? r.name : url, description: r.description, region: r.region })
  }
  const flagship = list.find((i) => i.url === FLAGSHIP)
  const rest = list.filter((i) => i.url !== FLAGSHIP)
  return flagship ? [flagship, ...rest] : [{ url: FLAGSHIP, name: 'RCQ Flagship' }, ...rest]
}

/// The list as a person reads it: one island per two lines, numbered from 1.
export function renderIslands(list: Island[]): string {
  const lines: string[] = []
  list.forEach((isl, i) => {
    const n = String(i + 1).padStart(2, ' ')
    const host = isl.url.replace(/^https:\/\//, '')
    // The catalogue already calls the flagship "RCQ (default)"; adding our own
    // label there would print the same word twice in two languages.
    const named = /default|по умолчанию/i.test(isl.name)
    const tag = isl.url === FLAGSHIP && !named ? ` ${out.dim(tr('islands.flagship'))}` : ''
    lines.push(`${out.dim(n + '.')} ${isl.name}${tag}`)
    lines.push(`    ${out.dim(host)}${isl.region ? out.dim(` · ${isl.region}`) : ''}`)
    if (isl.description) lines.push(`    ${out.dim(isl.description.slice(0, 96))}`)
  })
  return lines.join('\n') + '\n'
}

/// Turn whatever `--island` carried into a URL.
///
/// A bare number is a row of the catalogue (so `rcq register --island 3` works
/// straight after `rcq islands`), anything else is taken as an address and only
/// normalised. Absent means the flagship, which is what every build did before
/// there was a catalogue at all.
export async function resolveIsland(raw: string | undefined): Promise<string> {
  const value = raw?.trim()
  if (!value) return FLAGSHIP
  if (/^\d+$/.test(value)) {
    const list = await fetchIslands()
    const pick = list[Number(value) - 1]
    if (!pick) throw new Error(tr('islands.noSuchNumber', { n: value, count: String(list.length) }))
    process.stderr.write(err.dim(tr('islands.picked', { name: pick.name, url: pick.url })) + '\n')
    return pick.url
  }
  const url = value.startsWith('http://') || value.startsWith('https://') ? value : `https://${value}`
  return url.replace(/\/+$/, '')
}
