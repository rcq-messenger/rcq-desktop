// The presence-chime rule (src/lib/presence-chime.ts), offline.
//
// The same cases as the Android twin (PresenceChimeTest.kt), because the two
// clients ship one rule between them and #1030 was filed against both. Bundles
// the module ALONE with esbuild: it is DOM-free on purpose, so nothing here
// needs a browser, a socket or an island.
//
// Run: npm run cli:test

import assert from 'node:assert/strict'
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcq-chime-')), 'rule.mjs')
await build({
  entryPoints: [path.join(root, 'src', 'lib', 'presence-chime.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
})
const { decidePresenceChime, presenceIsAround, BULK_FLOOR, PER_CONTACT_COOLDOWN_MS } =
  await import(out)

const NOW = 10_000_000
const flip = (uin, online, favorite = false, muted = false) => ({ uin, online, favorite, muted })
const decide = (flips, { mode = 'all', departures = true, last = new Map(), now = NOW } = {}) =>
  decidePresenceChime(flips, mode, departures, last, now)

let n = 0
const ok = (what, cond) => { assert.ok(cond, what); n++; console.log('  ok  ', what) }
const eq = (what, a, b) => { assert.deepEqual(a, b, what); n++; console.log('  ok  ', what) }

console.log('\n-- one burst, one sound --')
eq('a single arrival chimes', decide([flip(134, true)]), { uin: 134, online: true })
eq('a single departure chimes while departures are on', decide([flip(134, false)]), { uin: 134, online: false })
eq('nothing happened, nothing sounds', decide([]), null)
eq('a wave is the network, not a room filling up',
  decide(Array.from({ length: 12 }, (_, i) => flip(i + 1, i % 2 === 0))), null)
ok('three is still a room, four is weather', BULK_FLOOR === 4)
eq('three chimes', decide([flip(1, true), flip(2, false), flip(3, true)]), { uin: 1, online: true })
eq('four does not', decide([flip(1, true), flip(2, false), flip(3, true), flip(4, false)]), null)
eq('the bulk test counts what survived the filters',
  decide([...Array.from({ length: 20 }, (_, i) => flip(i + 1, true)), flip(999, true, true)], { mode: 'favorites' }),
  { uin: 999, online: true })

console.log('\n-- who is worth a sound --')
eq('off is silent', decide([flip(134, true)], { mode: 'off' }), null)
eq('favorites hears only favourites', decide([flip(134, true)], { mode: 'favorites' }), null)
eq('...and hears them', decide([flip(134, true), flip(7, true, true)], { mode: 'favorites' }), { uin: 7, online: true })
eq('a muted thread is silent', decide([flip(134, true, false, true)]), null)
eq('muting one contact does not silence another',
  decide([flip(134, true, false, true), flip(9, false)]), { uin: 9, online: false })

console.log('\n-- two directions, two switches --')
eq('departures can be silenced alone', decide([flip(134, false)], { departures: false }), null)
eq('arrivals survive that', decide([flip(134, true)], { departures: false }), { uin: 134, online: true })
eq('a silenced departure does not count toward the wave',
  decide([flip(1, false), flip(2, false), flip(3, false), flip(4, true)], { departures: false }),
  { uin: 4, online: true })

console.log('\n-- the flap --')
eq('a contact that just chimed stays quiet',
  decide([flip(134, false)], { last: new Map([[134, NOW - 1000]]) }), null)
eq('and speaks again once the cooldown is spent',
  decide([flip(134, false)], { last: new Map([[134, NOW - PER_CONTACT_COOLDOWN_MS]]) }),
  { uin: 134, online: false })
eq("one contact's cooldown does not silence another",
  decide([flip(134, true), flip(77, true)], { last: new Map([[134, NOW - 1000]]) }),
  { uin: 77, online: true })
eq('a contact with no history is not held back by the clock',
  decide([flip(134, true)], { now: 500 }), { uin: 134, online: true })

console.log('\n-- the pick is deliberate --')
eq('a favourite outranks a stranger', decide([flip(2, true), flip(88, false, true)]), { uin: 88, online: false })
eq('among equals an arrival outranks a departure', decide([flip(3, false), flip(5, true)]), { uin: 5, online: true })
const three = [flip(31, false), flip(12, false), flip(20, false)]
eq('the same input always picks the same contact', decide(three), { uin: 12, online: false })
eq('and order of arrival changes nothing', decide([...three].reverse()), { uin: 12, online: false })

console.log('\n-- away and dnd are "around" --')
ok('online counts', presenceIsAround('online'))
ok('away counts', presenceIsAround('away'))
ok('dnd counts', presenceIsAround('dnd'))
ok('offline does not', !presenceIsAround('offline'))

console.log(`\nPRESENCE CHIME: ${n}/${n} ok\n`)
