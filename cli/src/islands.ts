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
import {
  AddressError,
  describeAddressProblem,
  describeTrust,
  describeTypedDisagreement,
  listRecords,
  parseIslandAddress,
  pinTyped,
  recordFor,
  trustIsland,
  trustJson,
} from './island-trust'
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
  // ⚠ Before the fetch, and not because rcq.app is an island - it is never
  // pinned. `islands` is trust-free, so nothing else asks, and a pinned
  // island's certificate is a CA:TRUE anchor for EVERY host in this process
  // (see the head of island-trust.ts). This is the one check that keeps a
  // pinned operator from serving their own rcq.app: the probe judges a
  // CA-only host against the platform roots alone. Free when nothing is
  // pinned - no anchors, no handshake. The refusal has already been printed.
  const gate = await trustIsland(CATALOGUE_URL)
  if (gate === 'refused' || gate === 'unpinnable') process.exit(1)
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

/// The store key of an island URL, or null for one that does not parse.
function trustKey(url: string): string | null {
  const a = parseIslandAddress(url)
  return 'error' in a || a.plain ? null : a.key
}

/// How the trust store knows this island, for the JSON rows.
export function islandTrust(url: string): Record<string, unknown> | null {
  const key = trustKey(url)
  return key ? trustJson(key, recordFor(key)) : null
}

/// The list as a person reads it: one island per two lines, numbered from 1,
/// with how this device trusts it when it has met it. Islands on file that
/// the catalogue does not list (a self-hosted one, a visited room's) follow,
/// unnumbered: the numbers are `--island`'s and count the catalogue only.
export function renderIslands(list: Island[]): string {
  const lines: string[] = []
  const seen = new Set<string>()
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
    const key = trustKey(isl.url)
    if (key) {
      seen.add(key)
      const rec = recordFor(key)
      if (rec) lines.push(`    ${out.dim(describeTrust(rec))}`)
    }
  })
  const known = listRecords().filter(({ key }) => !seen.has(key))
  if (known.length > 0) {
    lines.push(out.dim(tr('islands.known')))
    for (const { key, rec } of known) {
      lines.push(`    ${key.replace(/:443$/, '')}`)
      lines.push(`    ${out.dim(describeTrust(rec))}`)
    }
  }
  return lines.join('\n') + '\n'
}

/// `--island <address>` as an address (a number is the catalogue's business):
/// parsed, and when it carries a fingerprint, pinned BEFORE anything dials
/// (§3 of the island-fingerprint design). An address that cannot be used is
/// an AddressError, which the dispatcher turns into a usage exit: nothing
/// was dialled. A fragment against a record that disagrees is a refusal
/// with both values, never a silent write.
export function islandFromAddress(raw: string): string {
  const addr = parseIslandAddress(raw)
  if ('error' in addr) throw new AddressError(describeAddressProblem(addr))
  if (addr.fp) {
    const typed = pinTyped(addr.key, addr.fp)
    if (typeof typed === 'object') throw new Error(describeTypedDisagreement(addr.key, typed.disagrees, addr.fp))
    if (typed === 'written') {
      process.stderr.write(err.dim(tr('island.trust.typed', { host: addr.key.replace(/:443$/, '') })) + '\n')
    }
  }
  return addr.url
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
  return islandFromAddress(value)
}
