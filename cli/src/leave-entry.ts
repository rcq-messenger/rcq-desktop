// Bundle entry: the console's leave check (spec 2026-09-15, 12.1 Leaving),
// for the offline test cli/test/leave-warning.mjs.
//
// Why this is its OWN bundle and not a few more lines on guest-entry.ts. The
// rule itself is pure and already proven there (leaveWarningVerdict /
// leaveWarnAfterFetch, cli/test/guest-path.mjs). What is unproven is the
// console's WIRING around it in cli/src/groups.ts: which uin it compares
// against, when it spends its one roster re-fetch, and what an island that
// will not answer comes to. That wiring lives in cli/src/groups.ts, whose
// imports reach receive.ts and so the signal wasm crate, which the guest
// bundle deliberately does not carry ("without a browser and without a
// network", guest-path.mjs's header). One more entry costs a file; folding it
// in would cost that test its isolation.
//
// `aliasFor` rides along so the test can mint a foreign room's alias through
// production code rather than hand-writing the stored shape.

export { leaveWarning } from './groups'
export { aliasFor } from '../../src/lib/visited-islands'
