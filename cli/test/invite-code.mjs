// The rule a field that asks for an access code has to follow (#1034).
//
// The case that cost us somebody: the invite sheet copies a LINK, the join
// field asks for a CODE, and the island answers a refusal naming three wrong
// reasons. Everything here is a string somebody really might paste.
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Bundled alone, like the presence-chime twin: the rule is DOM-free on purpose,
// so nothing here needs a browser, a socket or an island.
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcq-invite-')), 'rule.mjs')
await build({
  entryPoints: [path.join(root, 'src', 'lib', 'invite-code.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
})
const { inviteCodeOf, looksLikeInviteLink } = await import(out)

let ok = 0, fail = 0
const is = (name, got, want) => {
  if (got === want) { ok++; console.log('  ok  ', name) }
  else { fail++; console.log('  FAIL', name, '->', JSON.stringify(got), 'want', JSON.stringify(want)) }
}

const code = 'eEqhpf9aPc8xelRn8XSzFw1N'
is('the link the sheet copies', inviteCodeOf(`rcq://server/api.rcq.app?invite=${code}`), code)
is('a bare code is itself', inviteCodeOf(code), code)
is('spaces around it', inviteCodeOf(`  ${code} `), code)
is('a web link', inviteCodeOf(`https://rcq.app/join?invite=${code}`), code)
is('another parameter after', inviteCodeOf(`rcq://server/h?invite=${code}&ref=x`), code)
is('another parameter before', inviteCodeOf(`rcq://server/h?ref=x&invite=${code}`), code)
is('a fragment after', inviteCodeOf(`rcq://server/h?invite=${code}#top`), code)
is('case of the parameter', inviteCodeOf(`rcq://server/h?INVITE=${code}`), code)
is('a sentence full stop', inviteCodeOf(`${code}.`), code)
is('brackets', inviteCodeOf(`(rcq://server/h?invite=${code})`), code)
is('quotes', inviteCodeOf(`"${code}"`), code)
is('percent-encoded', inviteCodeOf('rcq://server/h?invite=a%2Bb%2Fc'), 'a+b/c')
is('empty is null', inviteCodeOf(''), null)
is('null is null', inviteCodeOf(null), null)
is('a link with no code is null', inviteCodeOf('rcq://server/api.rcq.app?invite='), null)
is('the host never travels as the code',
  inviteCodeOf(`rcq://server/api.rcq.app?invite=${code}`).includes('api.rcq.app'), false)
is('a link is recognised', looksLikeInviteLink(`rcq://server/h?invite=${code}`), true)
is('a code is not a link', looksLikeInviteLink(code), false)

console.log(`\nINVITE CODE: ${ok}/${ok + fail} ok`)
process.exit(fail ? 1 : 0)
