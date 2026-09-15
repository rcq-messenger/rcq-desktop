// The two C0 guards of the cross-island spec (2026-09-15), offline.
//
// Why these get a test of their own:
//   * P0.1: in a v=1 seal `from` and `from_host` are unsigned, and deposits are
//     open. A "carbon" naming our number was applied as ours, and its `ciack`
//     pins a cross-island contact's keys (crossisland-ack.ts), so anyone could
//     pin their own key for a contact of ours. The TRANSITIONAL rule, as iOS
//     ships it: a carbon that names a key must name OUR key, every inner kind;
//     a `ciack` carbon is taken only under our own key; a keyless (v=2) carbon
//     is taken for every other kind, because Android seals carbons v=2 until
//     0.194 has spread, and refusing them all stopped Android-side sends,
//     edits, deletes and reads from syncing to web and desktop. Once 0.194 has
//     spread, the keyless cases below flip to refused (the strict rule).
//   * P0.2: /auth/refresh now answers 404 `identity_rotated` (keys changed on
//     another device) and `identity_ambiguous` (the island will not guess).
//     Old clients read every such 404 as a burn. Neither may sign an account
//     out, and nothing may while a rotation is pending, or the first rotation
//     erases the account's other installs.
// Everything here is production code from src/lib/crossisland-gate.ts and
// src/lib/session-verdict.ts.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import {
  CARBON_KINDS_OWN_KEY_ONLY,
  bootAction,
  carbonIsOwn,
  mintFromRefusal,
  refusalCode,
} from '../dist/carbon-gate.mjs'

let n = 0
const check = (label, fn) => {
  fn()
  n++
  console.log('  ok  ' + label)
}

const OWN = Buffer.alloc(32, 0xfe).toString('base64')
const OWN_URL = Buffer.alloc(32, 0xfe).toString('base64url')
const MALLORY = Buffer.alloc(32, 3).toString('base64')
const HOME = 'a.example'
const ME = 12

// ── P0.1 carbons ────────────────────────────────────────────────────────────

// The inner kinds a carbon carries on the wire. `ciack` pins keys; the rest
// are what Android's v=2 carbons carry for a send, an edit, a delete, a read.
const CIACK = 'ciack'
const NON_CIACK = ['text', 'photo', 'video', 'file', 'voice', 'location', 'edit', 'delete', 'readmark', 'future-kind']
const ALL_KINDS = [CIACK, ...NON_CIACK]

const own = (senderUin, senderHost, senderKey, ownKey, groupRow, kind) =>
  carbonIsOwn(senderUin, ME, senderHost, HOME, senderKey, ownKey, groupRow, kind)

check('the kind input exists, and only ciack needs our own key', () => {
  assert.equal(carbonIsOwn.length, 8)
  // The one per-kind exception is a single, closed set. A new kind lands on
  // the keyless allowance only while the transitional rule lasts.
  assert.deepEqual([...CARBON_KINDS_OWN_KEY_ONLY], ['ciack'])
})

check('keyless (v=2) carbon, non-ciack kind: accepted (Android sends these)', () => {
  // TRANSITIONAL. Android seals carbons v=2 over its session with our other
  // installs: no `spub`, and usually no host (v=2 is same-island only).
  for (const kind of NON_CIACK) {
    assert.equal(own(ME, undefined, undefined, OWN, false, kind), true, kind)
    assert.equal(own(ME, undefined, null, OWN, false, kind), true, kind)
    assert.equal(own(ME, HOME, undefined, OWN, false, kind), true, kind)
    // The allowance does not consult our key, so a tab with no identity to
    // compare against changes nothing (as on iOS).
    assert.equal(own(ME, undefined, undefined, null, false, kind), true, kind)
  }
})

check('keyless (v=2) carbon, ciack: refused', () => {
  // The forgery: Mallory opens a libsignal PreKey session with her own
  // identity key, addressed as (our number, a device we never linked), and
  // deposits a carbon of ciack to pin her key for a contact of ours. It
  // decrypts and names no signing key. A ciack is taken only under our key.
  assert.equal(own(ME, undefined, undefined, OWN, false, CIACK), false)
  assert.equal(own(ME, undefined, null, OWN, false, CIACK), false)
  assert.equal(own(ME, HOME, undefined, OWN, false, CIACK), false)
  assert.equal(own(ME, undefined, undefined, null, false, CIACK), false)
})

check('keyless carbon with no readable inner kind: refused', () => {
  for (const kind of [undefined, null, '', 42, {}]) {
    assert.equal(own(ME, undefined, undefined, OWN, false, kind), false, String(kind))
  }
})

check('foreign spub: refused for EVERY kind', () => {
  for (const kind of ALL_KINDS) {
    assert.equal(own(ME, HOME, MALLORY, OWN, false, kind), false, kind)
    // No host at all (a pre-from_host seal) changes nothing.
    assert.equal(own(ME, undefined, MALLORY, OWN, false, kind), false, kind)
  }
})

check('a malformed or missing key on either side is never ours, every kind', () => {
  for (const kind of ALL_KINDS) {
    // A key named, but this tab has no identity to compare it with.
    assert.equal(own(ME, HOME, OWN, null, false, kind), false, kind)
    // An empty key string is a key that is not ours, not "no key".
    assert.equal(own(ME, HOME, '', OWN, false, kind), false, kind)
    // Not base64 at all.
    assert.equal(own(ME, HOME, '!!not-a-key!!', OWN, false, kind), false, kind)
    // Same bytes, one byte short.
    assert.equal(own(ME, HOME, Buffer.alloc(31, 0xfe).toString('base64'), OWN, false, kind), false, kind)
  }
})

check('out of a broadcast, or from another island, even under our key or keyless', () => {
  for (const kind of ALL_KINDS) {
    assert.equal(own(ME, undefined, OWN, OWN, true, kind), false, kind)
    assert.equal(own(ME, undefined, undefined, OWN, true, kind), false, kind)
    assert.equal(own(ME, 'b.example', OWN, OWN, false, kind), false, kind)
    assert.equal(own(ME, 'b.example', undefined, OWN, false, kind), false, kind)
  }
})

check('own spub: accepted for every kind, ciack included (the real sibling device)', () => {
  for (const kind of ALL_KINDS) {
    assert.equal(own(ME, HOME, OWN, OWN, false, kind), true, kind)
    // Padding / url-safe differences between writers do not matter.
    assert.equal(own(ME, HOME, OWN_URL, OWN, false, kind), true, kind)
    // A pre-from_host v=1 seal under our key is still ours.
    assert.equal(own(ME, undefined, OWN, OWN, false, kind), true, kind)
  }
})

check('the host is compared canonically: case, :443, a trailing dot', () => {
  // Android 0.194 seals carbons v=1 and stamps store.serverHost, a different
  // writer from our new URL(apiBase).host. Spelling must not refuse them.
  const flagship = (senderHost, ownHost, senderKey, kind) =>
    carbonIsOwn(ME, ME, senderHost, ownHost, senderKey, OWN, false, kind)
  for (const kind of ALL_KINDS) {
    for (const spelled of ['API.RCQ.APP', 'api.rcq.app:443', 'Api.Rcq.App.:443', 'api.rcq.app.', ' api.rcq.app ']) {
      assert.equal(flagship(spelled, 'api.rcq.app', OWN, kind), true, `${spelled} ${kind}`)
      // Either side may carry the odd spelling.
      assert.equal(flagship('api.rcq.app', spelled, OWN, kind), true, `own ${spelled} ${kind}`)
      // Canonical spelling buys a foreign key nothing.
      assert.equal(flagship(spelled, 'api.rcq.app', MALLORY, kind), false, `${spelled} ${kind}`)
    }
    // A non-default port is a different address, and another island stays one.
    assert.equal(flagship('api.rcq.app:8443', 'api.rcq.app', OWN, kind), false, kind)
    assert.equal(flagship('API.RCQ.APP.evil.example', 'api.rcq.app', OWN, kind), false, kind)
  }
  // The keyless allowance is unchanged by spelling: non-ciack in, ciack out.
  assert.equal(flagship('API.RCQ.APP:443', 'api.rcq.app', undefined, 'text'), true)
  assert.equal(flagship('API.RCQ.APP:443', 'api.rcq.app', undefined, CIACK), false)
})

check('somebody else\'s number is never a carbon of ours', () => {
  for (const kind of ALL_KINDS) {
    assert.equal(own(13, HOME, OWN, OWN, false, kind), false, kind)
    assert.equal(own(13, undefined, undefined, OWN, false, kind), false, kind)
  }
})

// ── P0.2 refresh refusals ───────────────────────────────────────────────────

const body = (detail) => JSON.stringify({ detail })
const ROTATED = body({ code: 'identity_rotated', uin: 4242 })
const AMBIGUOUS = body({ code: 'identity_ambiguous' })
const NOT_FOUND = body({ code: 'identity_not_found' })
const REVOKED = body({ code: 'device_revoked' })
const NO_ROUTE = body('Not Found')

check('refusal codes are read from both body shapes, never guessed', () => {
  assert.deepEqual(refusalCode(ROTATED), { code: 'identity_rotated', uin: 4242 })
  assert.deepEqual(refusalCode(NOT_FOUND), { code: 'identity_not_found' })
  assert.deepEqual(refusalCode(NO_ROUTE), { code: 'Not Found' })
  assert.deepEqual(refusalCode('<html>identity_not_found</html>'), { code: null })
  assert.deepEqual(refusalCode('null'), { code: null })
  assert.deepEqual(refusalCode(''), { code: null })
})

check('identity_rotated: kept, flagged, never dead, with or without a pending rotation', () => {
  for (const pending of [false, true]) {
    const m = mintFromRefusal(404, ROTATED, pending)
    assert.deepEqual(m, { token: null, dead: false, unsupported: false, rotated: true, uin: 4242 })
    assert.equal(bootAction(m), 'rotated')
  }
  // The number is optional on the wire.
  assert.equal(mintFromRefusal(404, body({ code: 'identity_rotated' }), false).uin, undefined)
})

check('identity_ambiguous: never dead, goes to the moved-account notice', () => {
  for (const pending of [false, true]) {
    const m = mintFromRefusal(404, AMBIGUOUS, pending)
    assert.equal(m.dead, false)
    assert.equal(m.unsupported, false)
    assert.equal(m.ambiguous, true)
    assert.equal(bootAction(m), 'stranded')
  }
})

check('identity_not_found signs out only when no rotation is pending', () => {
  assert.equal(bootAction(mintFromRefusal(404, NOT_FOUND, false)), 'signout')
  const pending = mintFromRefusal(404, NOT_FOUND, true)
  assert.equal(pending.dead, false)
  assert.equal(bootAction(pending), 'keep')
})

check('device_revoked signs out only when no rotation is pending', () => {
  assert.equal(bootAction(mintFromRefusal(401, REVOKED, false)), 'signout')
  assert.equal(bootAction(mintFromRefusal(401, REVOKED, true)), 'keep')
  // Any other 401 is a miss, not a sign-out.
  assert.equal(bootAction(mintFromRefusal(401, body({ code: 'stale' }), false)), 'keep')
})

check('a code that merely CONTAINS identity_not_found has none of its power', () => {
  for (const code of ['identity_not_found_v2', 'not identity_not_found', 'IDENTITY_NOT_FOUND']) {
    const m = mintFromRefusal(404, body({ code }), false)
    assert.equal(m.dead, false, code)
    assert.notEqual(bootAction(m), 'signout', code)
  }
  // The old text.includes reading would have signed this out.
  assert.equal(mintFromRefusal(404, '{"detail":"identity_not_found is not a route"}', false).dead, false)
})

check('an island without the endpoint is unsupported, never dead', () => {
  assert.deepEqual(mintFromRefusal(404, NO_ROUTE, false), { token: null, dead: false, unsupported: true })
  assert.deepEqual(mintFromRefusal(404, 'not json', false), { token: null, dead: false, unsupported: true })
  assert.deepEqual(mintFromRefusal(405, '', false), { token: null, dead: false, unsupported: true })
  assert.deepEqual(mintFromRefusal(500, NOT_FOUND, false), { token: null, dead: false, unsupported: false })
})

check('under a pending rotation NOTHING signs out, whatever the island answers', () => {
  const bodies = [ROTATED, AMBIGUOUS, NOT_FOUND, REVOKED, NO_ROUTE, '', 'garbage']
  for (const status of [400, 401, 403, 404, 405, 409, 429, 500, 503]) {
    for (const b of bodies) {
      assert.notEqual(bootAction(mintFromRefusal(status, b, true)), 'signout', `${status} ${b}`)
    }
  }
})

check('rotated and ambiguous never sign out, whatever the pending state', () => {
  for (const b of [ROTATED, AMBIGUOUS]) {
    for (const pending of [false, true]) {
      assert.notEqual(bootAction(mintFromRefusal(404, b, pending)), 'signout')
    }
  }
})

check('boot action for a working mint is unchanged', () => {
  assert.equal(bootAction({ token: 't', dead: false, unsupported: false }), 'token')
  assert.equal(bootAction({ token: 't', dead: false, unsupported: false, movedTo: 99 }), 'moved')
  assert.equal(bootAction({ token: null, dead: false, unsupported: false }), 'keep')
  assert.equal(bootAction({ token: null, dead: false, unsupported: true }), 'keep')
})

console.log(`carbon-gate: ok (${n} checks)`)
