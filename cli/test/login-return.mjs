// Where a sign-in may be sent back to (src/lib/login-return.ts).
//
// The login screen reloads into whatever this function lets through, so a hole
// in it is an open redirect handed to anyone who can get a person to click a
// link. Only this app's own contact screens pass: /add with a query, /u/<uin>
// and /r/<uin>. Everything else is dropped, not repaired.
//
// Run: node cli/build.mjs && node cli/test/login-return.mjs

import assert from 'node:assert/strict'
import { safeReturnPath } from '../dist/vault.mjs'

let n = 0
const check = (label, fn) => { fn(); n++; console.log('  ok  ' + label) }

console.log('login return')

check('the three contact screens pass, normalised', () => {
  assert.equal(safeReturnPath('/add?q=123%40api.rcq.app'), '/add?q=123%40api.rcq.app')
  assert.equal(safeReturnPath('/u/123?h=is2.rcq.app'), '/u/123?h=is2.rcq.app')
  assert.equal(safeReturnPath('/r/42'), '/r/42')
  assert.equal(safeReturnPath('/r/42/'), '/r/42/')
})

check('the fragment never survives', () => {
  assert.equal(safeReturnPath('/u/123#c=secretcard'), '/u/123')
})

check('an empty Add screen is not an errand', () => {
  assert.equal(safeReturnPath('/add'), null)
  assert.equal(safeReturnPath('/add?'), null)
})

check('other origins and protocol tricks are refused', () => {
  for (const bad of [
    'https://evil.example/add?q=1',
    '//evil.example/add?q=1',
    '/\\evil.example/add?q=1',
    '\\\\evil.example',
    'javascript:alert(1)',
    'add?q=1',
    '/add\n?q=1',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(safeReturnPath(bad), null, String(bad))
  }
})

check('other screens of the app are refused', () => {
  for (const bad of ['/', '/contacts', '/settings', '/market', '/addx?q=1', '/u/abc', '/r/12/extra', '/u/']) {
    assert.equal(safeReturnPath(bad), null, bad)
  }
})

check('a dot segment cannot walk out of an allowed prefix', () => {
  assert.equal(safeReturnPath('/u/../settings'), null)
  assert.equal(safeReturnPath('/r/1/../../market'), null)
  assert.equal(safeReturnPath('/add/../contacts?q=1'), null)
})

check('an overlong value is refused', () => {
  assert.equal(safeReturnPath('/add?q=' + 'x'.repeat(2000)), null)
})

console.log(`login return: ${n} checks passed`)
