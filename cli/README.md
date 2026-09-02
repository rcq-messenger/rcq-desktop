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

Requires Node 22+ (global fetch, WebSocket, WebCrypto), and **Node 24+ if you
use `rcq proxy`**: the proxy rides Node's own env-proxy support, which older
runtimes read nothing of. On 22 and 23 a command with a proxy configured is
refused rather than sent direct. `cli/dist/` is self-contained: ship `rcq.mjs`
together with the `pkg-node/` directory.

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
node cli/dist/rcq.mjs proxy [set <addr>|clear|test]      # your own Tor / i2p / tunnel
node cli/dist/rcq.mjs routes [--probe|--refresh|--singbox]  # roads to the island
node cli/dist/rcq.mjs island trust <host[:port]> <fp> [--replace]   # an island with no certificate authority
node cli/dist/rcq.mjs island fingerprint [host] | island forget <host[:port]>
```

For subcommands, stdout is data only (messages, the phrase, lists); status
goes to stderr. Exit codes: 0 ok, 1 error, 2 usage.

Environment: `RCQ_CLI_HOME` moves the state dir, `RCQ_VERBOSE=1` shows
protocol detail, `NO_COLOR` strips colour, `RCQ_PROXY` overrides the saved
proxy for one command (`RCQ_PROXY=off` turns it off for one command),
`RCQ_NO_UPDATE_CHECK=1` stops the CLI asking GitHub anything, and
`RCQ_TIMEOUT_MS` (default 20000) is how long any one request may take before
it is abandoned. Node's
`fetch` has no timeout of its own and neither does `src/lib/api.ts`, so
without a deadline a connection that is established and then goes silent
hangs for as long as the kernel keeps the socket: measured against prod on
2026-08-22, one send sat for 41 seconds and everything typed behind it
waited with it. Raise it on a link slow enough that 20s is a real answer.

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

### Rooms on other islands (federation §5c)

`rcq join 123@is2.rcq.app` (or a full invite link,
`https://rcq.app/g/123@is2.rcq.app` / `rcq://group/123@...`) joins a room
that lives on another island, with the web's own mechanism reused verbatim
(`src/lib/visited-islands.ts`):

* The typed `join` guest-registers this identity on the room's island -
  recover-first with the same keypair, so the per-island uin is stable. The
  first packet to that island leaves at the moment you type the command and
  never earlier: merely seeing a link touches nothing (the web's privacy
  rule, kept).
* Locally the room gets a stable NEGATIVE alias id (`g-1000`): per-island
  group ids collide, and everything here keys rooms by a number. `rcq groups`
  prints a foreign room with `@host` as an extra column (`--json` carries
  `host` and `remote_id`), and the alias works everywhere a gid does:
  `rcq send g-1000 "text"`, `rcq log g-1000`, `/g -1000`, `rcq leave g-1000`.
* Sends go to the HOST island as the guest, legacy per-member fan-out ONLY
  (no sender-keys for cross-island rooms in v1, same as the web), and no
  self-carbon (alias ids are per-device; another device would misread the
  room id).
* Receiving is POLLING, no second socket: every drain (one-shots, watch,
  the interactive 30s tick) also drains the guest mailbox and Stage-5 room
  logs on each visited island, mapping remote gids to the alias before
  ingest, with the same durable-before-ack discipline.
* Guest tokens are never written to disk (the web's rule): a fresh process
  re-mints them through the recover handshake on first use.
* `leave` removes the guest uin from the roster on the host island; the
  guest account itself remains (harmless, and rejoining recovers it).

## Contact requests

`rcq add <uin>` sends one and now reports what actually happened: the island
auto-accepts when the other side had already asked for you, and that used to
read as "request sent" like every other case. `rcq requests` lists both
directions, `rcq accept` / `rcq decline` answer, `rcq cancel` withdraws one of
yours. The live `contact_request` / `contact_response` frames are island
frames rather than envelopes and are routed separately from the sealed ones,
so a request that lands while you are sitting at the prompt says so.

## Roads to the island

```
rcq routes                             which road is in use, and what was tried
rcq routes --probe                     walk the ladder now instead of reusing the answer
rcq routes --refresh                   re-fetch and verify the signed relay list
rcq routes --singbox --out FILE        write a sing-box config from that list
```

Three rungs, in the order the phones walk them
(`Session.kt runRouteLadder`):

1. **Direct** - the island's own address. Always preferred and always
   re-checked, so a network that stops blocking recovers on its own.
2. **The CDN front** - the same island under `cdn.rcq.app`, or wherever the
   signed config's `transport.front` moved it. Only a hostname changes, which
   is why this is the one circumvention layer the CLI can do entirely by
   itself. Flagship only: the front proxies one island, and sending a
   self-hosted island through it would turn a working server into a 404.
3. **Your proxy** - `rcq proxy set`, below. A proxy is a MODE rather than a
   rung: the address ladder still runs inside it (proxy, then proxy + front),
   and nothing ever falls back OUT of it. Somebody who pointed RCQ at Tor and
   then had it quietly retry direct would be deanonymised by their own
   messenger, so that road is closed by construction - the proxy is in the
   process environment before any of this code is evaluated.

The answer is written down (`routes.json`) and reused for half an hour, so a
`rcq send` in a cron loop pays for a probe once rather than every minute; the
front also engages on socket evidence alone, after three sockets in a row that
died moments after opening while ordinary requests were fine, which is the
signature of a middlebox no health probe can see.

**The relay list.** `--refresh` fetches the Ed25519-signed relay config the
phones use, from the two compiled-in mirrors plus whatever mirrors the last
payload named - a list that can include a **TXT record read over DoH**, which
is the channel that keeps working when both mirror names are blocked. ⚠ That
extra channel arrives INSIDE a payload, so it is only available to a state dir
that has already verified one (the phones' bundled sources are the same two
HTTPS mirrors): on a first refresh from a fresh `$RCQ_CLI_HOME`, on a blocked
network, there are two mirrors to try and nothing else. A payload older than one already
trusted is refused: a signature proves a payload came from us and says nothing
about when, so a replayed old one would walk a client back onto relays we
retired.

**What the CLI cannot do, and does not pretend to.** The relays speak
VLESS+Reality and Hysteria2. The phones tunnel through them by linking a Go
sing-box core; Node has nothing to link, and there will be no embedded
transport here. So `rcq routes --singbox` writes the config for a sing-box you
install yourself:

```
rcq routes --singbox --out ~/.config/rcq/singbox.json
sing-box run -c ~/.config/rcq/singbox.json
rcq proxy set socks5://127.0.0.1:1089
```

The relay list, the tiering and the onion entry are ours; the circumvention is
sing-box's. Two rules in that config are stricter than the phones', both from
the adversarial review in `RCQ/docs/relay-distribution-v2.md`:

* a broker relay can never win the latency race - `urltest` picks the fastest
  passing outbound, so a well-provisioned hostile relay would become the sole
  hop and see client-IP together with the island. The signed list is the
  primary group; the broker pool enters as one nested member behind a
  tolerance wide enough that only a real failure moves traffic onto it.
* a broker relay is never the onion **entry**. The broker asserts `tier` over
  plain TLS, so a compromised one could otherwise mint the one hop that sees
  the client's address. Only the signed config names an entry.

The entry itself the CLI does choose, and it is sticky across runs: highest
reachable by a TCP probe, random among near-equals, kept once picked (the Tor
guard lesson). If the pinned entry does not answer, the config degrades to a
single hop over the signed list ONLY - never through a relay an onion user
did not vouch for.

## Your own proxy (Tor, i2p, a tunnel)

```
rcq proxy                              what is set right now
rcq proxy set tor                      preset: SOCKS5 127.0.0.1:9050 (Orbot, or a local tor)
rcq proxy set i2p                      preset: SOCKS5 127.0.0.1:4447 (i2pd)
rcq proxy set socks5://127.0.0.1:9050
rcq proxy set http://user:pass@10.0.0.9:8118
rcq proxy test                         prove it carries traffic to the island
rcq proxy clear                        back to a direct connection
```

Everything the CLI opens after that goes through the proxy: the HTTPS calls,
the WebSocket, and the update check. Nothing else needs configuring and no
part of the protocol changes. Same idea, and the same vocabulary, as
LOCAL_PROXY on the phones (`RCQ/docs/proxy-design.md`): one proxy at a time,
and the proxy is the whole circumvention layer.

`set` checks it right away (`--no-test` skips that, for scripts). The check is
not a ping: it makes one real request to the island's `/health` through the
proxy, in a child process that was started behind it, and before that a
control run through an address nothing can be listening on, aimed at a server
on your own loopback. If that control run SUCCEEDS then this Node is ignoring
the proxy environment altogether, and the test says so instead of handing you
a green light that means nothing. The control run never touches the island:
a detector for "your traffic is going out unproxied" must not be the thing
that sends the unproxied packet.
`rcq proxy test` exits 0 or 1, so `rcq proxy test && rcq send ...` is a usable
shape, and every failure names itself: nothing listening there, that port is
not a SOCKS5 proxy, the proxy answered but the island did not.

Only `socks5://`, `http://` and `https://` are accepted, and that is not our
list: Node itself refuses the others before any of our code runs, so a stored
`socks5h://` would break every later command including the one that clears it.
(`socks5://` already hands the island's NAME to the proxy rather than an
address the CLI resolved, which is what `socks5h` buys elsewhere.)

**How it engages.** `NODE_USE_ENV_PROXY=1` with `HTTPS_PROXY` makes Node's own
`fetch` and `WebSocket` ride the proxy, socks5 included. Node reads that
environment once, before any of our code runs, and never re-reads it, so `rcq`
cannot simply set it for itself: when a proxy is configured the process
**re-execs itself** with the variables in place (`process.execve`, so it is
the same pid, the same terminal, the same exit code) before anything else
happens. The bash launcher could have exported them instead, but it is only
one of the ways in (`node cli/dist/rcq.mjs` is another), and a proxy that
engages only when somebody went through a shell script is a proxy that
silently does not engage. Cost: one extra process start per command while a
proxy is set. Needs **Node 24 or newer**; on 22 and 23 those variables do
nothing at all, so a command with a proxy configured is REFUSED there rather
than quietly sent over your own address. Everything else about the proxy fails
the same way: a value the runtime cannot carry (`socks5h://`, a typo, a
hand-edited `proxy.json`) stops the command instead of falling back to a direct
connection, and a proxy exported in your shell that names a different address
than the one you configured loses to yours.

`rcq proxy` is the one command that deliberately does NOT run behind the proxy
it configures, so a proxy that is down can always be cleared.

**A throwaway account, under your own protection**, start to finish:

```
export RCQ_CLI_HOME=$(mktemp -d)   # its own identity, history and proxy
rcq proxy set tor                  # everything below rides your Tor
rcq register                       # prints the UIN and the 24 words
rcq send 100200 "on my way"
rm -rf "$RCQ_CLI_HOME"             # and it never existed
```

The proxy is set BEFORE the account exists, so registering is itself the first
thing it carries and the island never sees your address at any point.

⚠ `RCQ_PROXY=off` runs one command direct, and it has no place in this recipe:
any command that carries the throwaway account's token - `whoami`, `send`,
`watch` - ties that UIN to your real address on the island permanently, and
`rm -rf "$RCQ_CLI_HOME"` deletes only your half. Use it to compare routes
before an account exists, or from a state dir you do not mind linking.

**What this does not give you.** A proxy is not RCQ's relay ladder. There is
no CDN front here, no relay pool, no onion mode, and if the island's address
is blocked for your proxy too then nothing improves. The island still sees a
connection and a session: from the proxy's address instead of yours. Tor hides
where you are from the island; it does not hide from the island that somebody
is talking, how often, or to which account. And a proxy you did not build
yourself sees exactly what a relay would, so this is worth precisely as much
as the proxy is.

## An island without a certificate authority

```
rcq register --island 203.0.113.5:8443#ab12cd34…    the address the operator hands out: host[:port]#fingerprint
rcq island trust 203.0.113.5:8443 AB:12:CD:…        pin before the first connection (openssl's spelling is fine)
rcq island fingerprint [host[:port]]                how an island is trusted, and its address with the fingerprint
rcq island forget 203.0.113.5:8443                  drop the pin; the next connection is a first use again
rcq island trust <host[:port]> <fp> --replace       accept a changed certificate
```

An island whose certificate no authority signed (the installer's fingerprint
mode, or any island reachable only by IP) is trusted by the SHA-256
fingerprint of its certificate, the way ssh trusts a host key. The rule is
the one every client follows (`RCQ/docs/island-fingerprint-design.md`), and
it runs BEFORE the first request to an island in a process, on one TLS
handshake of the CLI's own:

* A chain the platform trusts for that host is accepted and written down as
  `ca`. Let's Encrypt rotates every two months, so a CA island is never pinned.
* An island never met, presenting a private certificate, is pinned on first
  use, and one line on stderr says so with the fingerprint. The careful path
  is the fragment: `host:port#fingerprint`, taken by `--island`, by `join`
  (`<gid>@<host>#<fp>`) and by `island trust`, goes on file before anything is
  dialled, and the first connection has to match it. A fingerprint the person
  typed wins over an authority's signature, too: a CA-valid chain that hashes
  to something else is a change, not a pass.
* A certificate that differs from what is on file is REFUSED: the command
  does not run, nothing is sent, and stderr carries the fingerprint on file,
  the one presented, and the `island trust … --replace` line that accepts it.
  A refusal is not a blocked road: the route ladder never sees it, so no
  front or proxy is engaged for an island that answered.
* A fragment that is not 64 hex characters, or one on the flagship (anything
  under `rcq.app` is only ever trusted through an authority), is an address
  error: exit 2, nothing dialled. Dropping it and connecting anyway would
  take a first-use pin while the person believes they pinned.
* An island with a fingerprint on file that does not ANSWER the probe stops
  the command too (after one more ask, on the route ladder's own budget).
  Nothing else here enforces a pin - Node judges the command's own request
  against the platform roots plus our anchors, never against the record - so
  a probe that gave up used to be a way past the pin. An island with nothing
  on file, or one known through an authority, is unaffected: the platform
  check is all we would have asked for anyway.

`whoami` shows how the account's island is trusted, `rcq islands` shows it
per catalogue row (and lists the islands on file that the catalogue does
not), and `island fingerprint` prints `host:port#fp` on stdout, ready to
hand to somebody.

How Node carries it: the global `fetch` and `WebSocket` take no custom
verifier, but Node reads `NODE_EXTRA_CA_CERTS` at startup, and the CLI
already re-executes itself to set startup-only environment for the proxy. So
a pinned island is one PEM under `island-certs/`, and the same single exec
that carries the proxy variables carries a bundle of every pinned PEM. A pin
taken mid-command (the first use) is adopted in place on Node 24.5+ and
carried by one exec before the command runs on older Node; a command is
never re-run after a failure. Behind a proxy the probe speaks SOCKS5 or HTTP
CONNECT itself, so the handshake that judges an island never goes around the
proxy that hides you from it.

Three limits, written down:

* ⚠ An extra anchor is an anchor for every host: Node has no "this
  certificate, for this address only", and the installer's certificates carry
  `CA:TRUE`. So a CA-only host is checked against the platform roots ALONE
  whenever an anchor is pinned - which `rcq islands` asks for explicitly
  before it reads the catalogue off `rcq.app`, because that verb runs outside
  the gate and the catalogue is what `--island <n>` resolves against. An
  island that moves to a CA has its anchor removed the moment the `ca` record
  is written. What is not narrowed: any other connection a trust-free verb
  makes. A pin is a statement about an operator you have decided to trust.
  The phones and the desktop compare the leaf per host and have no such
  widening.
* A certificate Node would refuse as an anchor anyway (expired, or a SAN that
  does not name the address) is not pinned here even where the rule would
  accept it, because a pin the CLI cannot use is worse than none; the error
  names which it was. The installer's certificates satisfy both; a hand-made
  one without the SAN works on the phones and the desktop and not here.
* ⚠ Behind `rcq proxy`, an island addressed by an IP LITERAL cannot be
  fetched on Node 26 at all, pinned or not: Node's own proxy path hands the
  IP to TLS as the server name and Node 26 refuses that
  (`ERR_INVALID_ARG_VALUE … Setting the TLS ServerName to an IP address`;
  verified 2026-09-02 against a self-signed island on `127.0.0.1:8443`, the
  same request to `localhost:8443` goes through). The trust probe is not the
  problem, it speaks the proxy protocol itself and does not set SNI for an
  IP; the command's own request is. Give such an island a name, or do not
  proxy it, until Node fixes its side.

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
* `proxy.json`: the proxy address, written by `rcq proxy set`. Per state dir,
  so a throwaway `RCQ_CLI_HOME` has its own. It can carry a password, which is
  why nothing ever prints it unredacted.
* `routes.json`: which road answered last and when, the whole last walk of the
  ladder (so `rcq routes` can show it while a `rcq watch` is running in
  another terminal), and the pinned onion entry for the sing-box config.
* `relay-config.json`: the last Ed25519-verified relay payload, verbatim. It
  is re-verified on every read, so a hand-edited copy is simply ignored.
* `island-pins.json`: how each island met is trusted, keyed `host:port`
  (`{mode: "ca"}` or `{mode: "pinned", fp, source: tofu|typed|accepted}`), and
  `island-certs/<host>_<port>.pem` beside it for every pinned one, plus the
  `bundle.pem` NODE_EXTRA_CA_CERTS points at. Per state dir on purpose: a
  throwaway home must not carry its decisions into your own. Never sealed: a
  pin is a statement about an island, not a secret, and Node reads the bundle
  before any of our code runs.

Local stores inside `localstorage.json` are keyed per account
(`setAccountScope`, called from `cli/src/directory.ts`): the roster
snapshot under `rcq.web.<uin>.contacts.snapshot`, learned names under
`rcq.cli.names.<uin>`, and the fingerprint of the contact list last mirrored
into the vault under `rcq.cli.vaultmirror.<uin>`. Cross-island rooms add two
more of the web's own scoped stores, `visited.v1` (which islands this
identity guest-registered on: host, per-island uin, when - the jwt field is
always written empty) and `fgroup-alias.v1` (the host+remote-id behind each
negative alias). Both therefore live inside `localstorage.json` and are
sealed by `rcq lock` with everything else; guest TOKENS are memory-only and
re-minted via the recover handshake, so no credential for another island
ever rests on disk.

**The vault mirror.** Every contact list the island answers with is folded
into the account's encrypted `contacts` slot (stage 4 of
`RCQ/docs/core-metadata-plan.md`; the same `mirrorContactsToVault` the web
calls). In this phase the server list is still the truth and the slot is a
sealed copy; the point of shipping it now is that the day the island stops
answering `/contacts`, a reinstall recovers its roster from the slot and from
nowhere else, and a client that has been mirroring all along already has one.
The fingerprint above is why it costs nothing on a repeat: a browser tab keeps
that memory in RAM, a CLI process lives for one command, so it goes on disk.
Bounded at 6 seconds - a `rcq contacts` that printed its rows and then sat
there waiting on bookkeeping would be a worse client for a better copy.

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
* **Cross-island 1:1 send.** Cross-island GROUPS work now (see "Rooms on
  other islands"), but 1:1 across islands is still half there: messages DO
  arrive, and are labelled `#500@host` so they cannot be confused with a
  local uin, but there is no way to answer one: `/to` takes no host, and
  `federation-send.ts` is importable and unwired. Delivered receipts are
  deliberately NOT sent to a cross-island sender for the same reason (the
  receipt would address whoever holds that number on OUR island).
  Cross-island contact requests (`contactreq`) and profile refreshes are
  dropped.
* **Reactions, edits, deletes, replies.** All of them are dropped as
  unsupported envelope kinds. The delete is the one that matters: a message
  retracted on the sender's phone stays readable in `history-<uin>.jsonl`
  here, and the sender has no way to know.
* **Read receipts.** Only `delivered` goes out, so a peer's tick never turns.
  Incoming read receipts print to stderr under `RCQ_VERBOSE` only, and are
  not told apart from delivered ones.
* **Circumvention.** Three rungs now: direct, the CDN front, and a proxy you
  run yourself (see "Roads to the island" above). What is still missing is an
  EMBEDDED obfuscated transport. The relays are reachable only through a
  sing-box you install; `rcq routes --singbox` writes its config and picks the
  onion entry, but nothing dials VLESS+Reality or Hysteria2 in this process,
  and nothing here builds an onion circuit. A blocked user with no sing-box
  and no proxy has the front and nothing after it.
* **Broker relays.** `rcq routes --singbox --bridges` asks the island's broker
  for a few community relays and writes them into the config as a
  fallback-only group. It never registers a relay, never shares one into a
  chat, and never imports one somebody pasted: the in-chat relay-share card
  the phones render has no counterpart here.
* **Account and device management.** No `devices`, no slot revoke, no
  unlink, no burn, no report channel, no `rcq link` (a second box still takes
  the 24-word phrase on a command line). `account_burned` off the socket is
  ignored.
* **Group administration.** Creating, renaming, deleting a room, moving
  members and setting its rules all belong where you can see the roster; the
  CLI reads rooms, posts to them, and joins an OPEN one by id, an invite
  link, or `<gid>@<host>` for a room on another island (§5c). A closed
  room's share token (`?k=`) is still not parsed - a closed room refuses
  from here, on any island.
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
