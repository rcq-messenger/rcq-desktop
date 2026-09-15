// Burning an account on every island this browser holds a copy of, before the
// home island and before the keys are gone (spec 2026-09-15, F2).
//
// A burn used to be one `DELETE /auth/account` on the home island. The same
// keys also live on every island this browser joined a group on (a guest copy)
// and on every backup home, and each of those is an account of its own there:
// it keeps the name, the group memberships and the groups it owns. Once the
// keys are wiped nobody can delete those copies any more except with the
// recovery phrase, which a person burning an account is usually about to lose
// on purpose. So the copies go FIRST, while this browser can still prove the
// key, and the home island LAST.
//
// Pure core, transport injected: nothing here touches a store, a token cache
// or `fetch`, so the state machine is proven offline against the built bundle
// (cli/test/burn-cascade.mjs). The planner and the real transport live in
// burn-plan.ts.
//
// ⚠ Every result is the island's CLAIM. An operator can answer 204 and keep
// the row; no second road proves otherwise, because the operator controls
// every road to its own database. The screen words it that way ("island
// confirmed deletion"), never "deleted".

import { sameSigningKey } from './crossisland-gate'

// -----------------------------------------------------------
// The burning flag
// -----------------------------------------------------------

let burning = false
let deletingHome = false

/// True while a burn flow is open in this tab: from the first remote delete
/// until the flow is cancelled, fails at home, is left behind by the person
/// (burn-flow.ts `detach`), or the page reloads. Read by every loop that could
/// write credentials or talk to an island meanwhile: the visited and backup
/// drains, the pending-request poll and a new guest registration.
export function isBurning(): boolean {
  return burning
}

export function setBurning(on: boolean): void {
  burning = on
  if (!on) deletingHome = false
}

/// True only from the moment OUR home delete is sent until the page reloads
/// or that delete fails. Narrower than `isBurning` on purpose: the home
/// island fans `account_burned` out to our own socket as well, and that one
/// must not sign out halfway through the flow; one sent by a burn on another
/// device while this tab is still in the remote phase or the failure list
/// must.
export function setDeletingHome(on: boolean): void {
  deletingHome = on
}

/// Does an `account_burned` frame end this session now? (ws.tsx)
export function accountBurnedSignsOut(): boolean {
  return !deletingHome
}

// -----------------------------------------------------------
// Results
// -----------------------------------------------------------

export type BurnFailReason = 'offline' | 'timeout' | 'suspended' | 'too_old' | 'server' | 'limit'

export type IslandBurnResult =
  /// The island answered 204 to `n` deletes, and afterwards every key we hold
  /// answered `identity_not_found`.
  | { kind: 'confirmed'; n: number }
  /// Every key answered `identity_not_found` before anything was deleted.
  | { kind: 'already_gone' }
  | { kind: 'failed'; reason: BurnFailReason }
  /// The deadline came before this island's turn.
  | { kind: 'not_tried' }

export function burnResultOk(r: IslandBurnResult): boolean {
  return r.kind === 'confirmed' || r.kind === 'already_gone'
}

// -----------------------------------------------------------
// Targets
// -----------------------------------------------------------

/// One island to burn on. `tokens` are the session tokens this browser holds
/// there right now (often none: they are memory-only); `keys` are the signing
/// keys to prove, in the order to try them.
export interface BurnTarget<K> {
  host: string
  uin?: number
  tokens: string[]
  keys: K[]
}

/// Where a copy lives, as one store knows it.
export interface BurnSource {
  host: string
  uin?: number
  token?: string
}

function normHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '')
}

/// One target per island out of every store's list: the same host from the
/// visited list and the backup list is ONE island with every token either
/// store holds. The home island is never a target, whatever a store says: it
/// is deleted last, on its own, after the person has seen these results.
export function mergeBurnTargets<K>(sources: BurnSource[], homeHost: string, keys: K[]): BurnTarget<K>[] {
  const home = normHost(homeHost)
  const byHost = new Map<string, BurnTarget<K>>()
  for (const s of sources) {
    const host = normHost(s.host ?? '')
    if (!host || host === home) continue
    let t = byHost.get(host)
    if (!t) {
      t = { host, tokens: [], keys: [...keys] }
      if (typeof s.uin === 'number') t.uin = s.uin
      byHost.set(host, t)
    }
    if (t.uin === undefined && typeof s.uin === 'number') t.uin = s.uin
    if (s.token && !t.tokens.includes(s.token)) t.tokens.push(s.token)
  }
  return [...byHost.values()]
}

/// Other accounts held in this browser under the SAME signing key as the one
/// being burned, on another island. They are the same identity: once the keys
/// are wiped they are as unreachable as the account itself, so they are burned
/// with it and said out loud before. One on the home island itself is left
/// alone (the home delete removes only the row the token names).
export function sameKeySiblings<A extends { uin: number; host: string; signingPub: string }>(
  accounts: A[],
  active: { uin: number; host: string; signingPub: string },
): A[] {
  const home = normHost(active.host)
  return accounts.filter((a) => normHost(a.host) !== home && sameSigningKey(a.signingPub, active.signingPub))
}

// -----------------------------------------------------------
// Transport
// -----------------------------------------------------------

/// What proving a key on an island came to.
export type RecoverAnswer =
  /// A session token for one row that carries this key.
  | { kind: 'token'; token: string }
  /// 404 `identity_not_found`: no row carries this key.
  | { kind: 'not_found' }
  /// 404 `identity_rotated`: the key was retired by a rotation; the account
  /// lives on under another key.
  | { kind: 'rotated' }
  /// The island has no recover handshake at all (the challenge route is 404).
  /// It can never answer `identity_not_found`, so it can never be "gone".
  | { kind: 'too_old' }
  /// Any other refusal.
  | { kind: 'status'; status: number }

export interface BurnTransport<K> {
  /// `DELETE /auth/account` with `token`; resolves with the HTTP status.
  /// Throws on a network failure (and when `signal` aborts).
  deleteAccount(host: string, token: string, signal: AbortSignal): Promise<number>
  /// The recover handshake with `key`. Throws on a network failure.
  recover(host: string, key: K, signal: AbortSignal): Promise<RecoverAnswer>
}

// -----------------------------------------------------------
// The state machine
// -----------------------------------------------------------

/// Deletes per island. A key held by more rows than this is not what this
/// browser made, and the loop stops rather than run away.
export const MAX_DELETES_PER_ISLAND = 4
export const BURN_DEADLINE_MS = 15_000
export const BURN_CONCURRENCY = 6

export interface RunRemoteOptions {
  deadlineMs?: number
  /// One more attempt for an island that failed on the network or a 5xx.
  retry?: boolean
  concurrency?: number
  signal?: AbortSignal
}

class Transient {
  constructor(readonly reason: 'offline' | 'server') {}
}

class Final {
  constructor(readonly result: IslandBurnResult) {}
}

interface TargetState {
  n: number
  consumedTokens: Set<string>
  /// Per key index: the last answer, and how many deletes had happened when it
  /// came. An answer given before a later delete says nothing about the island
  /// after that delete, so it is asked again.
  answers: Map<number, { kind: 'not_found' | 'rotated'; at: number }>
}

const failed = (reason: BurnFailReason): Final => new Final({ kind: 'failed', reason })

async function attemptTarget<K>(
  target: BurnTarget<K>,
  transport: BurnTransport<K>,
  signal: AbortSignal,
  st: TargetState,
): Promise<IslandBurnResult> {
  const del = async (token: string): Promise<'deleted' | 'refused'> => {
    let status: number
    try {
      status = await transport.deleteAccount(target.host, token, signal)
    } catch {
      throw new Transient('offline')
    }
    if (status === 204 || status === 200) {
      st.n += 1
      return 'deleted'
    }
    if (status === 401 || status === 404) return 'refused'
    if (status === 403) throw failed('suspended')
    if (status >= 500 || status === 429) throw new Transient('server')
    throw failed('server')
  }

  // 1. The tokens this browser already holds. A 401 or 404 is simply a token
  //    that no longer opens anything; the key loop below settles the island.
  for (const token of target.tokens) {
    if (st.consumedTokens.has(token)) continue
    if (st.n >= MAX_DELETES_PER_ISLAND) break
    await del(token)
    st.consumedTokens.add(token)
  }

  // 2. Every key, until each has answered after the last delete. Only
  //    `identity_not_found` from EVERY key is gone: with a rotation pending, the
  //    new key finding nothing says nothing about a copy still under the old
  //    key, and a key answering `identity_rotated` names an account that lives
  //    on under a key we may not hold.
  for (;;) {
    const i = target.keys.findIndex((_, idx) => {
      const a = st.answers.get(idx)
      return !a || a.at < st.n
    })
    if (i < 0) break
    let ans: RecoverAnswer
    try {
      ans = await transport.recover(target.host, target.keys[i], signal)
    } catch {
      throw new Transient('offline')
    }
    switch (ans.kind) {
      case 'not_found':
      case 'rotated':
        st.answers.set(i, { kind: ans.kind, at: st.n })
        break
      case 'too_old':
        throw failed('too_old')
      case 'status':
        if (ans.status === 403) throw failed('suspended')
        if (ans.status >= 500 || ans.status === 429) throw new Transient('server')
        throw failed('server')
      case 'token': {
        if (st.n >= MAX_DELETES_PER_ISLAND) throw failed('limit')
        // A token the island just minted and then refuses would loop forever.
        if ((await del(ans.token)) === 'refused') throw failed('server')
        break
      }
    }
  }

  if (target.keys.length === 0) return { kind: 'failed', reason: 'server' }
  const allGone = target.keys.every((_, idx) => st.answers.get(idx)?.kind === 'not_found')
  if (!allGone) return { kind: 'failed', reason: 'server' }
  return st.n > 0 ? { kind: 'confirmed', n: st.n } : { kind: 'already_gone' }
}

async function runTarget<K>(
  target: BurnTarget<K>,
  transport: BurnTransport<K>,
  signal: AbortSignal,
  retry: boolean,
): Promise<IslandBurnResult> {
  const st: TargetState = { n: 0, consumedTokens: new Set(), answers: new Map() }
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptTarget(target, transport, signal, st)
    } catch (e) {
      if (e instanceof Final) return e.result
      if (signal.aborted) return { kind: 'failed', reason: 'timeout' }
      const reason = e instanceof Transient ? e.reason : 'server'
      if (retry && attempt === 0) continue
      return { kind: 'failed', reason }
    }
  }
}

/// Burn on every target, `concurrency` at a time, all under one deadline.
/// Resolves by the deadline even when a transport hangs: an island that had
/// started and not finished is `timeout`, one that never got its turn is
/// `not_tried`. Never throws.
export async function runRemote<K>(
  targets: BurnTarget<K>[],
  transport: BurnTransport<K>,
  opts: RunRemoteOptions = {},
): Promise<Map<string, IslandBurnResult>> {
  const deadlineMs = opts.deadlineMs ?? BURN_DEADLINE_MS
  const retry = opts.retry ?? true
  const concurrency = Math.max(1, opts.concurrency ?? BURN_CONCURRENCY)
  const results = new Map<string, IslandBurnResult>()
  for (const t of targets) results.set(t.host, { kind: 'not_tried' })
  if (targets.length === 0) return results

  const ctl = new AbortController()
  const onOuterAbort = () => ctl.abort()
  if (opts.signal) {
    if (opts.signal.aborted) ctl.abort()
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const started = new Set<string>()
  const settled = new Set<string>()
  let next = 0
  const worker = async () => {
    while (next < targets.length && !ctl.signal.aborted) {
      const t = targets[next++]
      started.add(t.host)
      const r = await runTarget(t, transport, ctl.signal, retry)
      if (ctl.signal.aborted) return
      results.set(t.host, r)
      settled.add(t.host)
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort()
      resolve()
    }, deadlineMs)
    ctl.signal.addEventListener('abort', () => resolve(), { once: true })
  })
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker())
  await Promise.race([Promise.all(workers), deadline])
  if (timer !== undefined) clearTimeout(timer)
  opts.signal?.removeEventListener('abort', onOuterAbort)
  for (const host of started) {
    if (!settled.has(host)) results.set(host, { kind: 'failed', reason: 'timeout' })
  }
  return results
}
