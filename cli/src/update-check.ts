// "Is there a newer rcq?" — asked of GitHub at most once a day, answered on
// stderr, never in anyone's way. The CLI does not self-update (one file,
// installed by hand), so the whole job is to KNOW and to SAY: which version
// this is, that a newer tag exists, and the one command that fetches it.
//
// Discipline: TTY-only (a cron job must never see it), stderr-only (stdout is
// data), best-effort with a short timeout (an offline box must not feel it),
// and cached in the state dir so a chatty day costs one request.
//
// ⚠ This is the FIRST packet of a session, and it goes to api.github.com,
// which on a censored network is blocked exactly like everything else. Three
// rules follow, all of them here:
//   * it rides the proxy. Nothing in this file knows that: `rcq proxy` re-execs
//     the whole process behind the proxy before any of this runs (proxy.ts), so
//     the global fetch below is already proxied.
//   * it never blocks. Every caller but `--version` fires it and forgets it.
//   * a failure is REMEMBERED for an hour. Without that, a box that cannot
//     reach GitHub opens a doomed connection to it on every single command.
// RCQ_NO_UPDATE_CHECK=1 turns the whole thing off, for a session that should
// touch nobody but the island.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tr } from './i18n'
import { statePath, writeFileAtomic } from './state'
import { err } from './style'
import { CLI_VERSION } from './version'

const RELEASES_API = 'https://api.github.com/repos/rcq-messenger/rcq-cli/releases/latest'
export const RELEASES_URL = 'https://github.com/rcq-messenger/rcq-cli/releases/latest'
const CACHE_FILE = 'update-check.json'
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
/// How long a failed ask is remembered. Short enough that a laptop which was
/// offline at breakfast still learns about a release by lunch.
const RETRY_AFTER_FAIL_MS = 60 * 60 * 1000

interface CacheShape {
  checkedAt: number
  latest: string
  /// When the last attempt failed (offline, blocked, rate-limited). Absent
  /// once one has succeeded.
  failedAt?: number
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
  if (process.env.RCQ_NO_UPDATE_CHECK) return null
  const cached = readCache()
  if (!force && cached?.failedAt && Date.now() - cached.failedAt < RETRY_AFTER_FAIL_MS) return cached.latest || null
  if (!force && cached && Date.now() - cached.checkedAt < CHECK_EVERY_MS) return cached.latest || null
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `rcq-cli/${CLI_VERSION}` },
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) return noteFailure(cached)
    const body = (await res.json()) as { tag_name?: string }
    const latest = (body.tag_name ?? '').replace(/^v/, '')
    if (!latest) return noteFailure(cached)
    writeFileAtomic(statePath(CACHE_FILE), JSON.stringify({ checkedAt: Date.now(), latest }))
    return latest
  } catch {
    return noteFailure(cached)
  }
}

/// Remember that the ask did not work, keeping whatever answer we had. Best
/// effort in both directions: a state dir that cannot be written just means
/// the next command tries again.
function noteFailure(cached: CacheShape | null): string | null {
  try {
    writeFileAtomic(
      statePath(CACHE_FILE),
      JSON.stringify({ checkedAt: cached?.checkedAt ?? 0, latest: cached?.latest ?? '', failedAt: Date.now() }),
    )
  } catch {
    /* not worth a word to anybody */
  }
  return cached?.latest || null
}

/// Print the update notice if one is due. Fire-and-forget from the long-lived
/// modes (interactive, watch); awaited by --version. Quiet unless BOTH ends
/// are a TTY — pipes and cron stay byte-clean.
export async function noteUpdateIfAny(force = false): Promise<void> {
  if (process.env.RCQ_NO_UPDATE_CHECK) return
  if (!force && (!process.stderr.isTTY || !process.stdin.isTTY)) return
  const latest = await latestVersion(force)
  if (!latest || cmpVersions(latest, CLI_VERSION) <= 0) return
  process.stderr.write(
    err.yellow(tr('update.available', { from: CLI_VERSION, to: latest })) +
      err.dim(` ${RELEASES_URL}\n  ${tr('update.how')}`) +
      '\n',
  )
}

/// `rcq update`: fetch the newest release and replace this install in place.
///
/// The client is one directory (`rcq`, `rcq.mjs`, `pkg-node/`) unpacked by
/// hand, so updating it is unpacking it again over the top. Nothing here
/// touches the state directory: the account, the ratchets and the history live
/// in `~/.rcq` and are not ours to move.
///
/// ⚠ Replaces files INSIDE the install directory, never the directory itself:
/// `rcq` is usually a symlink from somewhere on PATH, and swapping the folder
/// out from under it would leave that link pointing at nothing. On POSIX the
/// running rcq.mjs is already in memory, so overwriting it mid-run is safe.
///
/// The download rides the ordinary fetch, which means it rides `rcq proxy`
/// when one is engaged: on a censored network github.com is blocked exactly
/// like everything else.
export async function runUpdate(): Promise<number> {
  const latest = await latestVersion(true)
  if (!latest) {
    process.stderr.write(err.yellow(tr('update.unknown')) + '\n')
    return 1
  }
  if (cmpVersions(latest, CLI_VERSION) <= 0) {
    process.stderr.write(tr('update.already', { version: CLI_VERSION }) + '\n')
    return 0
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  const url = `https://github.com/rcq-messenger/rcq-cli/releases/download/v${latest}/rcq.tar.gz`
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rcq-update-'))
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const tarball = path.join(work, 'rcq.tar.gz')
    fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()))
    // `tar` rather than a bundled decompressor: it is on macOS, on every Linux
    // and in Windows since 10, and a wrong archive must fail here, before
    // anything in the install directory has been touched.
    execFileSync('tar', ['xzf', tarball, '-C', work], { stdio: 'ignore' })
    const unpacked = path.join(work, 'rcq')
    if (!fs.existsSync(path.join(unpacked, 'rcq.mjs'))) throw new Error('unexpected archive layout')
    for (const entry of fs.readdirSync(unpacked)) {
      const from = path.join(unpacked, entry)
      const to = path.join(here, entry)
      fs.rmSync(to, { recursive: true, force: true })
      fs.cpSync(from, to, { recursive: true })
    }
    fs.chmodSync(path.join(here, 'rcq'), 0o755)
    process.stderr.write(err.green(tr('update.done', { from: CLI_VERSION, to: latest })) + '\n')
    return 0
  } catch (e) {
    process.stderr.write(
      err.yellow(tr('update.failed', { err: e instanceof Error ? e.message : String(e) })) +
        err.dim(` ${RELEASES_URL}\n  ${tr('update.how')}`) +
        '\n',
    )
    return 1
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
