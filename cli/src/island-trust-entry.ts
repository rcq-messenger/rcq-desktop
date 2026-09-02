// Eighth bundle entry: the pure half of the island trust rule, for the
// offline test (cli/test/island-trust.mjs). Same purpose as routes-entry.ts -
// what can be proven without a network is proven against the BUILT bundle.
//
// `decide` is §1 itself, and the end-to-end half of that test cannot reach
// all of it: every island it stands up is self-signed, so `caValid` is never
// true there and the two branches that answer to a certificate AUTHORITY -
// the `ca` write on the success path, and the refusal of a private
// certificate for an island known through a CA - are never executed. Those
// are exactly the branches §7.4's ⚠ is about: without the success-path write
// there are no `ca` records, and every island used for months over Let's
// Encrypt is an unknown island that a self-signed certificate takes on first
// use. The Rust side tests both; this is how the console's own copy of the
// rule gets the same treatment.

export { decide } from './island-trust'
