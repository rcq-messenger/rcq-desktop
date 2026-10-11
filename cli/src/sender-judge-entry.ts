// Bundle entry: the gathering half of the sender-auth rules (11.10), for the
// offline test (cli/test/sender-judge.mjs): the card and roster reads a
// verdict waits on, the room roster's "asked after the row arrived" rule,
// and the v=2 device-list check. The test stands in for the island with a
// fake fetch. All production code from src/lib.

export { resolveDirectTrust, resolveRoomTrust } from '../../src/lib/sender-trust-resolve'
export { contactsCache } from '../../src/lib/contacts-cache'
export { signPinFor } from '../../src/lib/sign-pins'
export { verifyV2Identity, IdentityCheckUnavailableError } from '../../src/lib/signal-device'
