// The burn cascade across islands (spec 2026-09-15, F2), offline.
//
// Why this gets a test of its own:
//   * A burn deletes the copies on other islands FIRST, while this browser can
//     still prove the key, and the home island last. Once the keys are wiped,
//     nothing but the recovery phrase can delete a copy that was missed, so a
//     result that says "gone" when it is not is the one failure that cannot be
//     undone.
//   * "Gone" is only `identity_not_found` from EVERY key held, asked after the
//     last delete. With a rotation pending, the new key finding nothing says
//     nothing about a copy under the old key, and a retired key answers
//     `identity_rotated` while the account lives on under another.
//   * An island without the recover handshake can never say "no copy": it is
//     too old, never already gone.
//   * The whole run returns by its deadline even when an island hangs.
// Everything here is production code from src/lib/burn-cascade.ts, run on a
// fake island (rows carry a key, a token names a row).
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import {
  MAX_DELETES_PER_ISLAND,
  accountBurnedSignsOut,
  burnResultOk,
  createBurnFlow,
  isBurning,
  mergeBurnTargets,
  runRemote,
  sameKeySiblings,
  setBurning,
  setDeletingHome,
} from '../dist/burn-cascade.mjs'

let n = 0
const check = async (label, fn) => {
  await fn()
  n++
  console.log('  ok  ' + label)
}

const K = 'key-current'
const OLD = 'key-old'
const NEW = 'key-new'

/// A fake island. `rows` are the keys of the accounts on it; `tokens` maps a
/// token to the index of the row it opens (-1 for a token that opens nothing).
/// A key in `retired` answers identity_rotated while any account lives.
function island(opts = {}) {
  const rows = (opts.rows ?? []).map((key, i) => ({ id: i + 1, key }))
  const tokens = new Map(Object.entries(opts.tokens ?? {}).map(([t, i]) => [t, rows[i]?.id ?? -1]))
  return {
    rows,
    tokens,
    retired: new Set(opts.retired ?? []),
    tooOld: !!opts.tooOld,
    suspended: !!opts.suspended,
    hang: !!opts.hang,
    netFailures: opts.netFailures ?? 0,
    serverFailures: opts.serverFailures ?? 0,
    calls: { del: 0, recover: 0 },
    deleted: 0,
    minted: 0,
  }
}

function transportFor(islands) {
  const hang = () => new Promise(() => {}) // ignores the abort signal on purpose
  return {
    async deleteAccount(host, token) {
      const s = islands[host]
      s.calls.del++
      if (s.hang) await hang()
      if (s.netFailures > 0) {
        s.netFailures--
        throw new Error('network')
      }
      if (s.serverFailures > 0) {
        s.serverFailures--
        return 503
      }
      if (s.suspended) return 403
      const id = s.tokens.get(token)
      const i = s.rows.findIndex((r) => r.id === id)
      if (i < 0) return 401
      s.rows.splice(i, 1)
      s.tokens.delete(token)
      s.deleted++
      return 204
    },
    async recover(host, key) {
      const s = islands[host]
      s.calls.recover++
      if (s.hang) await hang()
      if (s.netFailures > 0) {
        s.netFailures--
        throw new Error('network')
      }
      if (s.tooOld) return { kind: 'too_old' }
      const row = s.rows.find((r) => r.key === key)
      if (row) {
        const token = `minted-${++s.minted}`
        s.tokens.set(token, row.id)
        return { kind: 'token', token }
      }
      if (s.retired.has(key) && s.rows.length > 0) return { kind: 'rotated' }
      return { kind: 'not_found' }
    },
  }
}

const target = (host, keys = [K], tokens = []) => ({ host, keys, tokens })
const one = async (s, t, opts) => (await runRemote([t], transportFor({ [t.host]: s }), opts)).get(t.host)

await check('1. a held token deletes, then the key finds nothing: confirmed(1)', async () => {
  const s = island({ rows: [K], tokens: { held: 0 } })
  assert.deepEqual(await one(s, target('b.example', [K], ['held'])), { kind: 'confirmed', n: 1 })
  assert.equal(s.rows.length, 0)
  assert.equal(s.calls.recover, 1)
})

await check('2. a stale token (401), then recover, delete, recover 404: confirmed(1)', async () => {
  const s = island({ rows: [K], tokens: { stale: -1 } })
  assert.deepEqual(await one(s, target('b.example', [K], ['stale'])), { kind: 'confirmed', n: 1 })
  assert.equal(s.rows.length, 0)
})

await check('3. the first recover finds nothing: already gone', async () => {
  const s = island({ rows: [] })
  assert.deepEqual(await one(s, target('b.example')), { kind: 'already_gone' })
})

await check('4. no recover handshake on the island: too old, never already gone', async () => {
  const s = island({ rows: [K], tooOld: true })
  assert.deepEqual(await one(s, target('b.example')), { kind: 'failed', reason: 'too_old' })
})

await check('5. two network failures: offline after exactly two tries', async () => {
  const s = island({ rows: [K], netFailures: 99 })
  assert.deepEqual(await one(s, target('b.example')), { kind: 'failed', reason: 'offline' })
  assert.equal(s.calls.recover + s.calls.del, 2)
  // Without the retry, exactly one.
  const s2 = island({ rows: [K], netFailures: 99 })
  assert.deepEqual(await one(s2, target('b.example'), { retry: false }), { kind: 'failed', reason: 'offline' })
  assert.equal(s2.calls.recover + s2.calls.del, 1)
})

await check('5b. one 5xx is retried and the island still ends confirmed', async () => {
  const s = island({ rows: [K], serverFailures: 1 })
  assert.deepEqual(await one(s, target('b.example')), { kind: 'confirmed', n: 1 })
  assert.equal(s.rows.length, 0)
})

await check('6. a hanging island: the run returns by the deadline; a queued island is not tried', async () => {
  const islands = { 'a.example': island({ rows: [K], hang: true }), 'b.example': island({ rows: [K] }) }
  const started = Date.now()
  const res = await runRemote([target('a.example'), target('b.example')], transportFor(islands), {
    deadlineMs: 150,
    concurrency: 1,
  })
  const took = Date.now() - started
  assert.ok(took >= 140 && took < 1000, `took ${took} ms`)
  assert.deepEqual(res.get('a.example'), { kind: 'failed', reason: 'timeout' })
  assert.deepEqual(res.get('b.example'), { kind: 'not_tried' })
  assert.equal(islands['b.example'].calls.recover, 0)
})

await check(`7. more rows under one key than ${MAX_DELETES_PER_ISLAND}: stops at the cap with limit`, async () => {
  const s = island({ rows: [K, K, K, K, K] })
  assert.deepEqual(await one(s, target('b.example')), { kind: 'failed', reason: 'limit' })
  assert.equal(s.deleted, MAX_DELETES_PER_ISLAND)
  assert.equal(s.rows.length, 1)
  // Exactly at the cap is still a clean result.
  const s4 = island({ rows: [K, K, K, K] })
  assert.deepEqual(await one(s4, target('b.example')), { kind: 'confirmed', n: 4 })
})

await check('8. the same island in both stores is one target with both tokens', async () => {
  const targets = mergeBurnTargets(
    [
      { host: 'B.example', uin: 7, token: 't-visited' },
      { host: 'b.example', uin: 7, token: 't-backup' },
      { host: 'b.example.', token: 't-visited' },
      { host: 'c.example', uin: 9 },
    ],
    'home.example',
    [K],
  )
  assert.equal(targets.length, 2)
  assert.deepEqual(targets[0], { host: 'b.example', uin: 7, tokens: ['t-visited', 't-backup'], keys: [K] })
  assert.deepEqual(targets[1], { host: 'c.example', uin: 9, tokens: [], keys: [K] })
})

await check('9. the home island is never a remote target', async () => {
  const targets = mergeBurnTargets(
    [{ host: 'home.example' }, { host: 'HOME.example.' }, { host: '' }, { host: 'b.example' }],
    'Home.Example',
    [K],
  )
  assert.deepEqual(targets.map((t) => t.host), ['b.example'])
})

await check('10. a pending rotation: a copy under the old key is deleted, never "already gone"', async () => {
  // A: the rotation reached it (row under NEW, OLD retired). B: it did not
  // (row still under OLD). The new key finds nothing on B, and that must not
  // end B, in either key order.
  const islands = {
    'a.example': island({ rows: [NEW], retired: [OLD] }),
    'b.example': island({ rows: [OLD] }),
    'c.example': island({ rows: [OLD] }),
  }
  const res = await runRemote(
    [target('a.example', [NEW, OLD]), target('b.example', [OLD, NEW]), target('c.example', [NEW, OLD])],
    transportFor(islands),
  )
  for (const host of ['a.example', 'b.example', 'c.example']) {
    assert.deepEqual(res.get(host), { kind: 'confirmed', n: 1 }, host)
    assert.equal(islands[host].rows.length, 0, host)
  }
})

await check('11. identity_rotated on the old key tries the new key, and asks the old one again', async () => {
  const s = island({ rows: [NEW], retired: [OLD] })
  assert.deepEqual(await one(s, target('b.example', [OLD, NEW])), { kind: 'confirmed', n: 1 })
  // A key that only ever answers "rotated" leaves an account we cannot reach:
  // never reported as gone.
  const s2 = island({ rows: ['a-key-we-do-not-hold'], retired: [OLD] })
  assert.deepEqual(await one(s2, target('b.example', [OLD])), { kind: 'failed', reason: 'server' })
  assert.equal(s2.rows.length, 1)
})

await check('a suspended account is reported, not retried', async () => {
  const s = island({ rows: [K], suspended: true })
  assert.deepEqual(await one(s, target('b.example')), { kind: 'failed', reason: 'suspended' })
  assert.equal(s.calls.del, 1)
})

await check('islands run side by side and every host gets a result', async () => {
  const islands = {}
  const targets = []
  for (let i = 0; i < 9; i++) {
    const host = `i${i}.example`
    islands[host] = island({ rows: i % 3 === 0 ? [] : [K] })
    targets.push(target(host))
  }
  const res = await runRemote(targets, transportFor(islands))
  assert.equal(res.size, 9)
  for (const [host, r] of res) {
    assert.ok(burnResultOk(r), host)
    assert.equal(islands[host].rows.length, 0)
  }
  assert.equal((await runRemote([], transportFor({}))).size, 0)
})

await check('same-key siblings: another island, same key, any encoding; never the home row', async () => {
  const raw = Buffer.from(Array.from({ length: 32 }, (_, i) => (i % 2 ? 0xfb : 0xff)))
  const PUB = raw.toString('base64')
  const accounts = [
    { uin: 5, host: 'is2.example', signingPub: raw.toString('base64url') },
    { uin: 6, host: 'home.example', signingPub: PUB },
    { uin: 7, host: 'c.example', signingPub: Buffer.alloc(32, 1).toString('base64') },
  ]
  const got = sameKeySiblings(accounts, { uin: 12, host: 'HOME.example', signingPub: PUB })
  assert.deepEqual(got.map((a) => a.uin), [5])
})

await check('the burning flag is module state, off by default', async () => {
  assert.equal(isBurning(), false)
  assert.equal(accountBurnedSignsOut(), true)
  setBurning(true)
  assert.equal(isBurning(), true)
  // The flow is open, but account_burned from a burn elsewhere still signs out.
  assert.equal(accountBurnedSignsOut(), true)
  setDeletingHome(true)
  assert.equal(accountBurnedSignsOut(), false)
  // Clearing the flow clears both.
  setBurning(false)
  assert.equal(isBurning(), false)
  assert.equal(accountBurnedSignsOut(), true)
})

// -----------------------------------------------------------
// The order of a burn (burn-flow.ts), with every side effect faked
// -----------------------------------------------------------

const deferred = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

/// A fake screen. `keys` and `stores` stand for what the local wipe removes;
/// the hooks record what happened and when.
function screen(opts = {}) {
  const w = {
    keys: true,
    stores: true,
    log: [],
    stages: [],
    forgotten: [],
    cancelled: null,
    homeFailed: null,
    finished: null,
    atHome: [],
    signsOutDuringRemote: [],
  }
  const homeAnswers = [...(opts.home ?? [{ ok: true }])]
  let remoteCall = 0
  w.hooks = {
    async runRemote(targets) {
      w.log.push(`remote:${targets.map((t) => t.host).join(',')}`)
      w.signsOutDuringRemote.push(accountBurnedSignsOut())
      const call = remoteCall++
      if (opts.remoteGate) await opts.remoteGate.promise
      const m = new Map()
      for (const t of targets) m.set(t.host, opts.remote?.(t.host, call) ?? { kind: 'confirmed', n: 1 })
      return m
    },
    async deleteHome() {
      w.log.push('home')
      w.atHome.push({ keys: w.keys, stores: w.stores, burning: isBurning(), signsOut: accountBurnedSignsOut() })
      if (opts.homeGate) await opts.homeGate.promise
      const a = homeAnswers.shift() ?? { ok: false, retryable: false }
      if (a === 'throw') throw new Error('network')
      return a
    },
    finish(siblings, rows) {
      w.log.push('finish')
      w.finished = { siblings, hosts: rows.map(([h]) => h) }
      w.keys = false
      w.stores = false
    },
    forgetCopies(hosts) {
      w.forgotten.push(...hosts)
    },
    onChange(stage) {
      w.stages.push(stage)
    },
    onCancelled(deleted) {
      w.cancelled = deleted
    },
    onHomeFailed(remoteDeleted) {
      w.homeFailed = remoteDeleted
    },
  }
  return w
}

const burnPlan = (hosts, siblings = []) => ({ targets: hosts.map((h) => target(h)), siblings })
const reset = () => setBurning(false)

await check('order: copies elsewhere, then home, then the wipe; keys and stores still there at the home delete', async () => {
  const w = screen()
  const flow = createBurnFlow(burnPlan(['b.example', 'c.example'], [{ uin: 5 }, { uin: 6 }]), w.hooks)
  await flow.start()
  assert.deepEqual(w.log, ['remote:b.example,c.example', 'home', 'finish'])
  assert.deepEqual(w.atHome, [{ keys: true, stores: true, burning: true, signsOut: false }])
  assert.deepEqual(w.stages, ['working', 'home', 'done'])
  // The same-key accounts go with the wipe.
  assert.deepEqual(w.finished.siblings, [5, 6])
  assert.equal(w.forgotten.length, 0)
  // Done: the flags stay on until the reload the wipe does.
  assert.equal(isBurning(), true)
  assert.equal(accountBurnedSignsOut(), false)
  reset()
})

await check('our own account_burned during the home delete does not sign out; one during the remote phase does', async () => {
  const gate = deferred()
  const w = screen({ homeGate: gate })
  const flow = createBurnFlow(burnPlan(['b.example']), w.hooks)
  const running = flow.start()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(flow.stage(), 'home')
  assert.equal(accountBurnedSignsOut(), false)
  gate.resolve()
  await running
  assert.deepEqual(w.signsOutDuringRemote, [true])
  reset()
})

await check('a home failure wipes nothing, clears the flags, and forgets only the copies that are gone', async () => {
  const w = screen({
    home: [{ ok: false, retryable: true }, { ok: false, retryable: true }],
    remote: (host) => (host === 'b.example' ? { kind: 'confirmed', n: 1 } : { kind: 'already_gone' }),
  })
  const flow = createBurnFlow(burnPlan(['b.example', 'c.example'], [{ uin: 5 }]), w.hooks)
  await flow.start()
  assert.deepEqual(w.log, ['remote:b.example,c.example', 'home', 'home'])
  assert.equal(w.finished, null)
  assert.equal(w.keys, true)
  assert.equal(w.stores, true)
  assert.equal(w.homeFailed, true)
  assert.deepEqual(w.forgotten, ['b.example', 'c.example'])
  assert.equal(isBurning(), false)
  assert.equal(accountBurnedSignsOut(), true)
  assert.equal(flow.stage(), 'idle')

  // A refusal is not retried; a network failure is, and can still succeed.
  const refused = screen({ home: [{ ok: false, retryable: false }, { ok: true }] })
  await createBurnFlow(burnPlan([]), refused.hooks).start()
  assert.deepEqual(refused.log, ['home'])
  assert.equal(refused.homeFailed, false)
  assert.equal(isBurning(), false)
  const flaky = screen({ home: ['throw', { ok: true }] })
  await createBurnFlow(burnPlan([]), flaky.hooks).start()
  assert.deepEqual(flaky.log, ['home', 'home', 'finish'])
  reset()
})

await check('failures wait for the person: retry asks only the failed islands, cancel forgets what is gone', async () => {
  const w = screen({
    remote: (host) => (host === 'c.example' ? { kind: 'failed', reason: 'offline' } : { kind: 'confirmed', n: 1 }),
  })
  const flow = createBurnFlow(burnPlan(['b.example', 'c.example']), w.hooks)
  await flow.start()
  assert.equal(flow.stage(), 'failures')
  assert.equal(isBurning(), true)
  assert.equal(accountBurnedSignsOut(), true)
  await flow.retry()
  assert.deepEqual(w.log, ['remote:b.example,c.example', 'remote:c.example'])
  assert.equal(flow.stage(), 'failures')
  flow.cancel()
  assert.deepEqual(w.cancelled, ['b.example'])
  assert.deepEqual(w.forgotten, ['b.example'])
  assert.equal(isBurning(), false)
  assert.equal(w.log.includes('home'), false)
  assert.equal(w.keys, true)
  // Nothing more happens on a flow that ended.
  await flow.anyway()
  assert.equal(w.log.includes('home'), false)
  reset()
})

await check('burn anyway goes home with the failed copies left as they are', async () => {
  const w = screen({ remote: () => ({ kind: 'failed', reason: 'too_old' }) })
  const flow = createBurnFlow(burnPlan(['b.example'], [{ uin: 9 }]), w.hooks)
  await flow.start()
  await flow.anyway()
  assert.deepEqual(w.log, ['remote:b.example', 'home', 'finish'])
  assert.deepEqual(w.finished.siblings, [9])
  reset()
})

await check('leaving the screen never leaves the flags on', async () => {
  // At the failure list: the flow ends there.
  const a = screen({ remote: () => ({ kind: 'failed', reason: 'offline' }) })
  const fa = createBurnFlow(burnPlan(['b.example']), a.hooks)
  await fa.start()
  fa.detach()
  assert.equal(isBurning(), false)
  assert.deepEqual(a.cancelled, [])

  // During the remote phase: it ends at the failure list it would have shown.
  const gate = deferred()
  const b = screen({ remoteGate: gate, remote: () => ({ kind: 'failed', reason: 'timeout' }) })
  const fb = createBurnFlow(burnPlan(['b.example']), b.hooks)
  const running = fb.start()
  await new Promise((r) => setTimeout(r, 0))
  fb.detach()
  assert.equal(isBurning(), true)
  gate.resolve()
  await running
  assert.equal(isBurning(), false)
  assert.equal(b.log.includes('home'), false)

  // During the home delete: it finishes (the wipe reloads the page).
  const homeGate = deferred()
  const c = screen({ homeGate })
  const fc = createBurnFlow(burnPlan([]), c.hooks)
  const going = fc.start()
  await new Promise((r) => setTimeout(r, 0))
  fc.detach()
  homeGate.resolve()
  await going
  assert.deepEqual(c.log, ['home', 'finish'])
  reset()

  // Before anything started: nothing to undo, and nothing turned on.
  createBurnFlow(burnPlan(['b.example']), screen().hooks).detach()
  assert.equal(isBurning(), false)
})

console.log(`burn-cascade: ok (${n} checks)`)
