// Bundle entry: the backup auto-pick rule (#988), for the offline test
// (cli/test/backup-pick.mjs). Same purpose as member-name-entry.ts: pure, so
// proven against the BUILT bundle, without a browser and without touching any
// island.

export {
  INFO_BODY_CAP,
  NO_ISLAND_REACHABLE,
  NO_OPEN_ISLAND,
  detailCodeOf,
  doorOf,
  doorRefusalOf,
  hostVerdict,
  infoVerdict,
  pickBackupIsland,
  probePassed,
  readCappedText,
} from '../../src/lib/backup-pick'
