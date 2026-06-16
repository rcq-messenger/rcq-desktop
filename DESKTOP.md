# RCQ Desktop (Tauri)

The desktop client is the existing **web-chat** React app wrapped in a
[Tauri v2](https://v2.tauri.app/) shell. One frontend codebase ships to
macOS, Linux and Windows. The backend, islands, federation and crypto are
unchanged — the desktop app talks to the same islands as iOS/Android/web.

## Layout

```
web-chat/
  src/            # the React app (shared with chat.rcq.app)
  dist/           # vite build output (also what the web deploy rsyncs)
  src-tauri/      # the Tauri shell (Rust) — desktop only, NOT deployed to web
    tauri.conf.json
    Cargo.toml
    src/          # lib.rs / main.rs (entry point)
    icons/        # app icons generated from the RCQ flower
    capabilities/ # permission set for the webview
```

`src-tauri/` only matters for desktop builds. The web deploy
(`rsync -az dist/ root@…:/var/www/chat/`) copies `dist/` only, so the
desktop shell never reaches the web server.

## Prerequisites

- Node + npm (already used for web-chat)
- Rust toolchain (`rustup`, `cargo`) — `rustc 1.95` confirmed working
- macOS: Xcode Command Line Tools (for `cc`/linker + bundling)

## Commands

Run from `web-chat/`:

```bash
npm run desktop:dev     # tauri dev — Vite dev server + native window, hot reload
npm run desktop:build   # tauri build — produces RCQ.app + .dmg (release)
```

`tauri dev` loads `http://localhost:5174` (the Vite dev server). The
release build runs `npm run build` first and bundles `dist/`.

Output of a release build (Apple Silicon):

```
src-tauri/target/release/bundle/macos/RCQ.app
src-tauri/target/release/bundle/dmg/RCQ_<version>_aarch64.dmg
```

## Configuration notes

- **Identifier:** `app.rcq.desktop` (`tauri.conf.json`).
- **CSP** (`app.security.csp`): `script-src` is locked to
  `'self' 'wasm-unsafe-eval'` (the `'wasm-unsafe-eval'` is required for the
  bundled libsignal WASM). **`connect-src` is deliberately broad**
  (`https: http: wss: ws:`) because RCQ users connect to *arbitrary*
  islands — custom servers, self-hosted islands, onion domains — so a fixed
  allowlist would break custom islands. CSP is only enforced in the
  **release** build (in `tauri dev` the content is served by Vite, which
  sends no CSP).
- **Window:** 1100×760 default, min 380×560 (matches the narrow mobile
  layout), centered.

## v1 scope (this build)

Everything web-chat already does: 1:1, groups, media, contacts, IndexedDB
persistence, realtime WebSocket. Crypto is the in-browser libsignal v=2
path, same as chat.rcq.app.

Plus desktop chrome (stage 2): **tray icon** (RCQ flower, Open/Quit menu,
left-click reopens), **run in background** (closing the window hides it to
the tray; real quit is Cmd+Q or the tray's Quit), **single instance**,
**OS notifications** (when the window isn't focused), **dock unread badge**,
and **auto-update**.

**No calls.** web-chat has no WebRTC, so cross-island calls are
iOS/Android-only for now. Desktop calls are a v2 item (add WebRTC to the
web client first).

## Code signing (required — notifications depend on it)

macOS only registers an app with the notification system (so banners show
and the app appears in System Settings → Notifications) if the app is signed
with a **real identity** (a Team ID). An ad-hoc / linker signature — what an
unconfigured `tauri build` produces — is NOT enough: the badge works but
notifications never register.

So `tauri.conf.json` sets `bundle.macOS.signingIdentity` to the
**Developer ID Application** cert. The build signs with it automatically (the
cert lives in this Mac's keychain). Verify a build with:

```bash
codesign -dvvv src-tauri/target/release/bundle/macos/RCQ.app   # TeamIdentifier set
```

For distribution to other Macs the app also needs **notarization**
(`xcrun notarytool submit` + `stapler`) — not done yet. The end user still
picks Banners vs Notification-Center in System Settings → Notifications → RCQ.

## Auto-update (publishing a release)

The app checks `plugins.updater.endpoints` once per launch; if a newer signed
build is published it prompts, downloads, installs, and relaunches.

- **Update signing key:** `~/.rcq/desktop-updater/rcq-desktop.key` (private —
  BACK IT UP; losing it breaks updates) + `.key.pub`. The public key is pinned
  in `tauri.conf.json` `plugins.updater.pubkey`.
- **Endpoint:** `https://rcq.app/desktop/latest.json` — the founder hosts a
  static manifest + the signed `.app.tar.gz` there (mirror the Android updater
  on the droplet). NOT live until that's set up.

To cut a release:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.rcq/desktop-updater/rcq-desktop.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run desktop:build
# produces target/release/bundle/macos/RCQ.app.tar.gz + .sig
```

Then upload `RCQ.app.tar.gz` to `https://rcq.app/desktop/` and write
`latest.json`:

```json
{
  "version": "0.2.0",
  "notes": "What changed",
  "pub_date": "2026-06-16T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of RCQ.app.tar.gz.sig>",
      "url": "https://rcq.app/desktop/RCQ.app.tar.gz"
    }
  }
}
```

(Bump `version` in `tauri.conf.json` for each release.)

## Status / follow-ups

Done:
- ✅ Desktop chrome: native notifications, tray icon, run-in-background, dock
  badge, auto-update (stage 2).
- ✅ macOS, Linux, and Windows packaging — CI builds all three (`tauri build`
  per OS on GitHub runners).

Remaining:
1. **Notarization** (macOS) so the build runs on other Macs without a
   Gatekeeper warning — we have an Apple Developer account. Until then,
   right-click → Open.
2. **Windows code signing** (avoid the SmartScreen warning) and a host for the
   auto-update manifest.
3. Embedded `sing-box` in the Rust shell for desktop circumvention (mirrors the
   iOS/Android transport).
