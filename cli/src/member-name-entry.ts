// Bundle entry: the group member name order alone (#982), and the sanitizer
// for the "forwarded from" credit on an incoming message (report 1063), for
// the offline test (cli/test/member-name.mjs). Same purpose as
// routes-entry.ts: proven against the BUILT bundle, without a browser.

export { FWD_NAME_MAX, forwardedName, isNumberOnly, memberName, quotedAuthorNames } from '../../src/lib/member-name'
