// Bundle entry: the two C0 guards from the cross-island spec (2026-09-15), for
// the offline test (cli/test/carbon-gate.mjs).
//
//  * P0.1: a carbon that names a key is ours only under our own signing key,
//    every inner kind; a `ciack` carbon never without our key; a keyless (v=2)
//    carbon of any other kind is accepted for now, the transitional rule iOS
//    ships, until Android 0.194 seals carbons v=1 (crossisland-gate.ts).
//  * P0.2: identity_rotated and identity_ambiguous never sign an account out,
//    and nothing does while a rotation is pending (session-verdict.ts).
//
// Both are pure, so they are proven against the BUILT bundle, without a
// browser, like crossisland-gate-entry.ts.

export { CARBON_KINDS_OWN_KEY_ONLY, carbonIsOwn, sameSigningKey } from '../../src/lib/crossisland-gate'
export { bootAction, mintFromRefusal, refusalCode } from '../../src/lib/session-verdict'
