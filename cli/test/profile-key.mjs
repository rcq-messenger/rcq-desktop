// The profile key and the slot it lives in (#1031).
//
// The bug this pins: `ensureMyProfileKey` asked the island for the slot
// literally named "pkey". The island's route accepts 32 lower-case hex
// characters and NOTHING else, so FastAPI refused the request with 422 before
// the handler ran, the ApiError travelled all the way out of the avatar
// upload, and every attempt to set a picture from the web or the desktop
// ended in a flat "could not upload the picture". Android derived the slot
// properly and worked, which is exactly how it was reported: "on Windows it
// will not upload, on Android it does". Proved afterwards on the island's own
// access log: `GET /vault/pkey 422`.
//
// The island model below therefore enforces the slot pattern the way the real
// one does. Everything driven against it is production code.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import { newTestIdentity, seal, slotId, ensureMyProfileKey, loadProfileKeys, loadPublishedProfileKey, myProfileKey, profileKeyOfAccount, entitledToMyProfileKey, fanOutMyProfileKey, contactsCache, VAULT_PKEY } from '../dist/vault.mjs'

/// One island's vault, with the route's own slot validation in front of it.
function island() {
  const rows = new Map() // `${uin}:${slot}` -> { blob, version }
  const seen = [] // every slot name the island was ASKED for, valid or not
  let down = false
  const fetch = async (url, init = {}) => {
    const u = new URL(url)
    const uin = Number(init.headers?.Authorization?.replace('Bearer uin-', ''))
    const m = u.pathname.match(/^\/vault\/(.+)$/)
    if (!m) return new Response('nope', { status: 404 })
    seen.push(m[1])
    // ⚠ The whole point of this file. `_SLOT_RE = "^[0-9a-f]{32}$"` in
    // app/routers/vault.py, checked by FastAPI before the handler exists.
    if (!/^[0-9a-f]{32}$/.test(m[1])) {
      return new Response(JSON.stringify({ detail: [{ type: 'string_pattern_mismatch' }] }), { status: 422 })
    }
    if (down) return new Response(JSON.stringify({ detail: 'boom' }), { status: 500 })
    const key = `${uin}:${m[1]}`
    const row = rows.get(key)
    if (init.method === 'GET' || !init.method) {
      if (!row) return new Response(JSON.stringify({ detail: { code: 'no_slot', version: 0 } }), { status: 404 })
      return new Response(JSON.stringify({ blob: row.blob, version: row.version }))
    }
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body)
      const cur = row?.version ?? 0
      if (body.version !== cur) {
        return new Response(JSON.stringify({ detail: { code: 'stale', version: cur } }), { status: 409 })
      }
      rows.set(key, { blob: body.blob, version: cur + 1 })
      return new Response(JSON.stringify({ version: cur + 1 }))
    }
    return new Response('nope', { status: 405 })
  }
  return { rows, seen, fetch, fail: (on) => { down = on } }
}

const isl = island()
globalThis.fetch = isl.fetch
const A = { ...newTestIdentity(100001), jwt: 'uin-100001', apiBase: 'https://island.test' }
const B = { ...newTestIdentity(100002), jwt: 'uin-100002', apiBase: 'https://island.test' }

// 1. The name is hashed, never sent. This alone is the reported bug.
loadProfileKeys(A.uin)
const k1 = await ensureMyProfileKey(A)
assert.match(k1, /^[A-Za-z0-9+/]{43}=$/, 'a base64 AES-256 key')
assert.ok(isl.seen.length > 0, 'the island was actually asked')
for (const s of isl.seen) assert.match(s, /^[0-9a-f]{32}$/, `sent a malformed slot: ${s}`)
assert.ok(!isl.seen.includes(VAULT_PKEY), 'the literal name must never reach the island')

// 2. It is the slot Android derives from the same literal (crypto/Vault.kt).
const slot = slotId(A, VAULT_PKEY)
assert.ok(isl.rows.has(`${A.uin}:${slot}`), 'the key was published under slotId(identity, "pkey")')
assert.notEqual(slot, slotId(B, VAULT_PKEY), 'per account')

// 3. A second install of the SAME account adopts the published key rather than
//    minting a rival one — the failure the whole vault mirror exists to stop.
loadProfileKeys(A.uin)
assert.equal(myProfileKey(), null, 'a fresh install starts empty')
const k2 = await ensureMyProfileKey({ ...A })
assert.equal(k2, k1)
assert.equal(myProfileKey(), k1)

// 4. Another account gets its own key.
loadProfileKeys(B.uin)
const kB = await ensureMyProfileKey(B)
assert.notEqual(kB, k1)

// 5. Two installs minting at the SAME moment converge on one key: publishing
//    first wins and the loser adopts, instead of both handing out their own.
const C = { ...newTestIdentity(100003), jwt: 'uin-100003', apiBase: 'https://island.test' }
loadProfileKeys(C.uin)
const slotC = slotId(C, VAULT_PKEY)
let raced = false
const plain = isl.fetch
globalThis.fetch = async (url, init = {}) => {
  // The sibling's write lands between our read and our PUT.
  if (!raced && init.method === 'PUT' && new URL(url).pathname.endsWith(slotC)) {
    raced = true
    await plain(`https://island.test/vault/${slotC}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer uin-100003' },
      body: JSON.stringify({ blob: sealedSibling, version: 0 }),
    })
  }
  return plain(url, init)
}
// What the sibling publishes, sealed exactly as the vault client would.
const sibling = 'c2libGluZy1rZXktMzItYnl0ZXMtbG9uZy1wYWRkaW5nPQ=='
const sealedSibling = seal(C, slotC, 1, new TextEncoder().encode(sibling))
const kC = await ensureMyProfileKey(C)
assert.ok(raced, 'the race actually happened')
assert.equal(kC, sibling, 'the loser adopts the published key')
assert.equal(myProfileKey(), sibling)
globalThis.fetch = plain

// 6. An island that cannot answer at all does NOT get to make us mint a rival
//    key behind a published one: the caller is told, and retries.
const D = { ...newTestIdentity(100004), jwt: 'uin-100004', apiBase: 'https://island.test' }
loadProfileKeys(D.uin)
isl.fail(true)
await assert.rejects(() => ensureMyProfileKey(D), 'a 500 is doubt, not permission to mint')
isl.fail(false)
const kD = await ensureMyProfileKey(D)
assert.match(kD, /^[A-Za-z0-9+/]{43}=$/)

// 7. WHO MAY BE HANDED THE KEY. The key is account-wide and never rotates, so
//    one answer is every picture the account will ever publish. Both shipped
//    clients used to answer whoever asked.
const ME = 100001
const contact = (uin, extra = {}) => ({ uin, nickname: `u${uin}`, status: 'offline', blocked: false, identity_key: 'ik', signing_key: 'sk', ...extra })
contactsCache.set(ME, { contacts: [contact(555), contact(666, { blocked: true }), contact(777, { host: 'is2.test' })], groups: [], pending: [], me: null })
assert.equal(entitledToMyProfileKey(ME, 555), true, 'an accepted contact')
assert.equal(entitledToMyProfileKey(ME, 999), false, 'a stranger who merely knows the number')
assert.equal(entitledToMyProfileKey(ME, 666), false, 'somebody blocked')
assert.equal(entitledToMyProfileKey(ME, 777), false, 'the same digits on ANOTHER island is a different person')
// ⚠ Fail CLOSED: no roster on this device is not a reason to hand out a key.
contactsCache.delete(ME)
assert.equal(entitledToMyProfileKey(ME, 555), false, 'no roster yet answers no')

// 8. The fan-out has the same audience. Rows that must never receive it are
//    skipped before any crypto runs, so a roster made only of them sends none.
let sends = 0
const noFetch = globalThis.fetch
globalThis.fetch = async (...a) => { sends += 1; return noFetch(...a) }
const sent = await fanOutMyProfileKey(A, [
  contact(666, { blocked: true }),
  contact(777, { host: 'is2.test' }),
  { uin: 888, nickname: 'no key', status: 'offline', blocked: false, signing_key: 'sk' },
], k1)
globalThis.fetch = noFetch
assert.equal(sent, 0, 'blocked, cross-island and key-less rows are not an audience')
assert.equal(sends, 0, 'and nothing was even attempted for them')

// 9. The account switcher reads an account's own key BY NUMBER. For the
//    account currently loaded that is the in-memory copy; for another account
//    it is that account's own localStorage row, which node does not have — so
//    here it is null, and the point of the check is that it never hands back
//    the WRONG account's key.
loadProfileKeys(D.uin)
await loadPublishedProfileKey(D)
assert.equal(profileKeyOfAccount(D.uin), myProfileKey(), 'the loaded account reads its own')
assert.equal(profileKeyOfAccount(A.uin), null, 'and never another account\'s')

console.log('profile-key: ok')
