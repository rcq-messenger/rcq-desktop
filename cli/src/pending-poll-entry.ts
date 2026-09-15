// Bundle entry: the pending-request poll's schedule and row rules (spec
// 2026-09-15, F1), for the offline test (cli/test/pending-poll.mjs). Both are
// pure, so they are proven against the BUILT bundle, without a browser, like
// crossisland-gate-entry.ts. move-carry rides along to prove the answered set
// moves with a UIN move.

export {
  AUTO_WITHDRAW_PER_HOUR,
  BACKOFF_MINUTES,
  FORCE_DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  POLL_JITTER,
  RETRY_AFTER_FLOOR_MS,
  backoffMs,
  createPendingPollSchedule,
  rateLimitWaitMs,
} from '../../src/lib/pending-poll-schedule'
export {
  MAX_ACCEPT_TRIES,
  MAX_RAW_SERVER_ROWS,
  MAX_SERVER_ROWS_PER_HOST,
  ackServerRef,
  answeredKey,
  mergeServerRequest,
  planServerRow,
  reconcileServerRequests,
  validServerRows,
  withdrawOutcome,
} from '../../src/lib/crossisland-pending'
export { copyScopedKeys } from '../../src/lib/move-carry'
