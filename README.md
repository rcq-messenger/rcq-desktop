# RCQ Desktop + Web client

The RCQ chat client, in both the forms it ships in: a **browser app** (the
source of chat.rcq.app) and a **desktop app** for macOS, Linux and Windows
built on [Tauri](https://v2.tauri.app/). One React/Vite/TypeScript frontend;
the desktop shell is the `src-tauri/` directory and nothing else.

> The repository is named for the desktop, but the browser client lives here
> too and this is its only home. If you are looking for `rcq-web`, it was a
> mirror of this source and is now archived — a copy that has to be refreshed
> by hand is a copy that falls behind, and it did.

It talks to the same RCQ islands as the iOS and Android apps, with no backend
changes. Crypto is in-browser libsignal v2 (Double Ratchet, PQXDH).

## Run it against your own island

The only thing you need to configure is which server the build talks to:

```sh
cp .env.example .env.local     # then edit VITE_API_BASE
npm install
npm run build                  # → dist/
```

Serve `dist/` from any static web server (nginx, Caddy, Cloudflare Pages, …).
There is no server-side runtime: it is a static SPA that talks to your
[`rcq-server-ref`](https://github.com/rcq-messenger/rcq-server-ref) island over
HTTPS and WSS. Unset, the build points at `https://api.rcq.app`.

What it is not: there is no admin panel here (that is built into the server at
`/admin/console`), and the UIN market is an rcq.app-only commercial surface
that is not part of a self-hosted build.

## Accounts

The client can **create an account of its own** — no phone involved. It can
also adopt an existing account, either by entering that account's 24-word
recovery phrase or by scanning the QR from a phone (Settings → *Connect to
web*), in which case it shares the identity with the phone.

> ⚠️ Sharing one identity across a phone and a browser is supported but is not
> what the v=2 ratchet is happiest with under heavy simultaneous use; linked
> devices fall back to v=1 for reliability. An account of its own has no such
> caveat.

## Develop

```bash
npm install
npm run dev            # web (Vite dev server)
npm run desktop:dev    # desktop (native window + HMR)
```

## Build the desktop app

`npm run desktop:build` builds installers for the **host OS** you run it on:

| OS | Artifacts |
|----|-----------|
| macOS | `.app` + `.dmg` |
| Linux | `.AppImage` + `.deb` + `.rpm` |
| Windows | `.msi` + `.exe` (NSIS) |

See **[DESKTOP.md](DESKTOP.md)** for the full desktop story: code signing
(required for notifications), the microphone and camera permissions each OS
withholds differently, auto-update, and how to cut a release.

CI (`.github/workflows/release.yml`) builds **macOS, Linux, and Windows**
together on a `v*` tag or a manual run, and attaches the installers to a draft
GitHub release.

## Scope

Messaging, groups, media, contacts, realtime — everything the browser client
does, plus desktop chrome (tray, background run, OS notifications, dock badge,
auto-update), plus **voice and video calls** (0.2.0), which interoperate with
the iOS and Android clients.

## License

[AGPL-3.0](LICENSE) — the same license as the rest of RCQ (iOS, Android, web,
and the server reference).
