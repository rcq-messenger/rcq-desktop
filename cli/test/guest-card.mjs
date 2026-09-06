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
import { hashCard, newCard } from '../dist/vault.mjs'

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

console.log(`guest card: ${n}/${n} ok`)
