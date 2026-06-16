# RCQ Desktop + Web client

The RCQ chat client that runs on the desktop (macOS / Linux / Windows via
[Tauri](https://v2.tauri.app/)) and in the browser (chat.rcq.app). One
React/Vite/TypeScript frontend; the desktop shell lives in `src-tauri/`.

It talks to the same RCQ islands as the iOS and Android apps — no backend
changes. Crypto is in-browser libsignal v2 (Double Ratchet, PQXDH).

## Develop

```bash
npm install
npm run dev            # web (Vite dev server)
npm run desktop:dev    # desktop (native window + HMR)
```

## Build the desktop app

```bash
npm run desktop:build  # produces .app + .dmg (macOS), .AppImage + .deb (Linux)
```

See **[DESKTOP.md](DESKTOP.md)** for the full desktop story: code signing
(required for notifications), auto-update, and how to cut a release.

CI (`.github/workflows/release.yml`) builds macOS + Linux on a `v*` tag or a
manual run.

## Scope

Messaging, groups, media, contacts, realtime — everything the web client does,
plus desktop chrome (tray, background run, OS notifications, dock badge,
auto-update). **No voice/video calls yet** (the web client has no WebRTC).
