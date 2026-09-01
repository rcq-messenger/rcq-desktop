// The half of the conformance corpus that needs no DOM: addresses and CSS.
// The sanitiser half is scripts/conformance.html, since DOMParser is a browser.
//
//   npx esbuild src/lib/sites.ts --bundle --format=esm --outfile=/tmp/sites.mjs
//   node scripts/run-conformance.mjs /tmp/sites.mjs
import { readFileSync } from 'node:fs'
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
const mod = await import(process.argv[2] ?? './sites-bundle.mjs')
const { parseRcqAddress, _internal } = mod
const corpus = JSON.parse(readFileSync('/Users/tager/Documents/RCQ/docs/rcq-sites-conformance.json', 'utf8'))

let pass = 0, fail = 0
for (const [i, c] of corpus.addresses.entries()) {
  const got = parseRcqAddress(c.input, c.ownHost)
  const ok = c.expect === null
    ? got === null
    : got !== null && got.name === c.expect.name && got.host === c.expect.host
  if (ok) pass++
  else { fail++; console.log(`ADDRESS[${i}] ${JSON.stringify(c.input)} -> ${JSON.stringify(got)} want ${JSON.stringify(c.expect)}`) }
}
for (const [i, c] of corpus.css.entries()) {
  const out = _internal.cleanCss(c.css)
  const bad = (c.mustNotContain || []).filter((n) => out.includes(n))
  if (bad.length === 0) pass++
  else { fail++; console.log(`CSS[${i}] still contains ${JSON.stringify(bad)}\n   in: ${JSON.stringify(out).slice(0, 160)}`) }
}
console.log(`\naddresses+css: ${pass} pass, ${fail} fail`)
