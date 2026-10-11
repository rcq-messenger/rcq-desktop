// Bundle entry: when the home screen says "your island is not answering,
// messages are arriving through your backup island", for the offline test
// (cli/test/backup-failover.mjs). Same purpose as member-name-entry.ts: pure,
// so proven against the BUILT bundle, without a browser or an island.

export {
  failoverAccount,
  failoverVerdict,
  isReceivingViaBackup,
  primaryAnswers,
  setReceivingViaBackup,
  subscribeFailover,
} from '../../src/lib/backup-failover'
// The probe asks the front layer which road the flagship has. Exported from
// THIS bundle so the test drives the same module instance the probe reads.
export { frontBaseFor, installFrontRouting, setFrontHost } from '../../src/lib/front'
