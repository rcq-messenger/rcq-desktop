// Fourth bundle entry: the F3 deposit-auth client crypto alone (blind-token.ts),
// for the interop test (cli/test/blind-token.mjs). It proves the TS
// encode/blind/finalize/verify is byte-exact with the Python issuer
// (rcq-server-ref app/core/deposit_auth.py) against the vectors
// tools/gen-deposit-auth-vectors.py emits. Nothing ships from here; it exists so
// the test can import a built module the same way the round-trip tests do.

export * from '../../src/lib/blind-token'
