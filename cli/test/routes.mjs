// Fully-offline test of the circumvention pieces: the signed relay config, the
// DoH TXT channel it can also arrive over, and the sing-box config the CLI
// writes for a sing-box it does not ship.
//
// The three things worth proving without a network, because each one fails
// SILENTLY in production:
//
//   1. Canonical JSON. One byte off and the Ed25519 signature does not verify,
//      and a client that cannot verify a payload falls back to its bundled
//      list forever without saying anything. Checked against the real live
//      payload (fixtures/relay-config-v146.json) AND against what Python's
//      `json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)`
//      produced for it, which is the signer.
//   2. The version floor. A replayed OLD signed payload needs no forgery, and
//      it walks a client back onto relays we retired.
//   3. The tiering in the emitted config. A community relay that can win a
//      urltest race becomes the sole hop and sees client-IP with the island
//      (relay-distribution-v2.md, amendment B); a community relay that can be
//      an onion ENTRY sees the client's address on a broker's say-so
//      (amendment C). Both are shape questions, and shape is testable here.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Before the bundle is loaded: every state read must land in a throwaway dir.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rcq-routes-'))
process.env.RCQ_CLI_HOME = home

const {
  buildDnsQuery,
  buildSingBox,
  canonical,
  parseDnsTxt,
  parseJson,
  relays,
  resetForTest,
  saveRoutesState,
  verifyAndParse,
} = await import('../dist/routes.mjs')

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8')

// -----------------------------------------------------------------
// 1. Canonical JSON, byte-for-byte with the Python signer.
// -----------------------------------------------------------------

const signedText = fixture('relay-config-v146.json')
const pythonCanonical = fixture('relay-config-v146.canonical.txt')
const node = parseJson(signedText)
const withoutSig = { k: 'obj', v: node.v.filter(([k]) => k !== 'sig') }
assert.equal(canonical(withoutSig), pythonCanonical, 'canonical JSON must match the signer byte for byte')

// The escaping rules, one at a time. Python escapes the two mandatory
// characters and the five short forms, writes anything else below 0x20 as
// \uXXXX, and touches NOTHING else: no escaped slashes, no escaped non-ASCII.
assert.equal(canonical(parseJson('{"b":1,"a":2}')), '{"a":2,"b":1}', 'keys sort')
assert.equal(canonical(parseJson('{"a":{"z":1,"y":2}}')), '{"a":{"y":2,"z":1}}', 'and sort recursively')
assert.equal(canonical(parseJson('["b","a"]')), '["b","a"]', 'array order is content, never sorted')
assert.equal(canonical(parseJson('{"u":"a/b"}')), '{"u":"a/b"}', 'slashes stay bare')
assert.equal(canonical(parseJson('{"u":"\\u00e9"}')), '{"u":"é"}', 'non-ASCII stays bare')
assert.equal(canonical(parseJson('{"u":"a\\nb\\tc"}')), '{"u":"a\\nb\\tc"}', 'short forms')
assert.equal(canonical(parseJson('{"u":"\\u0001"}')), '{"u":"\\u0001"}', 'other control chars as \\uXXXX')
// ★ Numbers keep their SOURCE TEXT. This is the reason the payload is parsed a
// second time rather than re-serialised from JSON.parse: a signer that wrote
// 1.0 or 1e3 and a client that re-emits 1 or 1000 disagree by the whole
// signature, and today's all-integer payloads hide it.
assert.equal(canonical(parseJson('{"n":1.0}')), '{"n":1.0}')
assert.equal(canonical(parseJson('{"n":1e3}')), '{"n":1e3}')
assert.equal(canonical(parseJson('{"n":-0.50}')), '{"n":-0.50}')
assert.equal(canonical(parseJson('{"n":146}')), '{"n":146}')
assert.throws(() => parseJson('{"n":01}'), 'a leading zero is not JSON')
assert.throws(() => parseJson('{"a":1} trailing'), 'trailing bytes are not JSON')

// -----------------------------------------------------------------
// 2. Verification, and the replay floor.
// -----------------------------------------------------------------

resetForTest()
const parsed = verifyAndParse(signedText)
assert.ok(parsed, 'the live signed payload verifies under a key this build pins')
assert.equal(parsed.version, 146)
assert.equal(parsed.relays.length, 14)
assert.equal(parsed.onionEnabled, true, 'the fleet has onion on in the signed config')
// Priority order, not file order: the sing-box config and the onion entry both
// read the first entries as the best ones.
assert.equal(parsed.relays[0].tag, 'relay-do-fra-spaces-hy2')
assert.equal(parsed.relays[1].proto, 'vless')
assert.ok(parsed.relays[1].publicKey && parsed.relays[1].shortId, 'reality fields survive the parse')
// No `transport` block in this payload, so the compiled-in names stand.
assert.equal(parsed.front, 'cdn.rcq.app')
assert.equal(parsed.probe, 'https://api.rcq.app/health')
assert.deepEqual(parsed.sources, [{ kind: 'dns-txt', value: 'cfg.northfieldlabs.fyi' }])

// One byte of the SIGNED half moved: refused.
const tampered = signedText.replace('165.22.90.214', '165.22.90.215')
assert.notEqual(tampered, signedText)
assert.equal(verifyAndParse(tampered), null, 'a changed relay address invalidates the signature')
// A truncated or absent signature is a refusal, never a throw: this runs on
// fetch paths whose only correct move is to keep the list they already have.
const shortSig = signedText.replace(/"sig":\s*"[^"]+"/, '"sig": "AAAA"')
assert.notEqual(shortSig, signedText, 'the sig field was actually replaced')
assert.equal(verifyAndParse(shortSig), null, 'a signature that is not 64 bytes is a refusal, not a throw')
assert.equal(verifyAndParse('{"relays":[]}'), null, 'no sig at all')
assert.equal(verifyAndParse('not json'), null)
assert.equal(verifyAndParse('[1,2,3]'), null, 'a payload that is not an object')

// The floor. Same genuine payload, refused because we already trust a newer one.
assert.equal(verifyAndParse(signedText, 147), null, 'a replayed older version is refused')
assert.ok(verifyAndParse(signedText, 146), 'the same version is not a rollback')
assert.ok(verifyAndParse(signedText, 1))

// -----------------------------------------------------------------
// 3. DNS over HTTPS: the channel that survives both mirror names being blocked.
// -----------------------------------------------------------------

// The query: one question, ID zero (RFC 8484 - a cached DoH response must not
// be keyed on a random id), recursion desired, TXT/IN.
const q = buildDnsQuery('cfg.northfieldlabs.fyi')
assert.deepEqual(
  [...q.subarray(0, 12)],
  [0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0],
  'header: id 0, RD, one question',
)
assert.equal(q[12], 3, 'first label length')
assert.equal(Buffer.from(q.subarray(13, 16)).toString(), 'cfg')
assert.deepEqual([...q.subarray(q.length - 5)], [0, 0, 16, 0, 1], 'root label, TXT, IN')
assert.equal(buildDnsQuery('a'.repeat(64)), null, 'a label over 63 bytes is not a name')
assert.equal(buildDnsQuery('a..b'), null, 'an empty label is not a name')
assert.deepEqual(buildDnsQuery('x.y'), buildDnsQuery('.x.y.'), 'leading and trailing dots are noise')

// A response, built here so the parser is tested against bytes it did not
// write: two answers, ours second, the name given as a compression pointer,
// and the payload split across character-strings the way a >255-byte record
// has to be.
function dnsResponse(strings, { extraAnswer = true } = {}) {
  const head = Buffer.alloc(12)
  head.writeUInt16BE(0x8180, 2)
  head.writeUInt16BE(1, 4)
  head.writeUInt16BE(extraAnswer ? 2 : 1, 6)
  const qname = Buffer.concat([Buffer.from([1, 0x78, 1, 0x79]), Buffer.from([0])]) // x.y
  const question = Buffer.concat([qname, Buffer.from([0, 16, 0, 1])])
  const rr = (type, rdata) => {
    const h = Buffer.alloc(12)
    h.writeUInt16BE(0xc00c, 0) // pointer back to the question name
    h.writeUInt16BE(type, 2)
    h.writeUInt16BE(1, 4)
    h.writeUInt32BE(300, 6)
    h.writeUInt16BE(rdata.length, 10)
    return Buffer.concat([h, rdata])
  }
  const cs = (s) => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s, 'ascii')])
  const charStrings = Buffer.concat(strings.map(cs))
  const parts = [head, question]
  // A record that is NOT ours first: a name that also carries SPF must not
  // confuse the reader, which is what the rcq1: prefix is for.
  if (extraAnswer) parts.push(rr(16, cs('v=spf1 -all')))
  parts.push(rr(16, charStrings))
  return new Uint8Array(Buffer.concat(parts))
}

const payload = Buffer.from('{"hello":"world"}', 'utf8').toString('base64')
const wire = 'rcq1:' + payload
const chunks = [wire.slice(0, 40), wire.slice(40)]
assert.equal(parseDnsTxt(dnsResponse(chunks)), payload, 'strings of one record concatenate in order')
assert.equal(parseDnsTxt(dnsResponse([wire])), payload, 'one string works too')
assert.equal(parseDnsTxt(dnsResponse(['v=spf1 -all'], { extraAnswer: false })), null, 'no record of ours')
assert.equal(parseDnsTxt(new Uint8Array([1, 2, 3])), null, 'a truncated message is not an answer')
assert.equal(parseDnsTxt(dnsResponse(chunks).subarray(0, 30)), null, 'a message cut mid-record is refused')

// -----------------------------------------------------------------
// 4. The sing-box config, and the two tiering rules that matter.
// -----------------------------------------------------------------

// A listener that accepts, so an "entry" can be genuinely reachable, and a
// port nothing is on, so one can genuinely not be.
const live = net.createServer(() => {})
await new Promise((r) => live.listen(0, '127.0.0.1', r))
const livePort = live.address().port

const vless = (tag, port) => ({
  tag,
  proto: 'vless',
  server: '127.0.0.1',
  port,
  sni: 'example.invalid',
  uuid: 'u',
  publicKey: 'p',
  shortId: 's',
  flow: 'xtls-rprx-vision',
})

// Single hop with no broker relays: one urltest over everything trusted.
resetForTest()
const plain = await buildSingBox({ onion: false })
assert.equal(plain.shape, 'single-hop')
assert.equal(plain.config.inbounds[0].listen_port, 1089)
assert.equal(plain.config.inbounds[0].listen, '127.0.0.1', 'the inbound is never on a public address')
const out0 = plain.config.outbounds[0]
assert.equal(out0.tag, 'out')
assert.equal(out0.type, 'urltest')
assert.equal(out0.outbounds.length, relays().length)
assert.equal(plain.communityCount, 0)
// ★ The default outbound is NAMED. With no `route.final`, sing-box sends
// everything through the FIRST outbound in the file (verified against sing-box
// 1.13.12), so array order silently becomes a routing decision - and
// `sing-box check` reports nothing either way.
assert.equal(plain.config.route.final, 'out', 'route.final names the selector')
// Every relay in the bundled seed is emitted with the fields sing-box needs.
const hy2 = plain.config.outbounds.find((o) => o.type === 'hysteria2')
assert.ok(hy2.obfs.type === 'salamander' && hy2.obfs.password, 'hysteria2 keeps its obfs')
assert.equal(hy2.tls.insecure, true, 'the relay cert is self-signed; auth is the password')
const vl = plain.config.outbounds.find((o) => o.type === 'vless')
assert.equal(vl.tls.reality.enabled, true)
assert.equal(vl.tls.utls.fingerprint, 'chrome')

// ★ Amendment B: a broker relay must NOT be able to win the race. It enters
// through a nested urltest behind a tolerance wide enough that only a real
// failure of the trusted group can move traffic onto it.
const community = [{ ...vless('br-1', 1), tag: 'br-1' }]
const tiered = await buildSingBox({ onion: false, community })
const outT = tiered.config.outbounds.find((o) => o.tag === 'out')
const comm = tiered.config.outbounds.find((o) => o.tag === 'community')
assert.ok(comm, 'the broker pool is its own group')
assert.deepEqual(comm.outbounds, ['br-1'])
assert.equal(outT.outbounds[outT.outbounds.length - 1], 'community', 'and it is the LAST member of out')
// ★★ Being the last member of `out` is worth nothing if `out` is never
// consulted. The community group used to be emitted FIRST, which made it
// sing-box's default outbound: 100% of the traffic through broker relays, the
// exact inversion of amendment B, while the CLI printed "fallback only, never
// an entry". Both halves are pinned here.
assert.equal(tiered.config.outbounds[0].tag, 'out', 'the selector is the first outbound')
assert.equal(tiered.config.route.final, 'out', 'and it is named as the default')
assert.ok(outT.tolerance >= 3000, 'behind a wide tolerance, so latency alone cannot pull traffic onto it')
assert.equal(comm.tolerance, 50, 'inside the community group an ordinary race is fine')
assert.equal(tiered.communityCount, 1)
// A broker row naming a relay the signed list already has is not a second relay.
const dup = await buildSingBox({
  onion: false,
  community: [{ ...relays()[1], tag: 'br-dup' }],
})
assert.equal(dup.communityCount, 0, 'deduped by proto:server:port, signed entry kept')

// Onion. Which of the two shapes comes out depends on whether the relay fleet
// answers a TCP connect from the machine running this test, and that is not
// something a unit test gets to decide - so the invariants are checked for
// whichever shape it is, and BOTH of them are invariants worth holding:
//
//   * a formed chain has exactly one entry, every exit detours through it, and
//     the entry is never a relay the broker named (amendment C);
//   * a chain that could not form leaves NO half-built detour behind, and
//     races the signed list only - single-hopping somebody who opted into
//     onion through a relay they never vouched for is the thing this whole
//     branch exists to avoid.
const trustedTags = new Set(relays().map((r) => r.tag))
function checkOnion(built, communityTags) {
  assert.ok(['onion', 'onion-degraded'].includes(built.shape), 'onion resolves to one of two shapes')
  assert.equal(built.config.outbounds[0].tag, 'out', 'the selector is always first')
  if (built.shape === 'onion') {
    assert.equal(built.entryReachable, true, 'a chain is only built on an entry that answered')
    const entries = built.config.outbounds.filter((o) => o.tag === 'onion-entry')
    assert.equal(entries.length, 1, 'exactly one entry')
    assert.ok(!entries[0].detour, 'and the entry itself rides nothing')
    assert.ok(trustedTags.has(built.entry), 'the entry comes from the signed list')
    assert.ok(!communityTags.includes(built.entry), 'a broker relay is never promoted to the onion entry')
    const exits = built.config.outbounds.filter((o) => o.tag?.startsWith('onion-') && o.tag !== 'onion-entry')
    assert.ok(exits.length >= 1)
    for (const o of exits) assert.equal(o.detour, 'onion-entry', 'every exit rides the entry')
    assert.ok(!exits.some((o) => o.tag === `onion-${built.entry}`), 'the entry is not also an exit')
  } else {
    assert.equal(built.entryReachable, false)
    assert.ok(built.config.outbounds.every((o) => !o.detour), 'no half-built chain is left behind')
    for (const o of built.config.outbounds) {
      if (o.type === 'vless' || o.type === 'hysteria2') {
        assert.ok(trustedTags.has(o.tag), 'a degraded onion races the signed list ONLY')
      }
    }
  }
}

resetForTest()
saveRoutesState({ onionEntry: null })
const onion = await buildSingBox({ onion: true, community: [], port: 1090 })
assert.equal(onion.config.inbounds[0].listen_port, 1090)
checkOnion(onion, [])

// The same with a community pool that DOES answer, which is the shape of the
// attack amendment C is about: a broker that says "trusted" about a relay it
// controls, hoping to be handed the one hop that sees the client's address.
resetForTest()
const bait = [vless('br-e1', livePort), vless('br-e2', livePort), vless('br-e3', livePort)]
const onionCommunity = await buildSingBox({ onion: true, community: bait })
checkOnion(onionCommunity, ['br-e1', 'br-e2', 'br-e3'])

// A pinned entry is KEPT while it answers: the Tor guard property. Pinning one
// of the reachable local listeners is not possible (it is not in the signed
// list), so this checks the other direction - a pin naming a relay that is not
// a candidate at all is quietly replaced rather than honoured.
resetForTest()
saveRoutesState({ onionEntry: 'relay-that-was-retired' })
const repinned = await buildSingBox({ onion: true, community: [] })
assert.notEqual(repinned.entry, 'relay-that-was-retired', 'a stale pin does not survive')
checkOnion(repinned, [])

// The broker descriptor, which does NOT spell its fields the way the signed
// config does.
//
// ⚠ This is a caught regression, not a hypothetical. The broker serves the
// vless-URL spelling (`pbk`, `sid`) because it shares the shape of the in-chat
// relay-share card; reading only `public_key` / `short_id` produced a relay
// with an empty Reality key, and `sing-box check` refuses the WHOLE file for
// one bad outbound - so a single community descriptor took all fourteen
// trusted relays down with it.
const { fetchBridges } = await import('../dist/routes.mjs')
const realFetch = globalThis.fetch
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      relays: [
        {
          proto: 'vless',
          server: '146.190.232.70',
          port: 443,
          sni: 'ams3.digitaloceanspaces.com',
          uuid: '90e6967f-15b1-415f-bf49-e553bc76f842',
          pbk: 'tCWDa7AWcKyxZh8dR81YQn8KgMWImlUZcz7789sd5Ak',
          sid: 'b48d262ad2003588',
          flow: 'xtls-rprx-vision',
          tier: 'community',
        },
        // The same relay in the long spelling, so a future broker that changes
        // its mind is not broken by the fix for the one that has not.
        { proto: 'vless', server: '10.0.0.1', port: 443, sni: 's', uuid: 'u', public_key: 'k', short_id: 'i' },
        // Junk that must not reach the file: no uuid, no key, no port.
        { proto: 'vless', server: '10.0.0.2', port: 443, sni: 's' },
        { proto: 'hysteria2', server: '10.0.0.3', port: 443, sni: 's' },
        { proto: 'vless', server: '10.0.0.4', sni: 's', uuid: 'u', pbk: 'k' },
        // Hysteria2 in the broker's own spelling: `pw` and `obfs`
        // (backend `_PROTO_KEYS`), not `password` and `obfs_password`.
        { proto: 'hysteria2', server: '10.0.0.5', port: 443, sni: 's', pw: 'secret', obfs: 'salt' },
      ],
    }),
  )
const bridges = await fetchBridges('https://island.test')
globalThis.fetch = realFetch
assert.equal(bridges.length, 5, 'a descriptor with no port is not a relay at all')
assert.equal(bridges[0].publicKey, 'tCWDa7AWcKyxZh8dR81YQn8KgMWImlUZcz7789sd5Ak', 'pbk is read')
assert.equal(bridges[0].shortId, 'b48d262ad2003588', 'sid is read')
assert.equal(bridges[1].publicKey, 'k', 'and the long spelling still works')
// ⚠ The same bug, the same file, the other protocol: reading only
// `password`/`obfs_password` dropped every Hysteria2 relay the broker handed
// out, and the CLI then blamed the network for an answer it had received.
const hy2Bridge = bridges.find((r) => r.server === '10.0.0.5')
assert.equal(hy2Bridge.password, 'secret', 'the broker spells the hysteria2 password `pw`')
assert.equal(hy2Bridge.obfsPassword, 'salt', 'and the obfs password `obfs`')

// And the ones that cannot become a valid outbound never reach the config.
resetForTest()
const filtered = await buildSingBox({ onion: false, community: bridges })
assert.equal(filtered.communityCount, 3, 'the two unusable descriptors are dropped')
const commTags = filtered.config.outbounds.find((o) => o.tag === 'community').outbounds
assert.equal(commTags.length, 3)
const commHy2 = filtered.config.outbounds.find((o) => o.tag === hy2Bridge.tag)
assert.equal(commHy2.password, 'secret', 'a broker hysteria2 relay reaches the config with its password')
assert.equal(commHy2.obfs.password, 'salt')
for (const o of filtered.config.outbounds) {
  if (o.type === 'vless') assert.ok(o.uuid && o.tls.reality.public_key, 'no half-formed vless outbound')
  if (o.type === 'hysteria2') assert.ok(o.password, 'no half-formed hysteria2 outbound')
}

// ★★ Behind a proxy NOTHING is probed. The entry probe is a raw TCP connect,
// which Node's env-proxy does not cover, so probing here opened a plaintext
// connection from the user's real address to every signed-config relay while
// the process believed it was behind Tor. The entry is chosen from the pin (or
// at random) instead, and the build says the measurement was not taken.
resetForTest()
saveRoutesState({ onionEntry: null })
process.env.RCQ_PROXY_ENGAGED = '1'
const behindProxy = await buildSingBox({ onion: true, community: bait })
delete process.env.RCQ_PROXY_ENGAGED
assert.equal(behindProxy.entryProbed, false, 'no probe is taken behind a proxy')
assert.equal(behindProxy.shape, 'onion', 'and an onion user still gets a chain')
checkOnion(behindProxy, ['br-e1', 'br-e2', 'br-e3'])
// Unproxied, the probe is taken and reported as taken.
resetForTest()
const unproxied = await buildSingBox({ onion: true, community: [] })
assert.equal(unproxied.entryProbed, true)

live.close()

// -----------------------------------------------------------------
// 5. The front rewrite. One caller missed is a request that still names the
//    blocked host, which on a censored network is a hang and not a clean
//    failure - so this checks the edge rather than any one call site.
// -----------------------------------------------------------------

const { installRouting, setFrontEngagedForTest } = await import('../dist/routes.mjs')

const seenFetch = []
const passedFetch = []
const seenSocket = []
// Installed BEFORE installRouting, so it is the layer underneath the rewrite.
// (installRouting captures whatever fetch it finds; replacing the global again
// afterwards would put the recorder on top and measure nothing.)
globalThis.fetch = (input) => {
  seenFetch.push(typeof input === 'string' ? input : input.url)
  passedFetch.push(input)
  return Promise.resolve(new Response('{}'))
}
class FakeSocket {
  constructor(url) {
    seenSocket.push(url)
  }
}
FakeSocket.CONNECTING = 0
FakeSocket.OPEN = 1
FakeSocket.CLOSING = 2
FakeSocket.CLOSED = 3
globalThis.WebSocket = FakeSocket

installRouting()

// Off: nothing moves, whatever shape the input takes.
setFrontEngagedForTest(false)
await fetch('https://api.rcq.app/contacts')
assert.deepEqual(seenFetch, ['https://api.rcq.app/contacts'])

setFrontEngagedForTest(true)
seenFetch.length = 0
await fetch('https://api.rcq.app/contacts')
await fetch(new URL('https://api.rcq.app/messages/queue'))
await fetch(new Request('https://api.rcq.app/keys/devices', { method: 'POST', body: 'x' }))
// Everything that is not the flagship is left exactly alone: another island,
// a mirror, a resolver. Sending a self-hosted island through the front would
// turn a working server into a 404.
await fetch('https://is2.rcq.app/contacts')
await fetch('https://raw.githubusercontent.com/x/y')
// And a host that merely STARTS with the flagship's name is not the flagship.
await fetch('https://api.rcq.app.evil.example/contacts')
assert.deepEqual(seenFetch, [
  'https://cdn.rcq.app/contacts',
  'https://cdn.rcq.app/messages/queue',
  'https://cdn.rcq.app/keys/devices',
  'https://is2.rcq.app/contacts',
  'https://raw.githubusercontent.com/x/y',
  'https://api.rcq.app.evil.example/contacts',
])

// The socket follows the same rewrite, or a client would sail through the
// front for its requests while its one long-lived connection kept dialling
// the blocked address.
new WebSocket('wss://api.rcq.app/ws/100200?token=t')
new WebSocket('wss://is2.rcq.app/ws/100200?token=t')
assert.deepEqual(seenSocket, ['wss://cdn.rcq.app/ws/100200?token=t', 'wss://is2.rcq.app/ws/100200?token=t'])
// `WebSocket.OPEN` is read off the constructor by the socket loop, so a
// wrapper that drops the constants breaks it silently.
assert.equal(WebSocket.OPEN, 1)
assert.equal(WebSocket.CLOSED, 3)

// A Request input is REBUILT around the new URL rather than passed through,
// and it keeps its method and body: the only way to redirect a Request is to
// make another one, and a rebuild that dropped the body would turn every
// authenticated POST into an empty one.
seenFetch.length = 0
passedFetch.length = 0
await fetch(new Request('https://api.rcq.app/keys/devices', { method: 'POST', body: 'hello' }))
const rebuilt = passedFetch[0]
assert.ok(rebuilt instanceof Request, 'still a Request')
assert.equal(rebuilt.url, 'https://cdn.rcq.app/keys/devices')
assert.equal(rebuilt.method, 'POST')
assert.equal(await rebuilt.text(), 'hello')
// installRouting is idempotent: a second call must not wrap the wrapper, or
// the rewrite would run twice and the deadline once per layer.
installRouting()
seenFetch.length = 0
await fetch('https://api.rcq.app/health')
assert.deepEqual(seenFetch, ['https://cdn.rcq.app/health'])

fs.rmSync(home, { recursive: true, force: true })
console.log('routes: ok')
