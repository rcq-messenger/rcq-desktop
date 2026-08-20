# rcq — console client (v1)

The distribution-proof RCQ client: one Node bundle, no app store, no native
deps. Scriptable plumbing first (design: `RCQ/docs/console-client-design.md`)
— register/restore, contacts, 1:1 text both ways, delivered receipts,
dev-scoped queue drain, `watch`.

## Build

```
npm run cli:build      # esbuild -> cli/dist/rcq.mjs (+ pkg-node/ wasm beside it)
npm run cli:test       # offline v=2 round-trip smoke test (no island touched)
```

Requires Node 22+ (global fetch, WebSocket, WebCrypto). `cli/dist/` is
self-contained: ship `rcq.mjs` together with the `pkg-node/` directory.

## Use

```
node cli/dist/rcq.mjs register [--nick NAME] [--island URL]
node cli/dist/rcq.mjs restore "<24 words>" [--island URL]
node cli/dist/rcq.mjs whoami | contacts | add <uin> | export
node cli/dist/rcq.mjs send <uin> "text"
node cli/dist/rcq.mjs watch
```

stdout is data only (messages, the phrase, lists); status goes to stderr.
Exit codes: 0 ok, 1 error, 2 usage.

## State

`$RCQ_CLI_HOME` (default `~/.config/rcq`), dir 0700, files 0600:

* `localstorage.json` — the identity, under the SAME keys the web uses, so
  `src/lib/auth.ts` runs unchanged. Includes the recovery seed: same trust
  level as ssh keys; passphrase sealing is a v1.5 flag.
* `signal-<uin>.json` — libsignal device state (the web's IndexedDB KV as a
  file; Uint8Arrays as `{__u8: base64}`). Atomic writes: a torn ratchet is
  every peer session gone.
* `history-<uin>.jsonl` — append-only received messages. Rows are appended
  BEFORE the queue ack goes out (2026-08-20 rule: durable before ack).

## Architecture

Reuses `src/lib` as-is via three esbuild swaps (see `cli/build.mjs`):
the browser wasm glue -> the pkg-node build of the same crate, IndexedDB ->
file KV, client label -> `Console · <os>`. The socket and the receive loop
are thin plain-class rewrites of the React-wrapped ones (`ws.tsx`,
`message-receiver.tsx`) — same wire, same ack protocol, same receipt rules.

The ONE src/lib change: `setProvisionPolicy('secondary')` — the CLI never
claims the account's primary slot, whoever holds it (see the comment in
`signal-device.ts`; a headless box must not evict the phone).

## Known gaps (v1.1+)

* Groups: `gmsg` rows are acked away with a stderr note — no sender-keys
  chains here yet (`sender-keys.ts` is portable as-is).
* Media: inbound files/photos print kind + size only, no download; no media
  send.
* No cross-island send path (federation-send is importable, unwired), no
  backup-island polling, no calls, no rooms.
* `restore` onto a box meant to be the ONLY device still registers as
  secondary; the design doc's `--primary` flag is unimplemented.
* Read receipts are not sent (only delivered); incoming read receipts print
  to stderr.
* No passphrase at rest; file permissions only.
