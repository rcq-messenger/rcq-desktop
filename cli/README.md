# rcq — console client

The distribution-proof RCQ client: one Node bundle, no app store, no native
deps. Scriptable plumbing (design: `RCQ/docs/console-client-design.md`) —
register/restore, contacts, 1:1 text both ways, delivered receipts,
dev-scoped queue drain, `watch` — plus an interactive mode: run `rcq` with no
arguments and you are in a live conversation.

## Build

```
npm run cli:build      # esbuild -> cli/dist/rcq.mjs (+ pkg-node/ wasm beside it)
npm run cli:test       # offline v=2 round-trip smoke test (no island touched)
```

Requires Node 22+ (global fetch, WebSocket, WebCrypto). `cli/dist/` is
self-contained: ship `rcq.mjs` together with the `pkg-node/` directory.

## Use

```
node cli/dist/rcq.mjs                        # interactive (TTY only)
node cli/dist/rcq.mjs register [--nick NAME] [--island URL]
node cli/dist/rcq.mjs restore "<24 words>" [--island URL]
node cli/dist/rcq.mjs whoami | contacts | add <uin> | export
node cli/dist/rcq.mjs send <uin> "text"
node cli/dist/rcq.mjs watch
node cli/dist/rcq.mjs lang [en|ru]
```

For subcommands, stdout is data only (messages, the phrase, lists); status
goes to stderr. Exit codes: 0 ok, 1 error, 2 usage.

Human-facing lines speak English or Russian: `rcq lang ru` persists the
choice in the state dir; unset, a `ru*` LC_ALL/LANG answers Russian. The
string table is `cli/src/i18n.ts` (a plain dict, both languages side by
side). Data output for scripts never translates: uin numbers, history
lines, whoami values and message bodies are byte-identical in either
language.

## Interactive mode

`rcq` with no arguments (on a TTY; a pipe still gets usage + exit 2): live
receive exactly like `watch`, with a readline prompt on top. Typed text goes
to the active contact — picked with `/to <uin>`, or auto-picked as whoever
writes first. Incoming messages print above the prompt; your sends echo with
a `✓ delivered` note when the receipt lands. `/contacts` lists, `/help`
helps, `/quit` (or Ctrl+C / Ctrl+D) leaves. Output discipline is relaxed by
design here — it is a UI, not a pipe; `send`/`watch` keep the strict
contract.

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
* `lang`: the chosen language (`en`/`ru`), written by `rcq lang`.

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
