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
node cli/dist/rcq.mjs who <uin>                              # name, status, contact or not
node cli/dist/rcq.mjs send <uin> "text" [--yes]
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

## Names, and writing to a stranger

Nothing in the stream is a bare number when a name is known. Contacts and
group names come from the roster snapshot (`src/lib/contacts-cache.ts`,
the same one the web paints from), refreshed at startup and persisted, so
the FIRST line of a run is already named and an offline run still is.
A sender in no list is resolved once through `/users/{uin}/info` and
remembered. A cross-island peer keeps their host (`#500@is2.rcq.app`):
`#500` here and `#500` there are two different people.

The mailbox stays open (anyone may write first), but the first message of
a thread with somebody who is neither a contact nor anybody you have
exchanged a word with is confirmed first: `rcq send` asks on a TTY and
needs `--yes` from a script, and the interactive loop warns at `/to` and
asks before the first line goes out. A uin nobody holds is refused rather
than sent into a failing key lookup. Auto-picking a reply target skips
strangers, so a spammer who writes first is never the default recipient of
the next line typed.

## Interactive mode

`rcq` with no arguments (on a TTY; a pipe still gets usage + exit 2): live
receive exactly like `watch`, with a readline prompt on top. Typed text goes
to the active contact — picked with `/to <uin>`, or auto-picked as whoever
writes first, contacts and people you have written to only. The prompt is
their name (`Ivan (#500)> `). Incoming messages print above it; your sends
echo with a `✓ delivered` note when the receipt lands. `/contacts` lists,
`/who <uin>` says who a number belongs to, `/help` helps, `/quit` (or
Ctrl+C / Ctrl+D) leaves. Output discipline is relaxed by
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
  BEFORE the queue ack goes out (2026-08-20 rule: durable before ack). Also
  the memory behind the stranger gate: a peer with a row here is a thread,
  not a stranger.
* `lang`: the chosen language (`en`/`ru`), written by `rcq lang`.

Local stores inside `localstorage.json` are keyed per account
(`setAccountScope`, called from `cli/src/directory.ts`): the roster
snapshot under `rcq.web.<uin>.contacts.snapshot`, learned names under
`rcq.cli.names.<uin>`.

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

* Groups: `gmsg` rows are acked away with a stderr note (named, but still
  acked) — no sender-keys chains here yet (`sender-keys.ts` is portable as
  is). On an account whose phone advertised the capability that is EVERY
  group message, and acked means gone: the CLI is not the place to read a
  group in v1.
* Group content that does arrive by legacy fan-out is banked to the history
  file and summarised, not printed. No group send.
* Media: inbound files/photos print kind + size only, no download; no media
  send.
* No cross-island send path (federation-send is importable, unwired), no
  backup-island polling, no calls, no rooms. Cross-island messages DO
  arrive; they are labelled `#500@host` so they cannot be confused with a
  local uin, but `/to` has no host syntax to answer them with.
* Contact requests can be sent and not answered: no `pending`, no accept,
  no decline, and the live `contact_request` frame is dropped by the socket
  filter.
* `restore` onto a box meant to be the ONLY device still registers as
  secondary; the design doc's `--primary` flag is unimplemented.
* Read receipts are not sent (only delivered); incoming read receipts print
  to stderr under `RCQ_VERBOSE` only.
* No passphrase at rest; file permissions only.
