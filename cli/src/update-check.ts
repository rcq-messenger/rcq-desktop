// "Is there a newer rcq?" — asked of GitHub at most once a day, answered on
// stderr, never in anyone's way. The CLI does not self-update (one file,
// installed by hand), so the whole job is to KNOW and to SAY: which version
// this is, that a newer tag exists, and the one command that fetches it.
//
// Discipline: TTY-only (a cron job must never see it), stderr-only (stdout is
// data), best-effort with a short timeout (an offline box must not feel it),
// and cached in the state dir so a chatty day costs one request.

import fs from 'node:fs'
import { statePath, writeFileAtomic } from './state'
import { err } from './style'
import { CLI_VERSION } from './version'

const RELEASES_API = 'https://api.github.com/repos/rcq-messenger/rcq-cli/releases/latest'
export const RELEASES_URL = 'https://github.com/rcq-messenger/rcq-cli/releases/latest'
const CACHE_FILE = 'update-check.json'
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000

interface CacheShape {
  checkedAt: number
  latest: string
}

/// 1 if a > b, -1 if a < b, 0 if equal — plain dotted-number compare, which
/// is all our tags ever are (v0.2.4).
function cmpVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

function readCache(): CacheShape | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(CACHE_FILE), 'utf8')) as CacheShape
    if (typeof raw.checkedAt === 'number' && typeof raw.latest === 'string') return raw
  } catch {
    /* no cache yet, or unreadable — both mean "ask" */
  }
  return null
}

/// The newest released version, from cache when fresh, from GitHub otherwise.
/// Null when unknown (offline, rate-limited) — never throws.
export async function latestVersion(force = false): Promise<string | null> {
  const cached = readCache()
  if (!force && cached && Date.now() - cached.checkedAt < CHECK_EVERY_MS) return cached.latest
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `rcq-cli/${CLI_VERSION}` },
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) return cached?.latest ?? null
    const body = (await res.json()) as { tag_name?: string }
    const latest = (body.tag_name ?? '').replace(/^v/, '')
    if (!latest) return cached?.latest ?? null
    writeFileAtomic(statePath(CACHE_FILE), JSON.stringify({ checkedAt: Date.now(), latest }))
    return latest
  } catch {
    return cached?.latest ?? null
  }
}

/// Print the update notice if one is due. Fire-and-forget from the long-lived
/// modes (interactive, watch); awaited by --version. Quiet unless BOTH ends
/// are a TTY — pipes and cron stay byte-clean.
export async function noteUpdateIfAny(force = false): Promise<void> {
  if (!force && (!process.stderr.isTTY || !process.stdin.isTTY)) return
  const latest = await latestVersion(force)
  if (!latest || cmpVersions(latest, CLI_VERSION) <= 0) return
  process.stderr.write(
    err.yellow(`update: v${CLI_VERSION} -> v${latest}`) +
      err.dim(` ${RELEASES_URL}\n  (download rcq.tar.gz, unpack over the old install; state and account stay)`) +
      '\n',
  )
}
