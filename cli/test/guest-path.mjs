// Guest copies through a paid door (spec 2026-09-15), offline: which path a
// join takes, what each refusal says, what a group frame may never carry, and
// both join paths run end to end against a fake island.
//
// Why this gets a test of its own:
//   * The new routes may be used ONLY where /server/info says
//     `guest_accounts_v1: true`. Anywhere else (old islands, open islands, is2)
//     the join has to stay byte for byte the recover-first registration it was.
//   * No guest path may ever send `desired_uin`: a guest copy on our home
//     number would tell that island which number we hold at home.
//   * `identity_rotated` must never fall back to registering (a wipe by other
//     means), a refusal must not fall back to the door, and a 5xx takes the
//     key we already have there.
//   * A group frame is never acted on as 1:1 traffic (section 7).
// Everything here is production code from src/lib/guest-path.ts,
// src/lib/guest-register.ts and src/lib/crossisland-gate.ts.
//
// Run: npm run cli:test   (builds first; this imports the BUILT bundle)

import assert from 'node:assert/strict'

// The bundle's modules read localStorage lazily (the island card cache); the
// console has none of its own here.
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size
  },
}

const {
  GROUP_FRAME_DROP,
  GUEST_COPY_NOT_BACKUP,
  GuestJoinError,
  cardIsStale,
  canonicalKeyB64,
  decideGuestPath,
  doorRefusalOf,
  ed25519,
  groupAddErrorKey,
  groupFrameDropped,
  guestAddBody,
  guestAttemptVerdict,
  guestCredentialsFor,
  guestJoinErrorKey,
  guestProofBytes,
  guestRefusalOf,
  guestSettleErrorKey,
  hideAddInRoom,
  lastResidentLeave,
  leaveWarnAfterFetch,
  leaveWarningVerdict,
  legacyGuestRegisterBody,
  legacyNicknameRepairBody,
  nameCarriesNumber,
  rosterSelfIsGuest,
  rotatedElsewhereRefusal,
  WIRE_KINDS,
  GUEST_NICKNAME_PLACEHOLDER,
  IDENTITY_ROTATED,
  ROTATED_ELSEWHERE_EVENT,
  announceRotatedElsewhere,
  guestJoinBody,
  guestProfileBody,
  isIdentityRotated,
  memberMarkOf,
  memberProfileHref,
  neutralGuestNickname,
  peerProfileActions,
  profileAddMode,
  profileMarkOf,
  recoverGuestCopy,
  rotatedUinOf,
  transferGuestErrorKey,
  en,
  ru,
  es,
  pt,
  tr,
  uk,
  zh,
} = await import('../dist/guest.mjs')

let n = 0
const check = async (label, fn) => {
  await fn()
  n++
  console.log('  ok  ' + label)
}

// ------------------------------------------------------------ the path table

await check('decideGuestPath: only a literal true takes the guest path', () => {
  assert.equal(decideGuestPath(null), 'legacy')
  assert.equal(decideGuestPath(undefined), 'legacy')
  assert.equal(decideGuestPath({}), 'legacy')
  assert.equal(decideGuestPath({ capabilities: null }), 'legacy')
  assert.equal(decideGuestPath({ capabilities: {} }), 'legacy')
  assert.equal(decideGuestPath({ capabilities: { guest_accounts_v1: false } }), 'legacy')
  assert.equal(decideGuestPath({ capabilities: { guest_accounts_v1: 'true' } }), 'legacy')
  assert.equal(decideGuestPath({ capabilities: { guest_accounts_v1: 1 } }), 'legacy')
  assert.equal(decideGuestPath({ capabilities: { guest_accounts_v1: true } }), 'guest')
})

await check('guestAttemptVerdict follows 12.1', () => {
  assert.equal(guestAttemptVerdict(201, null), 'ok')
  assert.equal(guestAttemptVerdict(200, null), 'ok')
  for (const code of ['invalid_challenge', 'guest_replayed', 'guest_busy']) {
    assert.equal(guestAttemptVerdict(code === 'invalid_challenge' ? 400 : 409, code), 'retry', code)
  }
  assert.equal(guestAttemptVerdict(404, 'identity_rotated'), 'rotated')
  assert.equal(guestAttemptVerdict(404, 'Not Found'), 'legacy')
  assert.equal(guestAttemptVerdict(404, null), 'legacy')
  assert.equal(guestAttemptVerdict(405, 'Method Not Allowed'), 'legacy')
  assert.equal(guestAttemptVerdict(404, 'group_not_found'), 'refused')
  assert.equal(guestAttemptVerdict(503, 'guest_unavailable'), 'recover')
  assert.equal(guestAttemptVerdict(502, null), 'recover')
  assert.equal(guestAttemptVerdict(null, null), 'recover')
  for (const [s, c] of [[403, 'guest_closed'], [403, 'group_closed'], [401, 'bad_signature'], [400, 'guest_wrong_host'], [429, 'guest_room_limit'], [429, 'rate_limited']]) {
    assert.equal(guestAttemptVerdict(s, c), 'refused', c)
  }
})

await check('guestRefusalOf reads object and bare-string details, never a substring', () => {
  assert.deepEqual(guestRefusalOf(429, '{"detail":{"code":"guest_add_limit","scope":"seat"}}'), {
    status: 429, code: 'guest_add_limit', scope: 'seat', uin: null,
  })
  assert.equal(guestRefusalOf(404, '{"detail":{"code":"identity_rotated","uin":4242}}').uin, 4242)
  assert.equal(guestRefusalOf(404, '{"detail":"Not Found"}').code, 'Not Found')
  assert.equal(guestRefusalOf(502, '<html>guest_closed</html>').code, null)
  assert.equal(guestRefusalOf(500, '').code, null)
})

// ------------------------------------------------------------ sentences

const DICTS = { en, ru, es, pt, tr, uk, zh }
const SPEC_KEYS = [
  'guest.join.closed', 'guest.join.room_closed', 'guest.join.room_full', 'guest.join.room_limit',
  'guest.join.rate', 'guest.join.group_limit', 'guest.join.old_paid', 'guest.join.old_invite',
  'guest.unavailable', 'guest.restricted', 'guest.restricted.contacts', 'guest.copy.banner',
  'group.add.foreign.limit', 'group.add.foreign.seat_limit', 'group.add.foreign.stale_key',
  'group.add.foreign.guest_adder', 'group.member.guest', 'group.member.invited',
  'group.settings.allow_guests', 'group.leave.last_resident', 'guest.settle.action',
  'guest.settle.done', 'guest.settle.number_invite', 'backup.is_guest_copy',
  'group.transfer.err.target_guest',
]

await check('every 12.5 sentence exists in every shipped dictionary, without an em dash', () => {
  for (const [lang, dict] of Object.entries(DICTS)) {
    for (const key of SPEC_KEYS) {
      assert.equal(typeof dict[key], 'string', `${lang}: ${key}`)
      assert.ok(dict[key].length > 0, `${lang}: ${key}`)
      assert.ok(!dict[key].includes('—'), `${lang}: ${key} has an em dash`)
    }
  }
  // Host-bearing sentences keep their placeholder in every language.
  for (const key of ['guest.join.closed', 'guest.join.group_limit', 'guest.join.old_paid', 'guest.join.old_invite',
    'guest.unavailable', 'guest.restricted', 'guest.copy.banner', 'group.leave.last_resident',
    'guest.settle.action', 'guest.settle.done', 'backup.is_guest_copy']) {
    for (const [lang, dict] of Object.entries(DICTS)) assert.ok(dict[key].includes('{host}'), `${lang}: ${key}`)
  }
  // Exact spec text for en and ru (web uses the formal «вы»).
  assert.equal(en['guest.join.closed'], "{host} doesn't let in people from other islands.")
  assert.equal(ru['guest.join.room_limit'], 'Сегодня в эту группу вошло слишком много людей с других островов. Попробуйте завтра.')
  assert.equal(ru['backup.is_guest_copy'], 'Ваш аккаунт на острове {host} это гостевая копия, запасным островом он быть не может.')
})

await check('join codes map to the 12.5 keys, and every key they map to exists', () => {
  const table = {
    guest_closed: 'guest.join.closed',
    guest_room_closed: 'guest.join.room_closed',
    guest_room_full: 'guest.join.room_full',
    guest_room_limit: 'guest.join.room_limit',
    rate_limited: 'guest.join.rate',
    guest_group_limit: 'guest.join.group_limit',
    guest_unavailable: 'guest.unavailable',
    guest_restricted: 'guest.restricted',
    entry_required: 'guest.join.old_paid',
    invite_required: 'guest.join.old_invite',
    identity_rotated: 'auth.rotated_elsewhere',
    group_closed: 'group_join.closed_hint',
    blocked: 'group_join.error.blocked',
    group_not_found: 'group_join.gone',
  }
  for (const [code, key] of Object.entries(table)) {
    assert.equal(guestJoinErrorKey(code), key, code)
    assert.equal(typeof en[key], 'string', key)
  }
  assert.equal(guestJoinErrorKey(null, 429), 'guest.join.rate')
  assert.equal(guestJoinErrorKey('something_new', 403), null)
})

await check('add codes map to the 12.5 keys, native English strings still read', () => {
  const table = [
    ['guest_restricted', null, 'group.add.foreign.guest_adder'],
    ['guest_room_closed', null, 'guest.join.room_closed'],
    ['guest_closed', null, 'guest.join.closed'],
    ['guest_room_full', null, 'guest.join.room_full'],
    ['guest_room_limit', null, 'guest.join.room_limit'],
    ['guest_group_limit', null, 'guest.join.group_limit'],
    ['guest_add_limit', 'group', 'group.add.foreign.limit'],
    ['guest_add_limit', 'seat', 'group.add.foreign.seat_limit'],
    ['guest_key_retired', null, 'group.add.foreign.stale_key'],
    ['guest_unavailable', null, 'guest.unavailable'],
    ['blocked', null, 'group.add.err.blocked'],
    ['invite_contacts_only', null, 'group.add.err.contacts_only'],
    ['invite_nobody', null, 'group.add.err.nobody'],
  ]
  for (const [code, scope, key] of table) {
    assert.equal(groupAddErrorKey(code, scope, null), key, `${code}/${scope}`)
    assert.equal(typeof en[key], 'string', key)
  }
  assert.equal(groupAddErrorKey(null, null, '403: {"detail":"the group owner has blocked this user"}'), 'group.add.err.blocked')
  assert.equal(groupAddErrorKey('this user only accepts group invites from their contacts', null, ''), 'group.add.err.contacts_only')
  assert.equal(groupAddErrorKey(null, null, '404: no such user'), 'group.add.err.no_user')
  assert.equal(groupAddErrorKey(null, null, 'boom'), 'group.add.err.failed')
})

await check('settle codes map to existing sentences', () => {
  for (const [code, key] of [
    ['entry_required', 'auth.error.entry_required'],
    ['invite_required', 'auth.error.invite_required'],
    ['invite_has_number', 'guest.settle.number_invite'],
    ['invite_invalid', 'auth.error.invite_invalid'],
    ['voucher_spent', 'residency.code_spent'],
    ['not_a_guest', 'guest.settle.done'],
    ['guest_unavailable', 'guest.unavailable'],
  ]) {
    assert.equal(guestSettleErrorKey(code), key, code)
    assert.equal(typeof en[key], 'string', key)
  }
})

// ------------------------------------------------------------ bodies

await check('no guest body carries desired_uin, a home host or a home number', () => {
  const legacy = legacyGuestRegisterBody({ nickname: 'Anna', identityKey: 'ik', signingKey: 'sk', challenge: 'c', signature: 's' })
  assert.deepEqual(Object.keys(legacy).sort(), ['challenge', 'identity_key', 'nickname', 'signature', 'signing_key'])
  const bare = legacyGuestRegisterBody({ nickname: 'Anna', identityKey: 'ik', signingKey: 'sk' })
  assert.deepEqual(Object.keys(bare).sort(), ['identity_key', 'nickname', 'signing_key'])
  const add = guestAddBody({ identityKey: 'ik', signingKey: 'sk', nickname: '  ', uin: 7 })
  assert.deepEqual(add, { identity_key: 'ik', signing_key: 'sk', nickname: 'Guest' })
  assert.equal(guestAddBody({ identityKey: 'a', signingKey: 'b', nickname: 'x'.repeat(90), uin: 1 }).nickname.length, 64)
})

await check('a re-fetched card is stale only when it serves a different key', () => {
  const k1 = Buffer.alloc(32, 1).toString('base64')
  const k2 = Buffer.alloc(32, 2).toString('base64')
  const pinned = { identityKey: k1, signingKey: k1 }
  assert.equal(cardIsStale(pinned, null), false)
  assert.equal(cardIsStale(pinned, {}), false)
  assert.equal(cardIsStale(pinned, { identity_key: k1, signing_key: k1 }), false)
  // Another spelling of the same bytes is the same key.
  assert.equal(cardIsStale(pinned, { identity_key: k1.replace(/=+$/, ''), signing_key: k1 }), false)
  assert.equal(cardIsStale(pinned, { identity_key: k2, signing_key: k1 }), true)
  assert.equal(cardIsStale(pinned, { identity_key: k1, signing_key: k2 }), true)
  assert.equal(cardIsStale(pinned, { identity_key: 'not!base64', signing_key: k1 }), false)
})

await check('roster helpers: self guest, and the last resident leaving', () => {
  const roster = [{ uin: 1 }, { uin: 2, guest: true }, { uin: 3, guest: true }]
  assert.equal(rosterSelfIsGuest(roster, 2), true)
  assert.equal(rosterSelfIsGuest(roster, 1), false)
  assert.equal(rosterSelfIsGuest(undefined, 1), false)
  assert.equal(lastResidentLeave(roster, 1), true)
  assert.equal(lastResidentLeave(roster, 2), false, 'a guest leaving is not the last resident')
  assert.equal(lastResidentLeave([...roster, { uin: 4, guest: false }], 1), false)
  assert.equal(lastResidentLeave([{ uin: 1 }, { uin: 4 }], 1), false, 'no guest, nothing to delete for')
  // D8: whoever leaves, not only the owner; unclaimed seats count as not living there.
  assert.equal(lastResidentLeave([{ uin: 10 }, { uin: 11, guest: true, invited: true }], 10), true)
  assert.equal(lastResidentLeave([{ uin: 10 }, { uin: 11, invited: true }], 10), true)
  assert.equal(lastResidentLeave([{ uin: 10 }], 10), false, 'alone in the room: no guest to warn for')
  assert.equal(lastResidentLeave(undefined, 10), false)
  assert.equal(lastResidentLeave([], 10), false)
})

// ------------------------------------------------------------ section 7

await check('a group frame never carries 1:1-only kinds', () => {
  // D4: the same list on every client.
  assert.deepEqual([...GROUP_FRAME_DROP].sort(), [
    'call', 'carbon', 'ciack', 'contactreq', 'gskey', 'gsknack', 'homerec', 'pkey', 'pkeyask', 'profile',
    'readmark', 'secscreen', 'shot', 'visit',
  ])
  for (const kind of GROUP_FRAME_DROP) assert.equal(groupFrameDropped(kind), true, kind)
  // Every call kind, whatever a client names it.
  for (const kind of ['call_offer', 'call_answer', 'call_missed', 'call_end']) assert.equal(groupFrameDropped(kind), true, kind)
  // Group content and sender-key control still reach the room. Room STATE keys
  // (gskey/gsknack) are sealed 1:1 by every client and never ride a room frame.
  for (const kind of ['text', 'photo', 'voice', 'edit', 'delete', 'reaction', 'poll', 'skdm', 'sknack', 'callme']) {
    assert.equal(groupFrameDropped(kind), false, kind)
  }
  assert.equal(groupFrameDropped(undefined), false)
})

await check('a group frame never files a profile key under a home number', () => {
  // A co-member on another island wearing a home contact's digits.
  assert.equal(groupFrameDropped('pkey'), true)
})

await check('a group frame never repoints where 1:1 sends go', () => {
  assert.equal(groupFrameDropped('homerec'), true)
})

// ------------------------------------------------------------ the fake island

const HOST = 'isl.example'
const signingPriv = ed25519.utils.randomPrivateKey()
const identity = {
  uin: 4242,
  jwt: 'home-token',
  apiBase: 'https://home.example',
  identityPriv: new Uint8Array(32).fill(3),
  identityPub: new Uint8Array(32).fill(9),
  signingPriv,
  signingPub: ed25519.getPublicKey(signingPriv),
}

let calls = []
const answer = (status, json) =>
  new Response(json === undefined ? '' : JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } })

/// `routes` maps a path to a handler (body, nthCallOfThatPath) => {status, json} | Error.
function island(routes) {
  calls = []
  const seen = new Map()
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ host: u.host, path: u.pathname, body })
    const nth = (seen.get(u.pathname) ?? 0) + 1
    seen.set(u.pathname, nth)
    const h = routes[u.pathname]
    if (!h) return answer(404, { detail: 'Not Found' })
    const out = await h(body, nth)
    if (out instanceof Error) throw out
    return answer(out.status, out.json)
  }
}
const paths = () => calls.map((c) => c.path)
const noDesiredUin = () => {
  for (const c of calls) assert.ok(!(c.body && 'desired_uin' in c.body), `${c.path} sent desired_uin`)
  // Nothing about the home island travels to the guest island.
  for (const c of calls) assert.ok(!JSON.stringify(c.body ?? {}).includes('home.example'), `${c.path} named home`)
  for (const c of calls) assert.equal(c.host, HOST)
}

const INFO_GUEST = { status: 200, json: { name: 'x', capabilities: { registration_policy: 'paid', guest_accounts_v1: true } } }
const INFO_OLD = { status: 200, json: { name: 'x', capabilities: { registration_policy: 'paid' } } }
const INFO_OPEN = { status: 200, json: { name: 'x', capabilities: { registration_policy: 'open', guest_accounts_v1: false } } }
const CHALLENGE = (body, nth) => ({ status: 200, json: { challenge: `ch-${nth}-${body.signing_key.slice(0, 4)}` } })
const GUEST_OK = (body) => {
  // The island's own check, done here with the production byte builder.
  const ik = identity.identityPub
  const sk = identity.signingPub
  assert.equal(body.v, 1)
  assert.equal(body.host, HOST)
  assert.equal(body.identity_key, canonicalKeyB64(ik))
  assert.equal(body.signing_key, canonicalKeyB64(sk))
  const signed = guestProofBytes(body.host, body.group_id, ik, sk, body.challenge)
  assert.equal(ed25519.verify(Buffer.from(body.signature, 'base64'), signed, sk), true)
  return { status: 201, json: { uin: 777001, token: 'guest-token', guest: true, created: true } }
}
const RECOVER_NONE = { '/auth/recover/challenge': CHALLENGE, '/auth/recover': () => ({ status: 404, json: { detail: { code: 'identity_not_found' } } }) }
const REGISTER_OK = {
  '/auth/register/challenge': CHALLENGE,
  '/auth/register': (body) => {
    assert.ok(body.challenge && body.signature, 'legacy register signs the challenge')
    assert.equal(body.nickname, 'Guest', 'D1: the legacy guest registration names no number')
    assert.equal(ed25519.verify(Buffer.from(body.signature, 'base64'), new TextEncoder().encode(body.challenge), identity.signingPub), true)
    return { status: 200, json: { uin: 555, token: 'legacy-token' } }
  },
}

await check('capability true: challenge, proof bound to the room, one row, nothing else', async () => {
  island({ '/server/info': () => INFO_GUEST, '/auth/guest/challenge': CHALLENGE, '/auth/guest': GUEST_OK })
  const cred = await guestCredentialsFor(HOST, identity, 41)
  assert.deepEqual(cred, { uin: 777001, token: 'guest-token', guest: true })
  assert.deepEqual(paths(), ['/server/info', '/auth/guest/challenge', '/auth/guest'])
  assert.equal(calls[2].body.group_id, 41)
  // D1: a word for a name, never our home number.
  assert.equal(calls[2].body.nickname, GUEST_NICKNAME_PLACEHOLDER)
  noDesiredUin()
})

await check('capability absent: exactly the legacy recover-first registration, without desired_uin', async () => {
  island({ '/server/info': () => INFO_OLD, ...RECOVER_NONE, ...REGISTER_OK })
  const cred = await guestCredentialsFor(HOST, identity, 41)
  assert.equal(cred.uin, 555)
  assert.equal(cred.guest, false)
  assert.deepEqual(paths(), ['/server/info', '/auth/recover/challenge', '/auth/recover', '/auth/register/challenge', '/auth/register'])
  noDesiredUin()
})

await check('open island (capability false) and an unreachable /server/info both stay legacy', async () => {
  island({ '/server/info': () => INFO_OPEN, ...RECOVER_NONE, ...REGISTER_OK })
  await guestCredentialsFor(HOST, identity, 41)
  assert.ok(!paths().some((p) => p.startsWith('/auth/guest')))
  island({ '/server/info': () => new Error('offline'), ...RECOVER_NONE, ...REGISTER_OK })
  await guestCredentialsFor(HOST, identity, 41)
  assert.ok(!paths().some((p) => p.startsWith('/auth/guest')))
  noDesiredUin()
})

await check('legacy door on an old paid island throws what doorRefusalOf reads', async () => {
  island({
    '/server/info': () => INFO_OLD,
    ...RECOVER_NONE,
    '/auth/register/challenge': CHALLENGE,
    '/auth/register': () => ({ status: 403, json: { detail: { code: 'entry_required' } } }),
  })
  const err = await guestCredentialsFor(HOST, identity, 41).then(() => null, (e) => e)
  assert.equal(doorRefusalOf(err), 'entry')
  assert.equal(guestJoinErrorKey('entry_required'), 'guest.join.old_paid')
})

await check('a stale or spent challenge is retried once with a fresh one', async () => {
  island({
    '/server/info': () => INFO_GUEST,
    '/auth/guest/challenge': CHALLENGE,
    '/auth/guest': (body, nth) => (nth === 1 ? { status: 409, json: { detail: { code: 'guest_replayed' } } } : GUEST_OK(body)),
  })
  const cred = await guestCredentialsFor(HOST, identity, 41)
  assert.equal(cred.uin, 777001)
  assert.deepEqual(paths(), ['/server/info', '/auth/guest/challenge', '/auth/guest', '/auth/guest/challenge', '/auth/guest'])
  assert.notEqual(calls[2].body.challenge, calls[4].body.challenge)
})

await check('twice refused as busy: thrown, no third try, no legacy', async () => {
  island({
    '/server/info': () => INFO_GUEST,
    '/auth/guest/challenge': CHALLENGE,
    '/auth/guest': () => ({ status: 409, json: { detail: { code: 'guest_busy' } } }),
    ...RECOVER_NONE,
    ...REGISTER_OK,
  })
  const err = await guestCredentialsFor(HOST, identity, 41).then(() => null, (e) => e)
  assert.ok(err instanceof GuestJoinError)
  assert.equal(err.code, 'guest_busy')
  assert.equal(paths().filter((p) => p === '/auth/guest').length, 2)
  assert.ok(!paths().includes('/auth/register') && !paths().includes('/auth/recover'))
})

await check('identity_rotated is thrown as such, never followed by a registration', async () => {
  island({
    '/server/info': () => INFO_GUEST,
    '/auth/guest/challenge': CHALLENGE,
    '/auth/guest': () => ({ status: 404, json: { detail: { code: 'identity_rotated', uin: 9 } } }),
    ...RECOVER_NONE,
    ...REGISTER_OK,
  })
  const err = await guestCredentialsFor(HOST, identity, 41).then(() => null, (e) => e)
  assert.ok(err instanceof GuestJoinError)
  assert.equal(err.code, 'identity_rotated')
  assert.ok(!paths().includes('/auth/register') && !paths().includes('/auth/recover'))
})

await check('a refusal has its sentence and no fallback to the door', async () => {
  for (const [status, code] of [[403, 'guest_closed'], [403, 'guest_room_closed'], [403, 'group_closed'], [429, 'guest_room_limit'], [404, 'group_not_found']]) {
    island({
      '/server/info': () => INFO_GUEST,
      '/auth/guest/challenge': CHALLENGE,
      '/auth/guest': () => ({ status, json: { detail: { code } } }),
      ...RECOVER_NONE,
      ...REGISTER_OK,
    })
    const err = await guestCredentialsFor(HOST, identity, 41).then(() => null, (e) => e)
    assert.ok(err instanceof GuestJoinError, code)
    assert.equal(err.code, code)
    assert.ok(guestJoinErrorKey(err.code, err.status), code)
    assert.ok(!paths().includes('/auth/register') && !paths().includes('/auth/recover'), code)
  }
})

await check('404 on the route itself falls back to the legacy path', async () => {
  island({ '/server/info': () => INFO_GUEST, '/auth/guest/challenge': CHALLENGE, ...RECOVER_NONE, ...REGISTER_OK })
  const cred = await guestCredentialsFor(HOST, identity, 41)
  assert.equal(cred.uin, 555)
  assert.deepEqual(paths(), ['/server/info', '/auth/guest/challenge', '/auth/guest', '/auth/recover/challenge', '/auth/recover', '/auth/register/challenge', '/auth/register'])
  noDesiredUin()
})

await check('5xx takes one recover and uses its credentials; nothing to recover is guest_unavailable', async () => {
  island({
    '/server/info': () => INFO_GUEST,
    '/auth/guest/challenge': CHALLENGE,
    '/auth/guest': () => ({ status: 503, json: { detail: { code: 'guest_unavailable' } } }),
    '/auth/recover/challenge': CHALLENGE,
    '/auth/recover': () => ({ status: 200, json: { uin: 31, token: 'rec', guest: true } }),
    ...REGISTER_OK,
  })
  const cred = await guestCredentialsFor(HOST, identity, 41)
  assert.deepEqual(cred, { uin: 31, token: 'rec', guest: true })
  assert.ok(!paths().includes('/auth/register'))

  island({
    '/server/info': () => INFO_GUEST,
    '/auth/guest/challenge': CHALLENGE,
    '/auth/guest': () => new Error('connection reset'),
    ...RECOVER_NONE,
    ...REGISTER_OK,
  })
  const err = await guestCredentialsFor(HOST, identity, 41).then(() => null, (e) => e)
  assert.ok(err instanceof GuestJoinError)
  assert.equal(err.code, 'guest_unavailable')
  assert.equal(guestJoinErrorKey(err.code), 'guest.unavailable')
  assert.ok(!paths().includes('/auth/register'))
})

await check('guest path without a room never mints: recover only', async () => {
  island({ '/server/info': () => INFO_GUEST, '/auth/guest/challenge': CHALLENGE, '/auth/guest': GUEST_OK, ...RECOVER_NONE, ...REGISTER_OK })
  const err = await guestCredentialsFor(HOST, identity).then(() => null, (e) => e)
  assert.ok(err instanceof GuestJoinError)
  assert.deepEqual(paths(), ['/server/info', '/auth/recover/challenge', '/auth/recover'])
})

await check('the backup refusal names its own error', () => {
  assert.equal(GUEST_COPY_NOT_BACKUP, 'guest copy')
})

// ------------------------------------------------------------ D1: no home number as a name

await check('D1: a name that is or carries the home number becomes the placeholder', () => {
  assert.equal(GUEST_NICKNAME_PLACEHOLDER, 'Guest')
  assert.ok(!/\d/.test(GUEST_NICKNAME_PLACEHOLDER))
  assert.equal(neutralGuestNickname('', [7]), 'Guest')
  assert.equal(neutralGuestNickname(null, []), 'Guest')
  assert.equal(neutralGuestNickname('user-7', [7]), 'Guest')
  assert.equal(neutralGuestNickname('user-1234', []), 'Guest', 'a number dressed as a name')
  assert.equal(neutralGuestNickname('#4242', []), 'Guest')
  assert.equal(neutralGuestNickname('4242', []), 'Guest')
  assert.equal(neutralGuestNickname('Anna 4242', [4242]), 'Guest')
  assert.equal(neutralGuestNickname('Anna', [4242]), 'Anna')
  assert.equal(neutralGuestNickname('Anna 42420', [4242]), 'Anna 42420', 'digits of another number are not ours')
  assert.equal(neutralGuestNickname('Room 17', []), 'Room 17')
  assert.equal(guestAddBody({ identityKey: 'a', signingKey: 'b', nickname: 'user-7', uin: 7 }).nickname, 'Guest')
  assert.equal(guestAddBody({ identityKey: 'a', signingKey: 'b', nickname: 'Anna', uin: 7 }).nickname, 'Anna')
  assert.equal(legacyGuestRegisterBody({ nickname: 'user-4242', identityKey: 'a', signingKey: 'b', homeUin: 4242 }).nickname, 'Guest')
  const join = guestJoinBody({ host: 'h', groupId: 1, nickname: 'me 4242', identityKey: 'a', signingKey: 'b', challenge: 'c', signature: 's', homeUin: 4242 })
  assert.equal(join.nickname, 'Guest')
})

await check('D1: the rename pushed to a copy carries no home number either', () => {
  // #985(2) sends our home name to the copy right after the join. It is a
  // request to a foreign island like any other, so the same rule holds.
  assert.equal(guestProfileBody(null, 4242), null)
  assert.equal(guestProfileBody('', 4242), null)
  assert.equal(guestProfileBody('   ', 4242), null, 'nothing to push is not a push of "Guest"')
  assert.deepEqual(guestProfileBody('Anna', 4242), { nickname: 'Anna' })
  assert.deepEqual(guestProfileBody('user-1234', 4242), { nickname: 'Guest' }, 'the minted default reads as a number')
  assert.deepEqual(guestProfileBody('#4242', 4242), { nickname: 'Guest' })
  assert.deepEqual(guestProfileBody('Anna 4242', 4242), { nickname: 'Guest' }, 'our home number inside a name')
  assert.deepEqual(guestProfileBody('Anna 4242'), { nickname: 'Anna 4242' }, 'no home number given: nothing to hide')
  assert.equal(guestProfileBody('x'.repeat(90), 4242).nickname.length, 64)
  // Only the nickname travels: no other profile field rides along.
  assert.deepEqual(Object.keys(guestProfileBody('Anna', 4242)), ['nickname'])
})

// ------------------------------------------------------------ D3: one code table

await check('D3: busy, replayed and stale challenges read as "try later" everywhere', () => {
  for (const code of ['invalid_challenge', 'guest_replayed', 'guest_busy', 'island_busy', 'guest_unavailable']) {
    assert.equal(guestJoinErrorKey(code), 'guest.unavailable', `join ${code}`)
    assert.equal(groupAddErrorKey(code, null, null), 'guest.unavailable', `add ${code}`)
  }
  for (const code of ['guest_busy', 'island_busy', 'guest_unavailable']) {
    assert.equal(guestSettleErrorKey(code), 'guest.unavailable', `settle ${code}`)
  }
  // The island's ceiling answers with a bare string on one path and an object on
  // the other; both read as the same code, and a 503 first tries a recover.
  assert.equal(guestRefusalOf(503, '{"detail":"island_busy"}').code, 'island_busy')
  assert.equal(guestRefusalOf(503, '{"detail":{"code":"island_busy","retry_after":30}}').code, 'island_busy')
  assert.equal(guestAttemptVerdict(503, 'island_busy'), 'recover')
})

await check('D3: target_guest, stale card, and a code nobody knows', () => {
  assert.equal(transferGuestErrorKey('target_guest'), 'group.transfer.err.target_guest')
  assert.equal(transferGuestErrorKey('owner_only'), null)
  assert.equal(guestJoinErrorKey('target_guest'), 'group.transfer.err.target_guest')
  assert.equal(groupAddErrorKey('target_guest', null, null), 'group.transfer.err.target_guest')
  assert.equal(guestJoinErrorKey('guest_key_retired'), 'group.add.foreign.stale_key')
  assert.equal(groupAddErrorKey('guest_key_retired', null, null), 'group.add.foreign.stale_key')
  assert.equal(guestJoinErrorKey('guest_room_closed'), 'guest.join.room_closed', 'allow_guests off')
  assert.equal(groupAddErrorKey('guest_room_full', null, null), 'guest.join.room_full', 'member ceiling')
  assert.equal(guestJoinErrorKey('guest_restricted'), 'guest.restricted')
  assert.equal(groupAddErrorKey('guest_restricted', null, null), 'group.add.foreign.guest_adder')
  // No code at all: the callers' generic lines.
  assert.equal(guestJoinErrorKey(null), null)
  assert.equal(groupAddErrorKey(null, null, null), 'group.add.err.failed')
  assert.equal(guestSettleErrorKey(null), null)
  for (const [lang, dict] of Object.entries(DICTS)) {
    assert.equal(typeof dict['group.transfer.err.target_guest'], 'string', lang)
  }
})

// ------------------------------------------------------------ D5: members in rosters

await check('D5: a member link carries the room island and the roster mark', () => {
  assert.equal(memberMarkOf(null), null)
  assert.equal(memberMarkOf({}), null)
  assert.equal(memberMarkOf({ guest: true }), 'guest')
  assert.equal(memberMarkOf({ guest: true, invited: true }), 'invited')
  assert.equal(memberProfileHref(7, null, null), '/profile/7')
  assert.equal(memberProfileHref(7, null, { guest: true }), '/profile/7?guest=1')
  assert.equal(memberProfileHref(7, 'is2.rcq.app', { guest: true }), '/profile/7?i=is2.rcq.app&guest=1')
  assert.equal(memberProfileHref(7, 'is2.rcq.app', { guest: true, invited: true }), '/profile/7?i=is2.rcq.app&invited=1')
  assert.equal(memberProfileHref(7, 'is2.rcq.app', { guest: false }), '/profile/7?i=is2.rcq.app')
  assert.equal(profileMarkOf(new URLSearchParams('i=h&guest=1')), 'guest')
  assert.equal(profileMarkOf(new URLSearchParams('invited=1')), 'invited')
  assert.equal(profileMarkOf(new URLSearchParams(''), { guest: true }), 'guest', 'the island says so on its own card')
  assert.equal(profileMarkOf(new URLSearchParams(''), null), null)
})

await check('D5/D6: what a profile page offers', () => {
  const none = { add: false, message: false }
  for (const relationship of ['contact', 'stranger', 'unknown']) {
    assert.deepEqual(peerProfileActions({ primaryGuest: true, mark: null, relationship }), none, `primary guest ${relationship}`)
    assert.deepEqual(peerProfileActions({ primaryGuest: false, mark: 'invited', relationship }), none, `invited ${relationship}`)
    assert.equal(peerProfileActions({ primaryGuest: false, mark: 'guest', relationship }).message, false, `guest ${relationship}`)
  }
  assert.deepEqual(peerProfileActions({ primaryGuest: false, mark: 'guest', relationship: 'stranger' }), { add: true, message: false })
  assert.deepEqual(peerProfileActions({ primaryGuest: false, mark: 'guest', relationship: 'contact' }), none)
  assert.deepEqual(peerProfileActions({ primaryGuest: false, mark: null, relationship: 'stranger' }), { add: true, message: false })
  assert.deepEqual(peerProfileActions({ primaryGuest: false, mark: null, relationship: 'contact' }), { add: false, message: true })
  assert.deepEqual(peerProfileActions({ primaryGuest: false, mark: null, relationship: 'unknown' }), { add: false, message: true })
})

await check('D5: a guest copy on our own island is asked directly, never through search', () => {
  // ⚠ The reason this mode exists: the island filters guest rows out of
  // /users/search for EVERY caller, so the add screen seeded with `#uin` can
  // only answer "no matches" and the one Add D5 promises would send nothing.
  assert.equal(profileAddMode({ mark: 'guest', crossIslandHost: null }), 'request')
  assert.equal(profileAddMode({ mark: 'guest' }), 'request')
  // Another island's copy keeps the screen: the federation card, the pinned
  // keys and the sealed §5f deposit are there and nowhere else.
  assert.equal(profileAddMode({ mark: 'guest', crossIslandHost: 'is2.rcq.app' }), 'search')
  assert.equal(profileAddMode({ mark: null, crossIslandHost: null }), 'search')
  assert.equal(profileAddMode({ mark: null, crossIslandHost: 'is2.rcq.app' }), 'search')
  // An unclaimed seat is offered no Add at all (peerProfileActions above), so
  // the mode is never read for one; it is still not the direct request.
  assert.equal(profileAddMode({ mark: 'invited', crossIslandHost: null }), 'search')
  // Every sentence that request can end on, in every shipped dictionary.
  for (const [lang, dict] of Object.entries(DICTS)) {
    for (const key of ['add.requested', 'add.already', 'add.request_failed']) {
      assert.equal(typeof dict[key], 'string', `${lang}: ${key}`)
      assert.ok(dict[key].length > 0, `${lang}: ${key}`)
      assert.ok(!dict[key].includes('—'), `${lang}: ${key} has an em dash`)
    }
  }
})

// ------------------------------------------------------------ D2: a retired key

await check('D2: identity_rotated on the legacy recover is thrown as rotated, and nothing registers', async () => {
  island({
    '/server/info': () => INFO_OLD,
    '/auth/recover/challenge': CHALLENGE,
    '/auth/recover': () => ({ status: 404, json: { detail: { code: 'identity_rotated', uin: 9 } } }),
    ...REGISTER_OK,
  })
  const err = await guestCredentialsFor(HOST, identity, 41).then(() => null, (e) => e)
  assert.ok(err instanceof GuestJoinError)
  assert.equal(err.code, 'identity_rotated')
  assert.ok(!paths().includes('/auth/register'))
})

await check('D2: a 5xx on /auth/guest whose recover meets a retired key is rotated, not unavailable', async () => {
  island({
    '/server/info': () => INFO_GUEST,
    '/auth/guest/challenge': CHALLENGE,
    '/auth/guest': () => ({ status: 503, json: { detail: { code: 'guest_unavailable' } } }),
    '/auth/recover/challenge': CHALLENGE,
    '/auth/recover': () => ({ status: 404, json: { detail: { code: 'identity_rotated' } } }),
    ...REGISTER_OK,
  })
  const err = await guestCredentialsFor(HOST, identity, 41).then(() => null, (e) => e)
  assert.ok(err instanceof GuestJoinError)
  assert.equal(err.code, 'identity_rotated')
  assert.ok(!paths().includes('/auth/register'))
})

await check('D2: a plain 404 on recover is still "no copy here"', async () => {
  island({ ...RECOVER_NONE })
  assert.equal(await recoverGuestCopy(HOST, identity), null)
  assert.equal(IDENTITY_ROTATED, 'identity_rotated')
  assert.equal(isIdentityRotated({ code: 'identity_rotated' }), true)
  assert.equal(isIdentityRotated(new Error('recover: HTTP 404')), false)
})

await check('D2: the rotated announcement reaches a listener with the home number', () => {
  const target = new EventTarget()
  const prev = globalThis.window
  globalThis.window = target
  try {
    let got = null
    target.addEventListener(ROTATED_ELSEWHERE_EVENT, (e) => {
      got = rotatedUinOf(e)
    })
    announceRotatedElsewhere(4242)
    assert.equal(got, 4242)
  } finally {
    globalThis.window = prev
  }
})

// ------------------------------------------------------------ the six decisions of 16.09

await check('E3: every dropped kind is a name that exists on the wire', () => {
  // The drop list used to be written from the PROSE of section 7, and two of
  // its names were spellings no client has ever sent: a `screenshot` notice
  // travels as `shot` (Android crypto/Envelope.kt:462, iOS CryptoService
  // `case .screenshotTaken`), and `secure-screen` is `secscreen` everywhere.
  // Both went straight through the gate they were written to close. So the
  // list is held to the codec's own names from here on.
  for (const kind of GROUP_FRAME_DROP) {
    assert.ok(WIRE_KINDS.has(kind), `${kind}: a name from the prose, not from any encoder or decoder`)
  }
  assert.equal(WIRE_KINDS.has('screenshot'), false)
  assert.equal(WIRE_KINDS.has('secure-screen'), false)
  assert.equal(groupFrameDropped('shot'), true)
  assert.equal(groupFrameDropped('secscreen'), true)
  assert.equal(groupFrameDropped('visit'), true)
  // Content and sender-key traffic are on the wire AND still reach their room.
  for (const kind of ['text', 'photo', 'voice', 'poll', 'skdm', 'sknack']) {
    assert.ok(WIRE_KINDS.has(kind), kind)
    assert.equal(groupFrameDropped(kind), false, kind)
  }
})

await check('E2: one table, and every sentence it can reach exists in every locale', () => {
  // The union of the three clients' join, add and settle tables (Android
  // GuestPath, iOS GuestSentence, and the three mappers here). Every code has
  // to be NAMED by at least one of ours, and every key they name has to be in
  // all seven dictionaries.
  const UNION = [
    'group_closed', 'blocked', 'invite_nobody', 'invite_contacts_only', 'guest_group_limit',
    'guest_add_limit', 'guest_room_closed', 'guest_room_full', 'guest_room_limit', 'target_guest',
    'guest_busy', 'island_busy', 'invalid_challenge', 'guest_replayed', 'guest_unavailable',
    'guest_restricted', 'identity_rotated', 'entry_required', 'invite_required', 'invite_invalid',
    'voucher_other_island', 'voucher_expired', 'voucher_spent', 'invite_has_number', 'bad_signature',
    'rate_limited', 'guest_closed', 'guest_key_retired', 'group_not_found', 'not_a_guest',
  ]
  const named = (code) =>
    [
      guestJoinErrorKey(code),
      groupAddErrorKey(code, 'seat', null),
      groupAddErrorKey(code, 'group', null),
      guestSettleErrorKey(code),
      // The add table's generic line is "no sentence of its own", not a mapping.
    ].filter((k) => k && k !== 'group.add.err.failed')
  for (const code of UNION) {
    const keys = named(code)
    assert.ok(keys.length > 0, `${code}: no table on this client names it`)
    for (const key of keys) {
      for (const [lang, dict] of Object.entries(DICTS)) {
        assert.equal(typeof dict[key], 'string', `${lang}: ${key} (${code})`)
        assert.ok(dict[key].length > 0, `${lang}: ${key} (${code})`)
        assert.ok(!dict[key].includes('—'), `${lang}: ${key} has an em dash`)
      }
    }
  }
  // The three the web table was missing next to Android and iOS.
  assert.equal(groupAddErrorKey(null, null, null, 429), 'guest.join.rate', 'a limiter with no body of ours')
  assert.equal(guestSettleErrorKey('bad_signature'), 'auth.error.invite_invalid')
  assert.equal(guestSettleErrorKey('guest_restricted'), 'guest.restricted')
  // Still the generic line when the island says nothing we know.
  assert.equal(groupAddErrorKey(null, null, null), 'group.add.err.failed')
  assert.equal(groupAddErrorKey('something_new', null, null, 403), 'group.add.err.failed')
  // The seat and the group scope of one code say different things.
  assert.notEqual(
    groupAddErrorKey('guest_add_limit', 'seat', null),
    groupAddErrorKey('guest_add_limit', 'group', null),
  )
})

await check('E4: the leave verdict asks for a roster instead of walking out quietly', () => {
  const roster = [{ uin: 1 }, { uin: 2, guest: true }]
  assert.equal(leaveWarningVerdict(roster, 1), 'last_resident')
  assert.equal(leaveWarningVerdict(roster, 2), 'plain', 'a guest leaving strands nobody')
  assert.equal(leaveWarningVerdict([{ uin: 1 }, { uin: 2 }], 1), 'plain')
  assert.equal(leaveWarningVerdict([{ uin: 1 }, { uin: 2, invited: true }], 1), 'last_resident')
  assert.equal(leaveWarningVerdict([{ uin: 1 }], 1), 'plain', 'alone in the room: nobody to strand')
  // No roster, an empty one, and a page our own row is not on are all "ask".
  assert.equal(leaveWarningVerdict(undefined, 1), 'unknown')
  assert.equal(leaveWarningVerdict(null, 1), 'unknown')
  assert.equal(leaveWarningVerdict([], 1), 'unknown')
  assert.equal(leaveWarningVerdict([{ uin: 2, guest: true }], 1), 'unknown', 'a partial page proves nothing')
  // After the caller has spent its one fetch: a room on ANOTHER island whose
  // roster still cannot be read gets the warning rather than a silent leave.
  assert.equal(leaveWarnAfterFetch('last_resident', false), true)
  assert.equal(leaveWarnAfterFetch('last_resident', true), true)
  assert.equal(leaveWarnAfterFetch('unknown', true), true)
  assert.equal(leaveWarnAfterFetch('unknown', false), false)
  assert.equal(leaveWarnAfterFetch('plain', true), false)
  assert.equal(leaveWarnAfterFetch('plain', false), false)
  // The boolean the roster-holding callers still read.
  assert.equal(lastResidentLeave(roster, 1), true)
  assert.equal(lastResidentLeave(undefined, 1), false)

  // F7: a page of a bigger roster is NOT the roster. The count rides beside
  // every roster an island sends (`member_count`) and instead of it on a list
  // row fetched with `?members=0`, so the caller always has it.
  assert.equal(leaveWarningVerdict(roster, 1, 2), 'last_resident', 'the page IS the room')
  assert.equal(leaveWarningVerdict(roster, 1, 9), 'unknown', 'two rows of a room of nine')
  assert.equal(leaveWarningVerdict([{ uin: 1 }], 1, 40), 'unknown', 'alone on the page, not in the room')
  assert.equal(leaveWarningVerdict([], 1, 40), 'unknown')
  // No count to compare against: decide on what we hold, exactly as before.
  assert.equal(leaveWarningVerdict(roster, 1, undefined), 'last_resident')
  assert.equal(leaveWarningVerdict(roster, 1, null), 'last_resident')
  assert.equal(leaveWarningVerdict(roster, 1, Number.NaN), 'last_resident')
  // A count smaller than the page (a room someone just left) is not a page.
  assert.equal(leaveWarningVerdict(roster, 1, 1), 'last_resident')
  assert.equal(lastResidentLeave(roster, 1, 9), false, 'never "the last resident" off half a room')
  // And what a short page MEANS is the three-answer rule, unchanged: on another
  // island it warns rather than walk out quietly, on ours it does not.
  assert.equal(leaveWarnAfterFetch(leaveWarningVerdict(roster, 1, 9), true), true)
  assert.equal(leaveWarnAfterFetch(leaveWarningVerdict(roster, 1, 9), false), false)
})

await check('E5: a guest copy is offered no Add in a room on another island', () => {
  // The island denies `POST /groups/{id}/members` to a guest (403
  // `guest_restricted`), so the entry point is hidden rather than offered and
  // then refused. Both inputs matter, and the same two Android reads.
  assert.equal(hideAddInRoom('isl.example', true), true)
  // Our OWN island: we are nobody's guest there, whatever a stale record says.
  assert.equal(hideAddInRoom(null, true), false)
  assert.equal(hideAddInRoom(undefined, true), false)
  assert.equal(hideAddInRoom('', true), false)
  // A resident copy on another island keeps its Add.
  assert.equal(hideAddInRoom('isl.example', false), false)
  // An island too old for the flag says nothing, and nothing is not "guest":
  // the screen it has today is the screen it keeps.
  assert.equal(hideAddInRoom('isl.example', null), false)
  assert.equal(hideAddInRoom('isl.example', undefined), false)
  // Read off the room's own roster, under OUR number on that island.
  const roster = [{ uin: 1 }, { uin: 777001, guest: true }]
  assert.equal(hideAddInRoom('isl.example', rosterSelfIsGuest(roster, 777001)), true)
  assert.equal(hideAddInRoom('isl.example', rosterSelfIsGuest(roster, 1)), false)
  // F8: a room on our OWN island when the ACCOUNT signed in here is itself a
  // guest copy (a phrase typed on the wrong island). Every room it is in is a
  // local room, so there is no foreign roster to read and the add was offered
  // in all of them until this half existed.
  assert.equal(hideAddInRoom(null, false, true), true)
  assert.equal(hideAddInRoom(null, null, true), true)
  assert.equal(hideAddInRoom(undefined, undefined, true), true)
  assert.equal(hideAddInRoom('', undefined, true), true)
  // A resident at home keeps the ordinary screen at home, whatever a stale
  // visited record says about some other island.
  assert.equal(hideAddInRoom(null, true, false), false)
  assert.equal(hideAddInRoom(null, true, null), false)
  assert.equal(hideAddInRoom(null, true, undefined), false)
  // A room on ANOTHER island is answered by the copy we hold THERE: being a
  // guest at home says nothing about an island we are a resident of, and being
  // a resident at home does not undo what that island says about our copy.
  assert.equal(hideAddInRoom('isl.example', false, true), false)
  assert.equal(hideAddInRoom('isl.example', true, false), true)
  // The sentence shown in its place, and the one the sheet still maps the
  // refusal to if a roster goes stale under an open screen.
  assert.equal(groupAddErrorKey('guest_restricted', null, null), 'group.add.foreign.guest_adder')
  for (const [lang, dict] of Object.entries(DICTS)) {
    assert.equal(typeof dict['group.add.foreign.guest_adder'], 'string', lang)
    assert.ok(!dict['group.add.foreign.guest_adder'].includes('—'), `${lang}: em dash`)
  }
})

await check('E6: the legacy name repair fires only on OUR home number', () => {
  // The old fallback, on a copy that still wears it.
  assert.deepEqual(legacyNicknameRepairBody('user-4242', 4242), { nickname: GUEST_NICKNAME_PLACEHOLDER })
  assert.deepEqual(legacyNicknameRepairBody('#4242', 4242), { nickname: 'Guest' })
  assert.deepEqual(legacyNicknameRepairBody('Anna 4242', 4242), { nickname: 'Guest' })
  assert.deepEqual(legacyNicknameRepairBody('4242', 4242), { nickname: 'Guest' })
  // A name with no number of ours in it is that island's business, not a leak:
  // the repair never rewrites a name it was not asked to.
  assert.equal(legacyNicknameRepairBody('Anna', 4242), null)
  assert.equal(legacyNicknameRepairBody('user-1234', 4242), null, "somebody else's digits")
  assert.equal(legacyNicknameRepairBody('user-42420', 4242), null, 'another number that starts the same')
  assert.equal(legacyNicknameRepairBody('', 4242), null)
  assert.equal(legacyNicknameRepairBody(null, 4242), null)
  assert.equal(legacyNicknameRepairBody('user-4242', 0), null, 'no home number: nothing to look for')
  // Whole digit runs, the same rule Android and iOS use.
  assert.equal(nameCarriesNumber('user-4242', 4242), true)
  assert.equal(nameCarriesNumber('Anna42420', 4242), false)
  assert.equal(nameCarriesNumber('Anna', 4242), false)
  // Nothing but the nickname ever travels in that repair.
  assert.deepEqual(Object.keys(legacyNicknameRepairBody('user-4242', 4242)), ['nickname'])
})

await check('F2: a retired key shows the rotated notice and no second sentence', () => {
  // The account's rotated-elsewhere notice goes up over the whole app the
  // moment an island answers `identity_rotated` (announceRotatedElsewhere ->
  // identity-context), and it says what happened and the one way on. A card
  // that also printed a line of its own would read as a different problem
  // beside it, so every screen asks this FIRST and shows nothing when true.
  assert.equal(rotatedElsewhereRefusal('identity_rotated'), true)
  for (const code of ['guest_closed', 'guest_busy', 'group_not_found', 'rate_limited', 'IDENTITY_ROTATED', '', null, undefined]) {
    assert.equal(rotatedElsewhereRefusal(code), false, String(code))
  }
  // The join card's rule, as the card runs it: the predicate, then the table,
  // then its own generic line. Nothing but the notice for a retired key, and
  // every other refusal still says what it always said.
  const cardSentence = (code, status) =>
    rotatedElsewhereRefusal(code) ? null : guestJoinErrorKey(code, status) ?? 'group_join.error.generic'
  assert.equal(cardSentence('identity_rotated', 404), null)
  assert.equal(cardSentence('guest_closed', 403), 'guest.join.closed')
  assert.equal(cardSentence('entry_required', 403), 'guest.join.old_paid')
  assert.equal(cardSentence('something_new', 403), 'group_join.error.generic')
  // Whatever the shape of the error, the code is the same fact: the guest
  // paths raise GuestJoinError, and a /join that meets it raises an ApiError.
  assert.equal(rotatedElsewhereRefusal(new GuestJoinError(404, 'identity_rotated', '').code), true)
  assert.equal(
    rotatedElsewhereRefusal(guestRefusalOf(404, JSON.stringify({ detail: { code: 'identity_rotated', uin: 9 } })).code),
    true,
  )
})

await check('F3: one sentence when the room cannot be handed to a guest', () => {
  // 409 `target_guest`: a guest copy can never hold a room (8.1). Both tables
  // name it, and the screen's own handover table falls through to it.
  assert.equal(transferGuestErrorKey('target_guest'), 'group.transfer.err.target_guest')
  assert.equal(guestJoinErrorKey('target_guest'), 'group.transfer.err.target_guest')
  assert.equal(groupAddErrorKey('target_guest', null, null), 'group.transfer.err.target_guest')
  assert.equal(transferGuestErrorKey('target_suspended'), null, "somebody else's refusal, somebody else's line")
  assert.equal(transferGuestErrorKey(null), null)
  // The canonical English sentence, the same meaning in every locale.
  assert.equal(en['group.transfer.err.target_guest'], "A member from another island can't own this group.")
  for (const [lang, dict] of Object.entries(DICTS)) {
    const s = dict['group.transfer.err.target_guest']
    assert.equal(typeof s, 'string', lang)
    assert.ok(s.length > 0, lang)
    assert.ok(!s.includes('—'), `${lang}: em dash`)
  }
})

console.log(`guest-path: ok (${n} checks)`)
