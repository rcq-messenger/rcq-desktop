// The name on a group member (#982). A member who left the room used to show
// as their number above every message, and a reply to them sent the number to
// everyone as the quote's author. The order is production code from
// src/lib/member-name.ts.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import { isNumberOnly, memberName, quotedAuthorNames } from '../dist/member-name.mjs'

// Each source wins over everything after it.
const all = { alias: 'Mum', roster: 'anna', lastKnown: 'anna_old', contact: 'Anna K', quoted: 'Anna Q' }
assert.equal(memberName(42, all), 'Mum')
assert.equal(memberName(42, { ...all, alias: undefined }), 'anna')
assert.equal(memberName(42, { ...all, alias: undefined, roster: undefined }), 'anna_old')
assert.equal(memberName(42, { ...all, alias: undefined, roster: undefined, lastKnown: null }), 'Anna K')
assert.equal(memberName(42, { quoted: 'Anna Q' }), 'Anna Q')
assert.equal(memberName(42, {}), '42')

// Blank values fall through rather than naming somebody "".
assert.equal(memberName(7, { alias: '', roster: '   ', lastKnown: 'bob' }), 'bob')

// The wire name is the same order without the alias: the caller leaves it out.
const { alias: _drop, ...wire } = all
assert.equal(memberName(42, wire), 'anna')

// A quote whose author is only digits was made after the name was lost.
assert.equal(isNumberOnly('12345'), true)
assert.equal(isNumberOnly('anna1'), false)
assert.equal(memberName(99, { quoted: '99' }), '99')
assert.equal(memberName(99, { quoted: '12345' }), '99')

// Quote authors are tied to the member through the quoted message's sender.
const senders = [
  { id: 'A', from: 5 },
  { id: 'B', from: 6 },
]
const quoting = [
  { at: 10, replyTo: { id: 'A', authorName: 'old five' } },
  { at: 30, replyTo: { id: 'A', authorName: 'five' } },
  { at: 20, replyTo: { id: 'A', authorName: 'middle five' } },
  { at: 40, replyTo: { id: 'B', authorName: '6' } }, // digits: ignored
  { at: 50, replyTo: { id: 'Z', authorName: 'nobody' } }, // not loaded: ignored
  { at: 60 },
]
const q = quotedAuthorNames(senders, quoting)
assert.equal(q.get(5), 'five')
assert.equal(q.has(6), false)
assert.equal(q.size, 1)

console.log('member-name: ok')
