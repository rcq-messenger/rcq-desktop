// Bundle entry: the rules behind the cross-island liveness probe and the
// pin-first seal (report 1067), for the offline test
// (cli/test/peer-liveness.mjs). Same purpose as member-name-entry.ts: pure,
// so proven against the BUILT bundle, without a browser or an island.

export {
  NO_ACCOUNT_FOR_KEY,
  NO_RECORD,
  NO_SUCH_USER,
  cardAgainstPin,
  cardStep,
  depositAfterMark,
  ownerStep,
  recordStep,
  sameIslandHost,
} from '../../src/lib/peer-liveness-rules'
export { buildHomeIslandRecord } from '../../src/lib/federation'
