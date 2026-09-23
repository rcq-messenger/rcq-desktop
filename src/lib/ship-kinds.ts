// Which envelope kinds a chat thread will actually put on the wire, and which
// it mirrors to the account's other devices.
//
// Pure on purpose, no imports beyond a type, so the rule is proven offline
// against the built bundle (cli/test/ship-kinds.mjs) instead of inside a React
// component where nothing could reach it.
//
// ⚠⚠ Why this left Chat.tsx (#1038, #1039). The voice composer shipped on
// 2026-08-29 and this gate never learned the word: every voice note recorded
// on the web or the desktop was sealed into a blob, uploaded (201), turned into
// a row, and then refused HERE, two lines into `shipEnvelopeToCurrentThread`,
// with `unsupported envelope kind: voice`. No request, no exception, no console
// line: the island never heard of the message, and the person saw "не
// доставлено" under a clip that had in fact reached the island's disk. Two
// hand-kept lists (what the composer builds, what the gate lets through) had
// drifted, and nothing tied them together.
//
// What ties them now: `ComposedEnvelope` is the type `attemptSendRow` builds
// into, and it is derived from COMPOSED_KINDS, which is spread into the gate.
// A new branch in the composer that is not listed here is a compile error, and
// a kind listed here cannot be missing from the gate.

import type { Envelope } from './crypto'

/// Every kind `attemptSendRow` (Chat.tsx) builds out of an outgoing row: the
/// ones a person composes and can retry from a failed bubble.
export const COMPOSED_KINDS = ['text', 'photo', 'file', 'voice', 'location'] as const
export type ComposedKind = (typeof COMPOSED_KINDS)[number]
/// The envelope `attemptSendRow` is allowed to build. Anything else fails to
/// type-check there, instead of failing at the gate in front of a person.
export type ComposedEnvelope = Extract<Envelope, { kind: ComposedKind }>

/// Envelope kinds `shipEnvelopeToCurrentThread` is allowed to encrypt + send.
/// (Carbons take a separate path; this gates the in-thread sends.) `edit` was
/// missing here once, which silently rejected edit propagation to the peer,
/// and `voice` for its first four weeks (see the header).
///
/// Beyond the composed kinds: `reaction`, `edit` and `delete` have composers
/// of their own; `video` is not composed on the web (no thumbnail or duration
/// extraction) and stays allowed for whatever builds one.
export const SHIPPABLE_KINDS: ReadonlySet<Envelope['kind']> = new Set<Envelope['kind']>([
  ...COMPOSED_KINDS,
  'video',
  'reaction',
  'edit',
  'delete',
])

/// Message kinds we mirror to the user's other devices via a carbon
/// (NOT reactions — those sync through their own self-echo).
///
/// `edit` and `delete` joined 2026-08-21: the group fan-out deliberately
/// skips self (group-crypto), so the carbon is the ONLY road an edit or a
/// retract has to the account's other devices — without them the founder
/// edited a message on the desktop and the phone kept the old text forever.
/// `voice` joined 2026-09-01: Android has always been able to file one from a
/// carbon, and leaving it out meant a voice message sent from the desktop was
/// the one kind that never appeared on the phone. (In practice no voice carbon
/// left the web until the gate above let voice out: a carbon is sent only after
/// the thread send succeeds.)
export const CARBON_KINDS: ReadonlySet<Envelope['kind']> = new Set<Envelope['kind']>([
  'text',
  'photo',
  'video',
  'voice',
  'file',
  'location',
  'edit',
  'delete',
])
