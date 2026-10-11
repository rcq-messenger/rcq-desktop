// Bundle entry: when the home screen says "your island is not answering,
// messages are arriving through your backup island", for the offline test
// (cli/test/backup-failover.mjs). Same purpose as member-name-entry.ts: pure,
// so proven against the BUILT bundle, without a browser or an island.

export {
  failoverAccount,
  failoverVerdict,
  isReceivingViaBackup,
  setReceivingViaBackup,
  subscribeFailover,
} from '../../src/lib/backup-failover'
