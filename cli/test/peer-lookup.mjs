// Per-peer lookups against one island, and who gets asked for a face.
//
// The bug this pins (28.09): a card read (`GET /users/{uin}/info`) holds one of
// the island's database connections while it waits for a second one, so twenty
// or thirty of them in the same second exhausted the whole pool and every
// worker stalled for minutes, 24 times in 30 days. The usual trigger was a
// phone opening the 2271-member beta room and asking every member with a
// picture for their profile key; on 24.09 it was a browser or the desktop,
// thirty card reads behind their CORS preflights. Nobody but an accepted
// contact ever answers that question, so almost all of it was for nothing.
//
// Everything driven here is production code from src/lib, against an in-memory
// island that counts what it is asked.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import {
  newTestIdentity,
  limitPeerLookup,
  PEER_LOOKUP_PARALLEL,
  PEER_CARD_SLOTS,
  PEER_CARD_TIMEOUT_MS,
  Api,
  PeerCache,
  peerSealKeys,
  clearPeerSealKeys,
  contactsCache,
  worthAskingForProfileKey,
  askForProfileKey,
  handleProfileKeyEnvelope,
  loadProfileKeys,
  loadPublishedProfileKey,
  slotId,
  seal,
  VAULT_PKEY,
} from '../dist/vault.mjs'

let n = 0
async function check(name, fn) {
  await fn()
  n += 1
  console.log(`  ok  ${name}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/// An island that answers cards, sealed deposits and one vault slot, and
/// records every request with how many were on the wire at the time.
function island({ delay = 10, cards = {}, fail = false } = {}) {
  const log = []
  let inFlight = 0
  let peak = 0
  const vault = new Map()
  const fetch = async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    inFlight += 1
    peak = Math.max(peak, inFlight)
    log.push(`${method} ${u.pathname}`)
    try {
      await sleep(delay)
      if (fail) return new Response(JSON.stringify({ detail: 'island_busy' }), { status: 503 })
      const card = u.pathname.match(/^\/users\/(\d+)\/info$/)
      if (card) {
        const c = cards[card[1]]
        if (!c) return new Response(JSON.stringify({ detail: 'no such user' }), { status: 404 })
        return new Response(JSON.stringify({ uin: Number(card[1]), nickname: 'x', identity_key: c.ik, signing_key: c.sk }))
      }
      if (u.pathname === '/messages/sealed' && method === 'POST') return new Response(null, { status: 204 })
      const slot = u.pathname.match(/^\/vault\/([0-9a-f]{32})$/)
      if (slot) {
        const row = vault.get(slot[1])
        if (method === 'GET') {
          return row
            ? new Response(JSON.stringify(row))
            : new Response(JSON.stringify({ detail: { code: 'no_slot', version: 0 } }), { status: 404 })
        }
      }
      return new Response('nope', { status: 404 })
    } finally {
      inFlight -= 1
    }
  }
  return { log, fetch, vault, peak: () => peak, count: (p) => log.filter((l) => l === p).length }
}

console.log('peer lookups')

await check(`twenty-nine concurrent card reads never put more than ${PEER_CARD_SLOTS} on the wire`, async () => {
  const isl = island()
  globalThis.fetch = isl.fetch
  const me = { ...newTestIdentity(400001), jwt: 'x', apiBase: 'https://one.test' }
  const uins = Array.from({ length: 29 }, (_, i) => 500000 + i)
  const answers = await Promise.all(uins.map((u) => Api.userInfo(me, u).then(() => 'card', (e) => e.status)))
  assert.equal(isl.log.length, 29, 'every lookup still reached the island: queued, never dropped')
  assert.ok(isl.peak() <= PEER_CARD_SLOTS, `peak ${isl.peak()}`)
  assert.deepEqual(answers, uins.map(() => 404), 'and every caller got its own answer')
})

await check('a failed lookup gives its slot back, and two islands queue apart', async () => {
  let active = { a: 0, b: 0 }
  let peak = { a: 0, b: 0 }
  const run = (lane, ok) => async () => {
    active[lane] += 1
    peak[lane] = Math.max(peak[lane], active[lane])
    await sleep(5)
    active[lane] -= 1
    if (!ok) throw new Error('HTTP 503')
    return lane
  }
  const jobs = []
  for (let i = 0; i < 12; i++) {
    jobs.push(limitPeerLookup('https://a.test', 'key', run('a', i % 2 === 0)).catch(() => 'failed'))
    jobs.push(limitPeerLookup('https://B.TEST/api', 'key', run('b', true)))
  }
  const out = await Promise.all(jobs)
  assert.equal(out.filter((x) => x === 'failed').length, 6)
  assert.ok(peak.a <= PEER_LOOKUP_PARALLEL && peak.b <= PEER_LOOKUP_PARALLEL, JSON.stringify(peak))
  // Each island filled its own four at once: one did not queue behind the other.
  assert.equal(peak.a, PEER_LOOKUP_PARALLEL)
  assert.equal(peak.b, PEER_LOOKUP_PARALLEL)
  // Six failures later the lane is not leaking slots.
  const t0 = Date.now()
  await Promise.all(Array.from({ length: 4 }, () => limitPeerLookup('https://a.test', 'key', () => sleep(20))))
  assert.ok(Date.now() - t0 < 60, 'four fresh lookups still run side by side')
})

await check('key reads go first when a slot frees, and cards never take the last slot', async () => {
  const base = 'https://order.test'
  const order = []
  const gate = () => {
    let open
    const p = new Promise((r) => (open = r))
    return { p, open }
  }
  const holds = Array.from({ length: PEER_CARD_SLOTS }, gate)
  const cards = holds.map((g, i) => limitPeerLookup(base, 'card', async () => { order.push(`card${i}`); await g.p }))
  const k1 = gate()
  const key1 = limitPeerLookup(base, 'key', async () => { order.push('key1'); await k1.p })
  // The lane is full: three cards and one key read. A card queues first, then
  // the next send's device list.
  const lateCard = limitPeerLookup(base, 'card', async () => { order.push('lateCard') })
  const key2 = limitPeerLookup(base, 'key', async () => { order.push('key2') })
  await sleep(0)
  assert.deepEqual(order, ['card0', 'card1', 'card2', 'key1'])
  k1.open()
  await key1
  await key2
  assert.deepEqual(order.slice(4), ['key2'], 'the send read went ahead of the card that queued before it')
  // A slot is free now, but it is the one kept for sends.
  await sleep(10)
  assert.ok(!order.includes('lateCard'), 'a fourth card does not take the last slot')
  holds[0].open()
  await lateCard
  assert.equal(order.at(-1), 'lateCard', 'and it runs as soon as a card slot frees')
  holds.forEach((g) => g.open())
  await Promise.all(cards)
})

await check('a card read the network drops is cut off, and a send never waits behind it', async () => {
  // The island never answers these and the socket never closes: what a proxy
  // or a tunnel that silently drops a connection looks like from here.
  let cardFetches = 0
  let aborted = 0
  globalThis.fetch = (url, init = {}) => {
    if (/^\/users\/\d+\/info$/.test(new URL(url).pathname)) {
      cardFetches += 1
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted += 1
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }
    return Promise.resolve(new Response('{"devices":[]}'))
  }
  // The cutoff is fifteen seconds; the clock for it runs at 60 ms here.
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === PEER_CARD_TIMEOUT_MS ? 60 : ms, ...rest)
  try {
    const me = { ...newTestIdentity(400005), jwt: 'x', apiBase: 'https://hole.test' }
    let settled = 0
    const hung = Array.from({ length: PEER_LOOKUP_PARALLEL + 1 }, (_, i) =>
      Api.userInfo(me, 900000 + i).then(() => 'answered', (e) => e.message).finally(() => { settled += 1 }))
    assert.equal(cardFetches, PEER_CARD_SLOTS, 'the cards beyond their share queue')
    // A send resolving its peer's devices, as signal-device resolveTargets does.
    const list = await limitPeerLookup(me.apiBase, 'key', async () => (await fetch(`${me.apiBase}/keys/900100/devices`)).json())
    assert.deepEqual(list, { devices: [] })
    assert.equal(settled, 0, 'the send went through while every card read was still hanging')
    const out = await Promise.all(hung)
    assert.ok(out.every((m) => /no answer in/.test(m)), JSON.stringify(out))
    assert.equal(cardFetches, PEER_LOOKUP_PARALLEL + 1, 'the queued cards got their turn')
    assert.equal(aborted, PEER_LOOKUP_PARALLEL + 1, 'every hung read was aborted, not just forgotten')
    // Nothing leaked: the whole lane is free again.
    const t0 = Date.now()
    await Promise.all(Array.from({ length: PEER_LOOKUP_PARALLEL }, () => limitPeerLookup(me.apiBase, 'key', () => sleep(20))))
    assert.ok(Date.now() - t0 < 60, 'four key reads run side by side afterwards')
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

await check('callers that overlap on one key share one load, and the answer lasts its TTL', async () => {
  let clock = 1_000_000
  let loads = 0
  const cache = new PeerCache((v) => (v ? 60_000 : 5_000), () => clock)
  const load = async () => { loads += 1; await sleep(5); return 'keys' }
  const all = await Promise.all(Array.from({ length: 10 }, () => cache.get('p', load)))
  assert.deepEqual(all, Array(10).fill('keys'))
  assert.equal(loads, 1)
  clock += 59_000
  assert.equal(await cache.get('p', load), 'keys')
  assert.equal(loads, 1, 'still fresh')
  clock += 2_000
  await cache.get('p', load)
  assert.equal(loads, 2, 'expired, asked again')
  // "Not found" is believed only briefly.
  let miss = 0
  const none = async () => { miss += 1; return null }
  await cache.get('q', none)
  clock += 4_000
  await cache.get('q', none)
  assert.equal(miss, 1)
  clock += 2_000
  await cache.get('q', none)
  assert.equal(miss, 2)
  // A load that throws reaches every caller and is not remembered.
  let boom = 0
  const bad = async () => { boom += 1; await sleep(1); throw new Error('down') }
  const r = await Promise.allSettled([cache.get('r', bad), cache.get('r', bad)])
  assert.ok(r.every((x) => x.status === 'rejected'))
  assert.equal(boom, 1)
  await cache.get('r', load)
  assert.equal(loads, 3)
})

await check('a receipt storm to one stranger is ONE card read; a contact is none', async () => {
  const peer = newTestIdentity(600001)
  const friend = newTestIdentity(600002)
  const isl = island({ cards: { 600001: { ik: peer.identityKeyB64, sk: peer.signingKeyB64 } } })
  globalThis.fetch = isl.fetch
  clearPeerSealKeys()
  const me = { ...newTestIdentity(400002), jwt: 'x', apiBase: 'https://one.test' }
  contactsCache.set(me.uin, {
    contacts: [{ uin: friend.uin, nickname: 'f', status: 'online', blocked: false, identity_key: friend.identityKeyB64, signing_key: friend.signingKeyB64 }],
    groups: [], pending: [], me: null,
  })
  const got = await Promise.all(Array.from({ length: 20 }, () => peerSealKeys(me, peer.uin)))
  assert.ok(got.every((k) => k?.identity_key === peer.identityKeyB64 && k.signing_key === peer.signingKeyB64))
  assert.equal(isl.count('GET /users/600001/info'), 1, 'twenty callers, one read')
  await peerSealKeys(me, peer.uin)
  assert.equal(isl.count('GET /users/600001/info'), 1, 'and it is kept')
  const f = await peerSealKeys(me, friend.uin)
  assert.equal(f.identity_key, friend.identityKeyB64)
  assert.equal(isl.log.filter((l) => l.includes('/600002/')).length, 0, 'a contact is sealed to from the roster')
  // Another island is another person, even with the same digits.
  await peerSealKeys({ ...me, apiBase: 'https://two.test' }, peer.uin)
  assert.equal(isl.count('GET /users/600001/info'), 2)
  // An island that cannot answer is not asked once per queued receipt.
  const down = island({ fail: true })
  globalThis.fetch = down.fetch
  clearPeerSealKeys()
  const none = await Promise.all(Array.from({ length: 10 }, () => peerSealKeys(me, 600009)))
  assert.ok(none.every((k) => k === null))
  await peerSealKeys(me, 600009)
  assert.equal(down.count('GET /users/600009/info'), 1)
  contactsCache.delete(me.uin)
})

console.log('who is asked for a face')

await check('the beta room: a member who is not a contact is never asked, a contact is', async () => {
  const isl = island()
  globalThis.fetch = isl.fetch
  const me = { ...newTestIdentity(400003), jwt: 'x', apiBase: 'https://one.test' }
  const friend = newTestIdentity(700001)
  const row = { uin: friend.uin, nickname: 'f', status: 'online', blocked: false, identity_key: friend.identityKeyB64, signing_key: friend.signingKeyB64 }
  // No roster yet: nobody is asked, and nobody is throttled for it either.
  const members = Array.from({ length: 30 }, (_, i) => newTestIdentity(700100 + i))
  await Promise.all([...members, friend].map((m) =>
    askForProfileKey(me, { uin: m.uin, identity_key: m.identityKeyB64, signing_key: m.signingKeyB64 })))
  assert.equal(isl.log.length, 0, 'no roster, no asks')
  contactsCache.set(me.uin, { contacts: [row, { ...row, uin: 700002, host: 'is2.test' }], groups: [], pending: [], me: null })
  assert.equal(worthAskingForProfileKey(me.uin, friend.uin), true)
  assert.equal(worthAskingForProfileKey(me.uin, 700101), false, 'a room member, not a contact')
  assert.equal(worthAskingForProfileKey(me.uin, 700002), false, 'the same digits on another island')
  await Promise.all([...members, friend].map((m) =>
    askForProfileKey(me, { uin: m.uin, identity_key: m.identityKeyB64, signing_key: m.signingKeyB64 })))
  assert.deepEqual(isl.log, ['POST /messages/sealed'], 'thirty strangers cost nothing; the contact is asked once')
  contactsCache.delete(me.uin)
})

await check('answering a contact seals to the roster key: no card read at all', async () => {
  const isl = island()
  globalThis.fetch = isl.fetch
  const me = { ...newTestIdentity(400004), jwt: 'x', apiBase: 'https://one.test' }
  // A published key for `me`, so there is something to answer with.
  const slot = slotId(me, VAULT_PKEY)
  isl.vault.set(slot, { blob: seal(me, slot, 1, new TextEncoder().encode('a2V5LWZvci10ZXN0cy0zMi1ieXRlcy1sb25nLXBhZGRpbmc=')), version: 1 })
  loadProfileKeys(me.uin)
  assert.ok(await loadPublishedProfileKey(me))
  const friend = newTestIdentity(800001)
  contactsCache.set(me.uin, {
    contacts: [{ uin: friend.uin, nickname: 'f', status: 'online', blocked: false, identity_key: friend.identityKeyB64, signing_key: friend.signingKeyB64 }],
    groups: [], pending: [], me: null,
  })
  isl.log.length = 0
  await handleProfileKeyEnvelope(me, friend.uin, { kind: 'pkeyask' })
  assert.deepEqual(isl.log, ['POST /messages/sealed'])
  // A stranger's question is refused before anything goes on the wire.
  isl.log.length = 0
  await handleProfileKeyEnvelope(me, 800999, { kind: 'pkeyask' })
  assert.deepEqual(isl.log, [])
  contactsCache.delete(me.uin)
})

console.log(`\nPEER LOOKUP: ${n}/${n} ok`)
