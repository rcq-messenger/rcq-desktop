// Fully-offline round-trip of the vault client (Stage 4 of the core-metadata
// plan). The island half is an in-memory model written to the server's
// contract (rcq-server-ref, test_stage4_vault_local.py): per-account slots,
// a write names the version it was based on and is refused with 409 and the
// current one otherwise, a delete leaves a tombstone whose version the next
// write must name, 404 carries the version. Everything driven against it is
// production code from src/lib/vault.ts and src/lib/contacts-vault.ts: the
// derivation, the sealed layout, the read-merge-write loop, the rollback
// floor, the fold of a server list into the contacts slot.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import { newTestIdentity, slotId, seal, open, readSlot, writeSlot, deleteSlot, listSlots, jsonBytes, bytesJson, VaultError, VAULT_CONTACTS, foldServerList, ApiError } from '../dist/vault.mjs'

/// One island's vault_slots table and the four routes over it.
function island() {
  const rows = new Map() // `${uin}:${slot}` -> { blob, version }
  const stale = (v) => new Response(JSON.stringify({ detail: { code: 'stale', version: v } }), { status: 409 })
  const fetch = async (url, init = {}) => {
    const u = new URL(url)
    const uin = Number(init.headers?.Authorization?.replace('Bearer uin-', ''))
    const m = u.pathname.match(/^\/vault(?:\/([0-9a-f]{32}))?$/)
    if (!m) return new Response('nope', { status: 404 })
    const slot = m[1]
    const key = `${uin}:${slot}`
    if (!slot && init.method === 'GET') {
      const slots = [...rows].filter(([k, r]) => k.startsWith(`${uin}:`) && r.blob !== null).map(([k, r]) => ({ slot: k.split(':')[1], version: r.version }))
      return new Response(JSON.stringify({ slots }))
    }
    const row = rows.get(key)
    if (init.method === 'GET') {
      if (!row || row.blob === null) return new Response(JSON.stringify({ detail: { code: 'no_slot', version: row?.version ?? 0 } }), { status: 404 })
      return new Response(JSON.stringify({ blob: row.blob, version: row.version }))
    }
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body)
      if (body.version === 0) {
        if (row) return stale(row.version)
        rows.set(key, { blob: body.blob, version: 1 })
        return new Response(JSON.stringify({ version: 1 }))
      }
      if (!row || row.version !== body.version) return stale(row?.version ?? 0)
      rows.set(key, { blob: body.blob, version: body.version + 1 })
      return new Response(JSON.stringify({ version: body.version + 1 }))
    }
    if (init.method === 'DELETE') {
      const version = Number(u.searchParams.get('version'))
      if (!row || row.blob === null) return new Response(null, { status: 204 })
      if (row.version !== version) return stale(row.version)
      rows.set(key, { blob: null, version: version + 1 })
      return new Response(null, { status: 204 })
    }
    return new Response('nope', { status: 405 })
  }
  return { rows, fetch }
}

const isl = island()
globalThis.fetch = isl.fetch
const A = { ...newTestIdentity(100001), jwt: 'uin-100001', apiBase: 'https://island.test' }
const A2 = { ...A } // the same account from a second device: same identity, same slots
const B = { ...newTestIdentity(100002), jwt: 'uin-100002', apiBase: 'https://island.test' }

// Derivation: deterministic per identity, per name, and nothing like the name.
const slot = slotId(A, VAULT_CONTACTS)
assert.match(slot, /^[0-9a-f]{32}$/)
assert.equal(slot, slotId(A2, VAULT_CONTACTS))
assert.notEqual(slot, slotId(B, VAULT_CONTACTS))
assert.notEqual(slot, slotId(A, 'something-else'))

// Sealed layout: opens under the right (identity, slot, version), under nothing else.
const blob = seal(A, slot, 1, jsonBytes({ x: 1 }))
assert.deepEqual(bytesJson(open(A, slot, 1, blob)), { x: 1 })
assert.throws(() => open(B, slot, 1, blob), (e) => e instanceof VaultError && e.code === 'bad_seal')
assert.throws(() => open(A, slot, 2, blob), (e) => e instanceof VaultError && e.code === 'bad_seal', 'the version is in the AAD')
assert.throws(() => open(A, slotId(A, 'other'), 1, blob), (e) => e instanceof VaultError && e.code === 'bad_seal', 'the slot is in the key')
// Size class, not size: a 10-byte and a 400-byte plaintext seal to the same length.
const short = seal(A, slot, 1, new Uint8Array(10))
const longer = seal(A, slot, 1, new Uint8Array(400))
assert.equal(short.length, longer.length)
assert.equal(open(A, slot, 1, longer).length, 400)

// Read-merge-write: first write from 0, then the #605 race.
assert.deepEqual(await readSlot(A, slot), { plaintext: null, version: 0 })
let v = await writeSlot(A, slot, (remote) => { assert.equal(remote, null); return jsonBytes({ c: ['a'] }) })
assert.equal(v, 1)
// Device 2 read v1. Device 1 writes v2 behind its back. Device 2's write must
// go around: its merge runs twice, the second time on device 1's content.
v = await writeSlot(A, slot, (remote) => jsonBytes({ c: [...bytesJson(remote).c, 'b'] }), 1)
assert.equal(v, 2)
let merges = 0
isl.rows.set(`100001:${slot}`, { blob: seal(A, slot, 3, jsonBytes({ c: ['a', 'b', 'phone'] })), version: 3 }) // the island moved on
v = await writeSlot(A2, slot, (remote, version) => { merges++; return jsonBytes({ c: [...bytesJson(remote).c, 'desktop'] }) }, 2)
assert.equal(v, 4)
assert.equal(merges, 1, 'readSlot always reads fresh, so the merge saw v3 directly')
// Now a real 409 mid-flight: the island bumps the slot between our read and our PUT.
const realFetch = isl.fetch
let bumped = false
globalThis.fetch = async (url, init) => {
  if (init?.method === 'PUT' && !bumped) {
    bumped = true
    isl.rows.set(`100001:${slot}`, { blob: seal(A, slot, 5, jsonBytes({ c: ['a', 'b', 'phone', 'desktop', 'tablet'] })), version: 5 })
  }
  return realFetch(url, init)
}
merges = 0
v = await writeSlot(A, slot, (remote) => { merges++; return jsonBytes({ c: [...bytesJson(remote).c, 'laptop'] }) }, 4)
assert.equal(v, 6)
assert.equal(merges, 2, 'the 409 made the merge run again on the fresh copy')
assert.deepEqual(bytesJson(open(A, slot, 6, isl.rows.get(`100001:${slot}`).blob)).c, ['a', 'b', 'phone', 'desktop', 'tablet', 'laptop'])
globalThis.fetch = realFetch
// merge returning null leaves the slot alone.
v = await writeSlot(A, slot, () => null, 6)
assert.equal(v, 6)
assert.equal(isl.rows.get(`100001:${slot}`).version, 6)

// Rollback floor.
await assert.rejects(readSlot(A, slot, 7), (e) => e instanceof VaultError && e.code === 'rolled_back')
isl.rows.set(`100001:${slot}`, { blob: seal(A, slot, 2, jsonBytes({ c: ['old'] })), version: 2 })
await assert.rejects(readSlot(A, slot, 6), (e) => e instanceof VaultError && e.code === 'rolled_back', 'an island serving an older version than seen is refused')
isl.rows.set(`100001:${slot}`, { blob: seal(A, slot, 6, jsonBytes({ c: ['a', 'b', 'phone', 'desktop', 'tablet', 'laptop'] })), version: 6 })

// Per account, listing, tombstones.
assert.deepEqual(await readSlot(B, slot), { plaintext: null, version: 0 })
assert.deepEqual([...(await listSlots(A))], [[slot, 6]])
await deleteSlot(A, slot, 6)
assert.deepEqual(await readSlot(A, slot, 6), { plaintext: null, version: 7 }, 'a tombstone reads as no plaintext with its version')
assert.deepEqual([...(await listSlots(A))], [])
await assert.rejects(readSlot(A, slot, 8), (e) => e.code === 'rolled_back', 'a tombstone below the floor is a rollback too')
v = await writeSlot(A, slot, () => jsonBytes({ c: [] }), 7)
assert.equal(v, 8, 'a write after a delete names the tombstone version, never 0')
await assert.rejects(deleteSlot(A, slot, 7), (e) => e instanceof ApiError && e.status === 409, 'a stale delete is refused')
await deleteSlot(A, slot, 8)
await deleteSlot(A, slot, 8)

// foldServerList: the mirror-phase rule (server wins), tombstones, no-op.
const now = 1_700_000_000_000
const list = (...uins) => uins.map((u) => (typeof u === 'number' ? { uin: u, nickname: `n${u}`, blocked: false } : u))
let cur = { v: 1, c: {}, g: {} }
let next = foldServerList(cur, list(1, 2), now)
assert.deepEqual(next, { v: 1, c: { 1: { a: now, u: now, n: 'n1' }, 2: { a: now, u: now, n: 'n2' } }, g: {} })
assert.equal(foldServerList(next, list(1, 2), now + 5), null, 'same list, nothing to write')
next = foldServerList(next, list(1, { uin: 2, nickname: 'n2', blocked: true }), now + 10)
assert.deepEqual(next.c[2], { a: now, u: now + 10, b: 1, n: 'n2' }, 'a changed flag updates u and keeps a')
next = foldServerList(next, list(2), now + 20)
assert.equal(next.c[1], undefined)
assert.equal(next.g[1], now + 20, 'an entry the server no longer has becomes a tombstone')
next = foldServerList(next, list(1, 2), now + 30)
assert.equal(next.g[1], undefined, 're-added: the tombstone goes')
assert.equal(next.c[1].a, now + 30)
next = foldServerList({ v: 1, c: {}, g: { 9: now } }, [], now + 91 * 24 * 3600 * 1000)
assert.deepEqual(next, { v: 1, c: {}, g: {} }, 'old tombstones are dropped')
assert.equal(foldServerList({ v: 1, c: {}, g: {} }, [], now), null)

console.log('vault: ok')
