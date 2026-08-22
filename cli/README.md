# rcq: the console client

The distribution-proof RCQ client: one Node bundle, no app store, no native
deps (design: `RCQ/docs/console-client-design.md`). Run `rcq` with no arguments
and you are in a live conversation; everything else is plumbing for pipes and
cron.

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

## Interactive mode

`rcq` with no arguments, on a TTY (a pipe still gets usage + exit 2). Live
receive exactly like `watch`, with a readline prompt on top. It opens on the
threads with the most recent traffic (read out of the history file, so it is
instant and works offline), and typed text goes to the active target: a person
picked with `/to <uin>`, a room with `/g`, or whoever writes first (contacts
and people you have written to only; rooms never auto-pick). The prompt is
their name: `Ivan (#500)> `, `[Работа]> `.

```
  #396    Ivan (#396)            07:22:36  see you at ten
  g21     [Работа]               06:41:36  you: will look tonight
rcq> /to 396
[2026-08-20 07:06] Ivan (#396): are you there?
[07:22:36] Ivan (#396): see you at ten
Ivan (#396)> on my way
[07:31:02] me -> Ivan (#396): on my way
[07:31:03] ✓ delivered to Ivan (#396): on my way
```

What living in it is like:

* **Every line has the same shape**: `[when] who: what`, built in one place
  (`cli/src/format.ts`) for live messages, your own echoes, history replays and
  the delivery notes alike. The clock is the time the message HAPPENED, the
  island's `received_at` for a queued one, with the date as well when that was
  not today. Draining two days of backlog used to print all of it with today's
  time, in arrival order, which is Android's #628 in another client.
* **A typed line is echoed before it is sent**, not after. The send can take
  thirty seconds on a bad network, and the loop used to show nothing at all in
  the meantime, and if it threw, the text was simply gone. A refusal now prints
  `✗ not sent to Ivan (#396): <why>` and keeps the text for `/retry`.
* **The delivery tick names the message** (`✓ delivered to Ivan (#396): on my
  way`), because two lines to the same person produced two identical notes.
  Waiting entries are forgotten after ten minutes: no tick simply means the peer
  has not picked it up.
* **Incoming lines do not fight the prompt.** They are printed above it and the
  half-typed line is redrawn under them, including when it has wrapped across
  several rows (clearing exactly one row was why a long line came back
  mangled). A list prints as one block: one clear, one redraw, no flicker.
* **The connection says one line each way.** `offline - reconnecting, and the
  queue is read every 30s meanwhile` when it drops, `back online` when it comes
  back; the close codes are `RCQ_VERBOSE`-only. Two raw `[ws]` lines per redial
  used to run through the conversation for as long as the network flapped.
* **Up-arrow reaches past this session.** Commands are remembered in
  `prompt-history`; message bodies deliberately are not (see below).
* **Ctrl+C on a half-typed line drops the line, not the session.** On an empty
  line it leaves, and a send still in flight is given a few seconds to land
  first (a second Ctrl+C goes now). Ctrl+D leaves too.

`/help` is the map and lists everything the loop has: `/to`, `/g`, `/recent`,
`/log`, `/retry`, `/who`, `/find`, `/contacts`, `/add`, `/requests`, `/accept`,
`/decline`, `/cancel`, `/block`, `/unblock`, `/remove`, `/whoami`, `/nick`,
`/join`, `/export`, `/lang`, `/quit`.

⚠ Every one-shot verb that makes sense at a prompt has a slash of its own, and
that is not a convenience: one rcq holds the state lock for its dir, so while
the prompt is open `rcq whoami` in another terminal refuses to run. A verb with
no slash is a verb you have to quit the conversation to reach.

Output discipline is relaxed here by design, because it is a UI and not a pipe;
`send`/`watch` keep the strict contract.

## Names, and writing to a stranger

Nothing in the stream is a bare number when a name is known. Contacts and
group names come from the roster snapshot (`src/lib/contacts-cache.ts`,
the same one the web paints from), refreshed at startup and persisted, so
the FIRST line of a run is already named and an offline run still is.
A sender in no list is resolved once through `/users/{uin}/info` and
remembered. A cross-island peer keeps their host (`#500@is2.rcq.app`):
`#500` here and `#500` there are two different people, in the message
stream and in the `/recent` list alike.

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
  and typed lines go there. `/join <id>` joins an open room and walks in.
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

* `localstorage.json`: the identity, under the SAME keys the web uses, so
  `src/lib/auth.ts` runs unchanged. Includes the recovery seed: same trust
  level as ssh keys; passphrase sealing is a v1.5 flag.
* `signal-<uin>.json`: libsignal device state (the web's IndexedDB KV as a
  file; Uint8Arrays as `{__u8: base64}`). Atomic writes: a torn ratchet is
  every peer session gone.
* `history-<uin>.jsonl`: append-only received and sent messages. Rows are
  appended BEFORE the queue ack goes out (2026-08-20 rule: durable before
  ack). Also the memory behind the stranger gate (a peer with a row here is a
  thread, not a stranger) and what `rcq log`, `/log` and `/recent` read back.
* `gmsg-held-<uin>.json`: group broadcasts whose sender key has not arrived,
  plus one recovery-request stamp per chain so a cron'd CLI cannot NACK-storm
  a room. Aged out after 14 days, capped at 200.
* `prompt-history`: the last 200 COMMANDS typed at the prompt, for up-arrow
  across restarts. ⚠ Message bodies are deliberately never written here: what
  is typed at a chat prompt is mostly what is said at it, and a second
  plaintext copy of that in a file nobody mentioned is not a feature. Inside a
  session readline still recalls everything.
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
`message-receiver.tsx`): same wire, same ack protocol, same receipt rules.

The ONE src/lib change is `setProvisionPolicy('secondary')`: the CLI never
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
* **Typing notifications** are dropped, and that one is deliberate: a prompt
  has nowhere to draw "alice is typing" except the line being edited, and
  SENDING them from a headless box would leak keystroke timing from the client
  whose whole pitch is that it runs where nobody is watching.
* **Threads are keyed by uin alone**, so a cross-island `#500` and a local
  `#500` share one `/log` and one `/recent` row. The lines inside it are
  labelled with the host they came from; the thread is not split.
* `restore` onto a box meant to be the ONLY device still registers as
  secondary; the design doc's `--primary` flag is unimplemented.
* No passphrase at rest; file permissions only.
* No calls (a ring is invisible), no audio rooms, no nearby. A terminal
  should not have those; the silent ring should still say something, and
  does not.
