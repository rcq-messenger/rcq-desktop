// The guest-card digest, against the island's own Python.
//
// A card is 32 bytes a client generates; the island is told only
// sha256(card). If the two sides compute that differently by so much as a
// trimmed byte, every card registered by a client opens nothing, and the
// symptom is not an error anywhere — it is a stranger being told "no such
// user" by a closed island, which is exactly what the refusal is designed to
// look like when it is working correctly. A silent, undebuggable failure is
// worth a cross-language test.
//
// Run: npm run cli:test

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { hashCard, newCard, buildContactLink, parseContactLink, mergeCards } from '../dist/vault.mjs'

let n = 0
const check = (label, fn) => { fn(); n++; console.log('  ok  ' + label) }

const py = (raw) =>
  execFileSync('python3', [
    '-c',
    'import hashlib,sys;print(hashlib.sha256(sys.argv[1].strip().encode("utf-8")).hexdigest())',
    raw,
  ], { encoding: 'utf8' }).trim()

console.log('guest card')

check('a fresh card is 32 bytes of url-safe base64', () => {
  const c = newCard()
  assert.match(c, /^[A-Za-z0-9_-]+$/, 'must survive a URL fragment untouched')
  // 32 bytes -> 43 base64 characters with the padding stripped.
  assert.equal(c.length, 43)
})

check('two cards are never the same', () => {
  const seen = new Set()
  for (let i = 0; i < 500; i++) seen.add(newCard())
  assert.equal(seen.size, 500)
})

check('the digest matches the island, byte for byte', () => {
  for (let i = 0; i < 20; i++) {
    const c = newCard()
    assert.equal(hashCard(c), py(c))
  }
})

check('surrounding whitespace is trimmed the same way on both sides', () => {
  // A card pasted out of a message or a link often arrives with a space.
  const c = newCard()
  assert.equal(hashCard('  ' + c + '\n'), py(c))
  assert.equal(hashCard(c), hashCard(' ' + c + ' '))
})

check('a non-ascii card would still agree (utf-8 on both sides)', () => {
  const odd = 'кириллица-и-emoji-🙂'
  assert.equal(hashCard(odd), py(odd))
})

check('the digest is lowercase hex of the right length', () => {
  assert.match(hashCard(newCard()), /^[0-9a-f]{64}$/)
})

// ── the link: a credential that must not reach a server ────────────────────

check('the card rides in the FRAGMENT, never the query', () => {
  const card = newCard()
  const link = buildContactLink({ uin: 911, host: 'is2.rcq.app' }, { sk: 'AAAA', ik: 'BBBB' }, 'https://rcq.app', card)
  const [before, frag] = link.split('#')
  assert.ok(frag, 'there must be a fragment at all')
  assert.equal(before.includes(card), false, 'the card must not be in the path or the query')
  assert.match(frag, /^c=/)
  // The public key card still travels where it always did.
  assert.match(before, /[?&]h=is2\.rcq\.app/)
  assert.match(before, /[?&]k=AAAA/)
})

check('a link with no card is byte for byte what it always was', () => {
  const a = buildContactLink({ uin: 911, host: 'api.rcq.app' }, { sk: 'AAAA' })
  const b = buildContactLink({ uin: 911, host: 'api.rcq.app' }, { sk: 'AAAA' }, 'https://rcq.app', null)
  assert.equal(a, b)
  assert.equal(a.includes('#'), false)
})

check('the fragment survives a round trip, keys and all', () => {
  const card = newCard()
  const link = buildContactLink({ uin: 4242, host: 'is2.rcq.app' }, { sk: 'QUJD', ik: 'WFla' }, 'https://rcq.app', card)
  const u = new URL(link)
  const parsed = parseContactLink(u.pathname.split('/').pop(), u.search, u.hash)
  assert.equal(parsed.card, card)
  assert.equal(parsed.address.uin, 4242)
  assert.equal(parsed.address.host, 'is2.rcq.app')
})

check('an old link, parsed by a new client, simply has no card', () => {
  const parsed = parseContactLink('911', '?h=is2.rcq.app', '')
  assert.equal(parsed.card, undefined)
})

check('an absurdly long fragment is refused rather than sent as a header', () => {
  const parsed = parseContactLink('911', '', '#c=' + 'A'.repeat(500))
  assert.equal(parsed.card, undefined)
})

// ── surviving a reinstall ──────────────────────────────────────────────────
//
// Cards other people gave us are the ONLY way to reach them on a closed
// island, and losing them looks exactly like the island working correctly:
// "no such number" is what a closed island tells a caller with no card. So the
// merge has one job, never to lose one.

check('the union keeps what each device holds alone', () => {
  const out = mergeCards({ '1@a': 'x' }, { '2@b': 'y' })
  assert.deepEqual(out, { '1@a': 'x', '2@b': 'y' })
})

check('a card this device just received wins over the stored one', () => {
  // Somebody revoked and re-shared; the device holding the new one is right.
  assert.deepEqual(mergeCards({ '1@a': 'new' }, { '1@a': 'old' }), { '1@a': 'new' })
})

check('an empty slot never erases the device', () => {
  assert.deepEqual(mergeCards({ '1@a': 'x' }, {}), { '1@a': 'x' })
})

check('an empty device is filled from the slot: this is the reinstall', () => {
  assert.deepEqual(mergeCards({}, { '1@a': 'x', '2@b': 'y' }), { '1@a': 'x', '2@b': 'y' })
})

check('commutative in what it keeps, and stable in byte order', () => {
  const a = mergeCards({ '2@b': 'y' }, { '1@a': 'x' })
  const b = mergeCards({ '1@a': 'x' }, { '2@b': 'y' })
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'or two devices rewrite the slot at each other')
  assert.deepEqual(Object.keys(a), ['1@a', '2@b'], 'sorted')
})

console.log(`guest card: ${n}/${n} ok`)
