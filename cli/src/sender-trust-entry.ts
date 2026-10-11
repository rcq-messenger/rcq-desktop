// Bundle entry: the sender-auth rules (11.10), for the offline test
// (cli/test/sender-auth.mjs). The trust decision and the room-key bound are
// pure; the sender-key store is localStorage-backed and the test stubs it,
// like group-roundtrip.mjs does. All production code from src/lib.

export {
  ROOM_KEY_MAX_AHEAD,
  directControlAllowed,
  directSenderTrust,
  roomKeyVersionAllowed,
  roomSenderTrust,
  skdmRoomMatches,
} from '../../src/lib/sender-trust'
export { prekeyMessageIdentity, sessionRemoteIdentities, v2IdentityDecision } from '../../src/lib/v2-identity'
export { acceptSkdm, deriveInbound, knowsKid, peekInbound } from '../../src/lib/sender-key-store'
export { sameSigningKey } from '../../src/lib/crossisland-gate'
