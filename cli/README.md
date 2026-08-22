# rcq — console client

The distribution-proof RCQ client: one Node bundle, no app store, no native
deps. Scriptable plumbing (design: `RCQ/docs/console-client-design.md`) —
register/restore, contacts, contact requests both directions, 1:1 text both
ways, groups both ways, delivered receipts, dev-scoped queue drain, history,
`watch`, plus an interactive mode: run `rcq` with no arguments and you are in
a live conversation.

## Build

```
npm run cli:build      # esbuild -> cli/dist/rcq.mjs (+ pkg-node/ wasm beside it)
npm run cli:test       # offline round-trip smoke tests (no island touched):
                       #   v=2 X3DH both ways + serialize/restore
                       #   group dual-send, skdm handshake, held replay, dedup
```

Requires Node 22+ (global fetch, WebSocket, WebCrypto). `cli/dist/` is
self-contained: ship `rcq.mjs` together with the `pkg-node/` directory.

## Use

```
node cli/dist/rcq.mjs                        # interactive (TTY only)
node cli/dist/rcq.mjs register [--nick NAME] [--island URL]
node cli/dist/rcq.mjs restore "<24 words>" [--island URL]
node cli/dist/rcq.mjs whoami | contacts | export
node cli/dist/rcq.mjs who <uin> | find "NAME"                # who is this, or who is called that
node cli/dist/rcq.mjs add <uin> | requests | accept <uin> | decline <uin> | cancel <uin>
node cli/dist/rcq.mjs block <uin> | unblock <uin> | remove <uin> [--yes]
node cli/dist/rcq.mjs groups | join <id>
node cli/dist/rcq.mjs log [<uin>|g<id>] [n]
node cli/dist/rcq.mjs send <uin>|g<id> "text" [--yes]
node cli/dist/rcq.mjs watch [--groups]
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

## Groups

Rooms work here, in both directions. The console runs the same sender-key
code the web does (`sender-keys.ts`, `sender-key-store.ts`,
`group-crypto.ts` are React-free and localStorage-backed), so a `gmsg`
broadcast is opened with its chain, an `skdm` is filed against its
authenticated sender, and an `sknack` is answered. Posting is the same
dual-send every other client performs: one ciphertext for the members whose
account advertised the capability, the chain sealed per member to whoever
does not hold it yet, the legacy per-member fan-out for the rest.

* `rcq groups` lists id, name, member count and the room's rules as raw
  tokens (`owner_only`, `slowmode=30`, `no_links`).
* `/g` lists them at the prompt, `/g 21` or `/g Работа` opens one (a name
  works whole or as an unambiguous prefix). The prompt becomes `[Работа]>`
  and typed lines go there.
* Exactly ONE room is open at a time and only that one prints. Every other
  room keeps a count and says so at most once a minute: thirty rooms on one
  screen is not a conversation ("а если групп будет десятки?", founder). The
  content is on disk regardless: `/log`, `rcq log g21`. `rcq watch --groups`
  turns every room on at once, for a log or a bridge with no prompt to flood.
* Room rules are honoured HERE, not left to the island: owner-only posting
  and a link ban refuse before the message goes anywhere, and a slowmode 429
  comes back as "slow mode: 12s to go" rather than an HTTP status. Same exempt
  set as the web composer (owner, admin, any granted cap).
* A broadcast whose chain has not arrived is written to
  `gmsg-held-<uin>.json` BEFORE its queue row is acked, and replayed on later
  runs. The core holds those in memory, which is enough for a browser tab and
  not for a three-second `rcq send`: an in-memory hold plus an ack is a
  message the island let go of and this box never read.

The CLI advertises the sender-keys capability only from the paths that run the
receive loop, and the capability is per ACCOUNT, not per device: advertising
before the chains work makes every capable sender broadcast to an account
that cannot open a broadcast.

## Interactive mode

`rcq` with no arguments (on a TTY; a pipe still gets usage + exit 2): live
receive exactly like `watch`, with a readline prompt on top. Typed text goes
to the active target: a person picked with `/to <uin>`, a room with `/g`, or
whoever writes first (contacts and people you have written to only; rooms
never auto-pick). The prompt is their name (`Ivan (#500)> `, `[Работа]> `).
Walking into a thread replays its last lines from the history file, at least
as many as the room's badge promised. Incoming messages print above the
prompt; your 1:1 sends echo with a `✓ delivered` note when the receipt lands.
`/help` lists the rest: `/log`, `/contacts`, `/who`, `/find`, `/requests`,
`/accept`, `/decline`, `/cancel`, `/block`, `/unblock`, `/remove`, `/nick`,
`/quit` (or Ctrl+C / Ctrl+D). Output discipline is relaxed by design here, because it
is a UI, not a pipe; `send`/`watch` keep the strict contract.

## Contact requests

`rcq add <uin>` sends one and now reports what actually happened: the island
auto-accepts when the other side had already asked for you, and that used to
read as "request sent" like every other case. `rcq requests` lists both
directions, `rcq accept` / `rcq decline` answer, `rcq cancel` withdraws one of
yours. The live `contact_request` / `contact_response` frames are island
frames rather than envelopes and are routed separately from the sealed ones,
so a request that lands while you are sitting at the prompt says so.

## State

`$RCQ_CLI_HOME` (default `~/.config/rcq`), dir 0700, files 0600:

* `localstorage.json` — the identity, under the SAME keys the web uses, so
  `src/lib/auth.ts` runs unchanged. Includes the recovery seed: same trust
  level as ssh keys; passphrase sealing is a v1.5 flag.
* `signal-<uin>.json` — libsignal device state (the web's IndexedDB KV as a
  file; Uint8Arrays as `{__u8: base64}`). Atomic writes: a torn ratchet is
  every peer session gone.
* `history-<uin>.jsonl`: append-only received and sent messages. Rows are
  appended BEFORE the queue ack goes out (2026-08-20 rule: durable before
  ack). Also the memory behind the stranger gate (a peer with a row here is a
  thread, not a stranger) and what `rcq log` / `/log` read back.
* `gmsg-held-<uin>.json`: group broadcasts whose sender key has not arrived,
  plus one recovery-request stamp per chain so a cron'd CLI cannot NACK-storm
  a room. Aged out after 14 days, capped at 200.
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

## Known gaps

Each of these is a thing the CLI cannot do. Where the client used to
apologise vaguely for one, it now says which.

* **Media.** Inbound files, photos and videos print kind, name and size and
  cannot be downloaded; nothing can be uploaded. `media.ts` decrypts with
  WebCrypto and needs no DOM, so the receive half is portable, and simply
  not written. A room with `no_files` is reported as a rule but the CLI could
  not have posted a file anyway.
* **Cross-island send.** Cross-island messages DO arrive, and are labelled
  `#500@host` so they cannot be confused with a local uin, but there is no
  way to answer one: `/to` takes no host, and `federation-send.ts` is
  importable and unwired. Delivered receipts are deliberately NOT sent to a
  cross-island sender for the same reason (the receipt would address whoever
  holds that number on OUR island). Cross-island contact requests
  (`contactreq`) and profile refreshes are dropped.
* **Reactions, edits, deletes, replies.** All of them are dropped as
  unsupported envelope kinds. The delete is the one that matters: a message
  retracted on the sender's phone stays readable in `history-<uin>.jsonl`
  here, and the sender has no way to know.
* **Read receipts.** Only `delivered` goes out, so a peer's tick never turns.
  Incoming read receipts print to stderr under `RCQ_VERBOSE` only, and are
  not told apart from delivered ones.
* **Circumvention.** No CDN front, no proxy support, no relay use. On a
  network that blocks the island's host the CLI simply cannot connect,
  which is a poor showing for the client that exists because app stores can
  be blocked.
* **Account and device management.** No `devices`, no slot revoke, no
  unlink, no burn, no report channel, no `rcq link` (a second box still takes
  the 24-word phrase on a command line). `account_burned` off the socket is
  ignored.
* **Group administration.** Creating, renaming, deleting a room, moving
  members and setting its rules all belong where you can see the roster; the
  CLI reads rooms, posts to them, and joins an OPEN one by id. An invite
  LINK carrying a closed room's share token is not parsed.
* **Polls** print the question with no options and no way to vote.
* **Timestamps** are the moment this box read a message, not the island's
  `received_at`: drain a two-day backlog and it prints with today's clock.
  `rcq log` shows the same stamp, dated.
* `restore` onto a box meant to be the ONLY device still registers as
  secondary; the design doc's `--primary` flag is unimplemented.
* No passphrase at rest; file permissions only.
* No calls (a ring is invisible), no audio rooms, no stories, no nearby.
  A terminal should not have those; the silent ring should still say
  something, and does not.
