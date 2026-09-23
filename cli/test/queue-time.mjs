// The time a message drained out of the queue is shown at (#1038/#1039).
//
// A desktop started at 09:40 drained two voice notes sent at 23:18 the night
// before, one from the other person and one from our own phone (a carbon), and
// drew both at 09:40. Neither envelope had a `ts` (all three clients send it
// only beside a `ttl`), and both paths fell back to the moment of the drain:
// the received half ignored the island's `received_at` it had already stored,
// and the carbon half never saw it at all.
//
// This runs the REAL stores (src/lib/incoming-store.ts, outgoing-store.ts), not
// a copy of the rule: the queue drain's own `serverStampMs`, then `addIncoming`
// and `fileOutgoingCarbon` exactly as `route()` calls them, then the time the
// conversation prints. Bundled alone with esbuild, with IndexedDB swapped for
// a map and the few browser globals the modules touch stubbed out.
//
// Run: npm run cli:test

import assert from 'node:assert/strict'
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The reporter's clock: Moscow, so 20:18Z is "23:18 yesterday" and 06:40Z is
// "09:40 today". Set before anything formats a date.
process.env.TZ = 'Europe/Moscow'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcq-queue-time-')), 'stores.mjs')
await build({
  stdin: {
    contents: `
      export * from './src/lib/incoming-store'
      export { fileOutgoingCarbon, loadPersisted, storageKey } from './src/lib/outgoing-store'
      export { LATE_ARRIVAL_MS, noteIslandClock, resetIslandClock, clockOffsetMs } from './src/lib/message-time'
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  define: { 'import.meta.env': '{}' },
  logLevel: 'warning',
  plugins: [
    {
      // IndexedDB -> a map. Nothing here reads history back from disk.
      name: 'memory-idb',
      setup(b) {
        b.onResolve({ filter: /^\.\/signal-persist$/ }, () => ({ path: 'signal-persist', namespace: 'mem' }))
        b.onLoad({ filter: /.*/, namespace: 'mem' }, () => ({
          loader: 'ts',
          contents: `
            const m = new Map<string, unknown>()
            export async function idbGet<T>(k: string): Promise<T | undefined> { return m.get(k) as T | undefined }
            export async function idbGetFlat<T>(k: string): Promise<T | undefined> { return m.get(k) as T | undefined }
            export async function idbSet(k: string, v: unknown): Promise<void> { m.set(k, v) }
            export async function idbDel(k: string): Promise<void> { m.delete(k) }
            export async function idbKeys(): Promise<string[]> { return [...m.keys()] }
            export async function idbClearAll(): Promise<void> { m.clear() }
            export async function idbCarryKey(): Promise<boolean> { return false }
          `,
        }))
      },
    },
  ],
})

// The browser globals the stores touch at import or on this path.
const bus = new EventTarget()
globalThis.window = globalThis
globalThis.addEventListener = bus.addEventListener.bind(bus)
globalThis.removeEventListener = bus.removeEventListener.bind(bus)
globalThis.dispatchEvent = bus.dispatchEvent.bind(bus)
const ls = new Map()
globalThis.localStorage = {
  get length() { return ls.size },
  key: (i) => [...ls.keys()][i] ?? null,
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => void ls.set(k, String(v)),
  removeItem: (k) => void ls.delete(k),
  clear: () => ls.clear(),
}

// This device's clock, moved by hand: the stores read Date.now() when they file.
let clock = Date.parse('2026-09-23T06:40:12Z')
Date.now = () => clock

const S = await import(out)

let n = 0
const check = (label, fn) => {
  fn()
  n++
  console.log('  ok  ' + label)
}
const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const day = (ms) => new Date(ms).toDateString()

const PEER = 777
const SENT = '2026-09-22T20:18:05.123456Z' // how the island serialises received_at
const SENT_MS = Date.parse(SENT)
const voice = (id, extra = {}) => ({ kind: 'voice', id, mediaID: 'm-' + id, mediaKey: 'k-' + id, durationSec: 10, ...extra })
const rowOf = (id) => S.incomingSnapshots().peers.get(PEER)?.find((r) => r.id === id)

// A drain is catch-up: no chime, no banner (the sound module has no Audio here).
S.beginCatchUp()

check('a queued voice note from the other person shows the time it was sent, not the drain', () => {
  // Exactly the drain: `ingestPrimaryRow` turns received_at into srvAt, and
  // `route()` hands it to addIncoming.
  const srvAt = S.serverStampMs(SENT)
  assert.equal(srvAt, SENT_MS, 'the island stamp must parse')
  S.addIncoming(PEER, voice('in-1'), srvAt)
  const row = rowOf('in-1')
  assert.ok(row, 'the row was filed')
  assert.equal(row.at, clock, '`at` stays this device\'s ingest time')
  assert.equal(S.incomingShownAt(row), SENT_MS)
  assert.equal(hhmm(S.incomingShownAt(row)), '23:18', 'printed as 23:18, not 09:40')
  assert.notEqual(day(S.incomingShownAt(row)), day(clock), 'and under yesterday, not today')
})

check('a queued carbon of our own voice note from the phone shows the phone\'s send time', () => {
  const srvAt = S.serverStampMs(SENT)
  S.fileOutgoingCarbon({ kind: 'carbon', to: PEER, env: voice('own-1') }, srvAt)
  const row = S.loadPersisted(S.storageKey(false, PEER)).find((r) => r.id === 'own-1')
  assert.ok(row, 'the carbon was filed')
  assert.equal(row.sentAt, SENT_MS)
  assert.equal(hhmm(row.sentAt), '23:18')
})

check('the envelope\'s own ts still wins where there is one (a disappearing message)', () => {
  const ts = Math.floor(Date.parse('2026-09-22T20:17:30Z') / 1000)
  S.addIncoming(PEER, { kind: 'text', id: 'in-ttl', text: 'x', ttl: 604800, ts }, S.serverStampMs(SENT))
  assert.equal(S.incomingShownAt(rowOf('in-ttl')), ts * 1000)
  S.fileOutgoingCarbon({ kind: 'carbon', to: PEER, env: { kind: 'text', id: 'own-ttl', text: 'y', ttl: 604800, ts } }, S.serverStampMs(SENT))
  assert.equal(S.loadPersisted(S.storageKey(false, PEER)).find((r) => r.id === 'own-ttl').sentAt, ts * 1000)
})

check('a live row keeps this device\'s clock, even on a clock a few minutes fast', () => {
  // The frame's server_time, 3 minutes behind a fast local clock: the row must
  // sort by the same clock as our own messages, or a reply jumps above them.
  clock = Date.parse('2026-09-23T07:00:00Z')
  const serverTime = new Date(clock - 3 * 60_000).toISOString().replace('Z', '+00:00')
  S.addIncoming(PEER, voice('live-1'), S.serverStampMs(serverTime))
  assert.equal(S.incomingShownAt(rowOf('live-1')), clock)
  S.fileOutgoingCarbon({ kind: 'carbon', to: PEER, env: voice('own-live') }, S.serverStampMs(serverTime))
  assert.equal(S.loadPersisted(S.storageKey(false, PEER)).find((r) => r.id === 'own-live').sentAt, clock)
})

check('the queued copy of a row already filed live does not move it', () => {
  const liveAt = clock
  const deposit = new Date(liveAt).toISOString()
  // Hours later the same row comes off the queue with the same deposit stamp.
  clock = liveAt + 10 * 3600_000
  S.addIncoming(PEER, voice('live-1'), S.serverStampMs(deposit))
  S.fileOutgoingCarbon({ kind: 'carbon', to: PEER, env: voice('own-live') }, S.serverStampMs(deposit))
  assert.equal(S.incomingSnapshots().peers.get(PEER).filter((r) => r.id === 'live-1').length, 1)
  assert.equal(S.incomingShownAt(rowOf('live-1')), liveAt)
  const own = S.loadPersisted(S.storageKey(false, PEER)).filter((r) => r.id === 'own-live')
  assert.equal(own.length, 1)
  assert.equal(own[0].sentAt, liveAt)
})

check('a backlog drained in one go keeps its order, and sorts before what is written after', () => {
  const G = 4242
  clock = Date.parse('2026-09-23T06:40:12Z')
  const stamps = [
    '2026-09-22T20:18:05Z', // yesterday
    '2026-09-23T06:30:00Z', // ten minutes before the drain
    '2026-09-23T06:37:30Z', // under the margin: filed at the drain, as before
  ]
  stamps.forEach((s, i) => {
    clock += 5 // the drain files one row after another
    S.addGroupIncoming(G, PEER, voice('g-' + i), S.serverStampMs(s))
  })
  const shown = S.incomingSnapshots().groups.get(G).map(S.incomingShownAt)
  assert.deepEqual(shown.slice(0, 2), [Date.parse(stamps[0]), Date.parse(stamps[1])])
  assert.ok(shown[2] - Date.parse(stamps[2]) <= S.LATE_ARRIVAL_MS)
  for (let i = 1; i < shown.length; i++) assert.ok(shown[i] > shown[i - 1], 'ascending, as deposited')
  // Something typed on this computer right after the drain sorts below all of it.
  assert.ok(Date.now() + 1000 > shown[shown.length - 1])
})

// ── a clock that is not the island's ─────────────────────────────────────
//
// The review of this change caught what the checks above could not: an island
// stamp compared with THIS computer's clock folds the whole difference between
// the two into "how late did this arrive". Six minutes fast was enough to put
// every live incoming row onto the island's clock and every reply above the
// question it answered. The fix reads the island's clock off the socket's pong
// and compares everything in local time; these pin it both ways.

const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00')

for (const minutes of [6, 180]) {
  check(`on a clock ${minutes} minutes fast, a live reply sorts below the message it answers`, () => {
    S.resetIslandClock()
    const SKEW = minutes * 60_000
    const islandNow = Date.parse('2026-09-23T08:00:00Z')
    clock = islandNow + SKEW
    // A pong: the island's clock, read 40 ms before it reached us.
    S.noteIslandClock(iso(islandNow), clock + 40)
    assert.ok(Math.abs(S.clockOffsetMs() - SKEW) <= 100, 'the offset is read off the pong')
    // Our question, typed here and stamped with this computer's clock.
    const asked = clock + 1000
    // Their reply, live, two seconds later; the frame carries the island's time.
    clock = asked + 2000
    S.addIncoming(PEER, voice('skew-' + minutes), S.serverStampMs(iso(clock - SKEW - 30)))
    const shown = S.incomingShownAt(rowOf('skew-' + minutes))
    assert.ok(shown > asked, `the reply (${shown}) must sort after the question (${asked})`)
    assert.equal(shown, clock, 'a live row keeps this computer\'s clock')
  })
}

check('on a fast clock, the night\'s backlog still shows when it was sent, on this clock', () => {
  S.resetIslandClock()
  const SKEW = 180 * 60_000
  const islandMorning = Date.parse('2026-09-23T06:40:00Z')
  clock = islandMorning + SKEW
  S.noteIslandClock(iso(islandMorning), clock + 40)
  const night = Date.parse('2026-09-22T20:18:05Z')
  S.addIncoming(PEER, voice('night-fast'), S.serverStampMs(iso(night)))
  const shown = S.incomingShownAt(rowOf('night-fast'))
  assert.ok(Math.abs(shown - (night + SKEW)) <= 100, 'the send moment, as this computer\'s clock reads it')
})

check('on a clock three hours slow, the island\'s stamps are not refused as "from the future"', () => {
  S.resetIslandClock()
  const SKEW = -180 * 60_000
  const islandMorning = Date.parse('2026-09-23T06:40:00Z')
  clock = islandMorning + SKEW
  const recent = islandMorning - 60_000
  assert.equal(S.serverStampMs(iso(recent)), undefined, 'with no reading of the island yet: refused, exactly as before')
  S.noteIslandClock(iso(islandMorning), clock + 40)
  assert.equal(S.serverStampMs(iso(recent)), recent, 'one pong later the same stamp is accepted')
  const night = Date.parse('2026-09-22T20:18:05Z')
  S.addIncoming(PEER, voice('night-slow'), S.serverStampMs(iso(night)))
  const shown = S.incomingShownAt(rowOf('night-slow'))
  assert.ok(Math.abs(shown - (night + SKEW)) <= 100)
})

check('the smallest reading wins, and a stale one ages out', () => {
  S.resetIslandClock()
  const island = Date.parse('2026-09-23T09:00:00Z')
  // Three pongs with different latencies: the true offset is 0.
  S.noteIslandClock(iso(island), island + 900)
  S.noteIslandClock(iso(island + 25_000), island + 25_000 + 40)
  S.noteIslandClock(iso(island + 50_000), island + 50_000 + 300)
  assert.equal(S.clockOffsetMs(), 40, 'the least-latency sample is the estimate')
  // The computer's clock is then corrected by +2 h; eleven minutes on, the
  // readings from before the correction have left the window.
  const later = island + 11 * 60_000
  S.noteIslandClock(iso(later), later + 2 * 3600_000 + 40)
  assert.equal(S.clockOffsetMs(), 2 * 3600_000 + 40)
  S.resetIslandClock()
})

S.endCatchUp()
console.log(`queue-time: ${n} checks passed`)
// The history store schedules a coalesced write; nothing here needs it.
process.exit(0)
