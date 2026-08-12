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

macOS is built for **both** architectures at once and shipped as a single
universal dmg — an Intel Mac that can run macOS 14 is a supported Mac, and
through 0.2.3 it had nothing to download at all:

```bash
npm run desktop:build -- --target universal-apple-darwin
```

That triple needs `rustup target add x86_64-apple-darwin` alongside the
aarch64 one, and a `sing-box-universal-apple-darwin` sidecar —
`scripts/build-singbox-sidecar.sh` builds both Mac architectures and `lipo`s
them into it. Tauri looks a sidecar up by the exact triple it is building, so
the per-arch pair on its own is not enough.

Output of a release build:

```
src-tauri/target/universal-apple-darwin/release/bundle/macos/RCQ.app
src-tauri/target/universal-apple-darwin/release/bundle/dmg/RCQ_<version>_universal.dmg
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
  layout), centered. Those are the *first launch*; after that the size,
  position, maximized and fullscreen state come back from
  `.window-state.json` in the app config dir (`tauri-plugin-window-state`,
  third file there alongside `bypass.json` and `broker.json`). Visibility is
  deliberately NOT remembered — the close button hides to the tray, so the
  saved value would nearly always be `false` and the next launch would come up
  with no window. The plugin only writes on `RunEvent::Exit`, which this app
  frequently never reaches, so `lib.rs` also saves on close-to-tray and 800 ms
  after the window stops moving.

## v1 scope (this build)

Everything web-chat already does: 1:1, groups, media, contacts, IndexedDB
persistence, realtime WebSocket. Crypto is the in-browser libsignal v=2
path, same as chat.rcq.app.

Plus desktop chrome (stage 2): **tray icon** (RCQ flower, Open/Quit menu,
left-click reopens), **run in background** (closing the window hides it to
the tray; real quit is Cmd+Q or the tray's Quit), **single instance**,
**OS notifications** (when the window isn't focused), **dock unread badge**,
and **auto-update**.

**Calls** (0.2.0): 1:1 voice and video over WebRTC, speaking the same
signalling as the phones, so a desktop call reaches an iOS or Android peer and
back. Video can be turned on mid-call, and a broken path is recovered with an
ICE restart rather than a re-ring. The engine is `src/lib/call.tsx`; the wire
and the per-OS capture permissions are documented in the file header and in
"Microphone and camera" below.

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

## Microphone and camera (calls)

Each of the three webviews withholds capture for a different reason, and none
of them says so out loud — a call just goes silent.

- **macOS.** wry answers the WKUIDelegate capture request with `Grant`, so the
  page is not the obstacle: the OS is. Two things are needed and both are in
  this repo. `Info.plist` carries `NSMicrophoneUsageDescription` and
  `NSCameraUsageDescription` — an app that touches a capture device without one
  is **terminated** by the system, not refused. And because the build signs
  with the hardened runtime, `Entitlements.plist` grants
  `com.apple.security.device.audio-input` and `.camera`; without them the
  capture is refused underneath the webview no matter what the user answered in
  the dialog. Check a build with
  `codesign -d --entitlements - RCQ.app`.
- **Linux.** WebKitGTK ships with the media stream switched **off**, so
  `navigator.mediaDevices` does not exist at all, and it denies every
  permission request nobody handles. Neither wry nor Tauri turns either on.
  `src-tauri/src/lib.rs` does, through the webview handle Tauri hands us
  (`with_webview` → `webkit2gtk::WebView`): `set_enable_media_stream`,
  `set_enable_webrtc`, and a `permission-request` handler that allows
  `UserMediaPermissionRequest` and nothing else. The `webkit2gtk` dependency is
  pinned to the exact version wry resolves so there is one copy of the crate.
  ⚠ This code only compiles in CI; to read the crate API from a Mac use
  `cargo fetch --target x86_64-unknown-linux-gnu`.
- **Windows.** WebView2 shows its own permission prompt. Nothing to do.

Secure context is not a problem on either: wry registers the custom scheme as
secure on Linux, and on macOS the app already relies on `crypto.subtle`.

Connection diagnostics has a **Microphone** row that opens the device for real
(not a permission query, which would pass on macOS right up until the hardened
runtime refuses the capture) and a **Call relay** row with the number of TURN
servers the island handed out.

## Auto-update (publishing a release)

The app checks `plugins.updater.endpoints` once per launch; if a newer signed
build is published it prompts, downloads, installs, and relaunches.

- **Update signing key:** `~/.rcq/desktop-updater/rcq-desktop.key` (private —
  BACK IT UP; losing it breaks updates) + `.key.pub`. The public key is pinned
  in `tauri.conf.json` `plugins.updater.pubkey`.
- **Endpoint:** `https://rcq.app/desktop/latest.json`, served straight off the
  droplet from `/var/www/rcq/desktop/` (`rcq.app` is DNS-only in Cloudflare and
  Caddy sends `cache-control: no-cache`, so there is no CDN copy to bust).
  `deploy/deploy-web.sh` excludes `desktop/`, so a landing deploy won't wipe it.

To cut a release:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.rcq/desktop-updater/rcq-desktop.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run desktop:build -- --target universal-apple-darwin
# produces target/universal-apple-darwin/release/bundle/macos/RCQ.app.tar.gz + .sig
```

CI (`.github/workflows/release.yml`) builds Windows and Linux with
`tauri.conf.ci.json`, which sets `createUpdaterArtifacts: false` and gets no
signing key — so **its installers carry no `.sig` and no updater archives**.
The updater half is done locally instead, in one pass:

```bash
gh release download v0.1.4 --repo rcq-messenger/rcq-desktop --dir dl
scripts/publish-desktop-update.py --version 0.1.4 --assets dl \
  --notes-file notes.txt          # add --no-upload to inspect first
```

It packs, signs, verifies every signature against the pinned public key,
uploads with `.bak-<prev>` backups, writes `latest.json`, then re-downloads
each url over HTTPS and verifies again the way a client would. macOS comes
from the local Developer-ID-signed build, not from the release.

**The signing key deliberately stays off CI.** The repo is public and this key
is remote code execution on every install, with no way to rotate it for
binaries already in the wild; desktop releases are rare and macOS is built
locally anyway, so the trade isn't close.

Two things the script encodes that are easy to get wrong by hand. The plugin
looks up `{os}-{arch}-{installer}` first and falls back to `{os}-{arch}`, so
each format needs its own key plus a base key for binaries whose bundle type
wasn't detected — and the Linux base key must be the AppImage, because an
undetected Linux binary takes the AppImage install path and no other. And the
AppImage archive must not be built by macOS `tar`: bsdtar prepends a pax header
entry named `PaxHeader/<name>.AppImage`, and the updater picks its payload by
the `.AppImage` extension.

```json
{
  "version": "0.2.0",
  "notes": "What changed",
  "pub_date": "2026-06-16T00:00:00Z",
  "platforms": {
    "darwin-aarch64":        { "signature": "<RCQ.app.tar.gz.sig>",            "url": "https://rcq.app/desktop/RCQ.app.tar.gz" },
    "darwin-x86_64":         { "signature": "<RCQ.app.tar.gz.sig>",            "url": "https://rcq.app/desktop/RCQ.app.tar.gz" },
    "windows-x86_64-nsis":   { "signature": "<RCQ-windows-setup.exe.sig>",     "url": "https://rcq.app/desktop/RCQ-windows-setup.exe" },
    "windows-x86_64-msi":    { "signature": "<RCQ-windows.msi.sig>",           "url": "https://rcq.app/desktop/RCQ-windows.msi" },
    "windows-x86_64":        { "signature": "<RCQ-windows-setup.exe.sig>",     "url": "https://rcq.app/desktop/RCQ-windows-setup.exe" },
    "linux-x86_64-appimage": { "signature": "<RCQ-linux.AppImage.tar.gz.sig>", "url": "https://rcq.app/desktop/RCQ-linux.AppImage.tar.gz" },
    "linux-x86_64-deb":      { "signature": "<RCQ-linux.deb.sig>",             "url": "https://rcq.app/desktop/RCQ-linux.deb" },
    "linux-x86_64-rpm":      { "signature": "<RCQ-linux.rpm.sig>",             "url": "https://rcq.app/desktop/RCQ-linux.rpm" },
    "linux-x86_64":          { "signature": "<RCQ-linux.AppImage.tar.gz.sig>", "url": "https://rcq.app/desktop/RCQ-linux.AppImage.tar.gz" }
  }
}
```

Bump `version` in `tauri.conf.json`, `Cargo.toml`, `Cargo.lock` and
`package.json` for each release. The config version is the one the running app
reports, so a stale `Cargo.toml` won't cause an update loop — but keep them
together anyway. In `Cargo.lock` the package is named `app`, not `rcq-desktop`.

⚠ **There is a fifth place, and it is in a different repository.**
`RCQ/web/src/components/Downloads.tsx` holds `DESKTOP_VERSION`, which prints
on the download tiles AND is the `?v=` cache-buster on the three download
URLs. Desktop filenames are stable across releases, so an unchanged query lets
Cloudflare keep serving the previous build from its edge for hours after a
publish. Bumping the four files here and forgetting that one ships a release
whose own website advertises the version before it — this happened on 0.2.5,
which went out ten minutes after the site had already been deployed. Bump it,
rebuild `RCQ/web`, and deploy the site AFTER the release is published.

⚠ CI (`.github/workflows/release.yml`) builds macOS on `aarch64-apple-darwin`
only, so every tag push also uploads an arm64-only `RCQ_<v>_aarch64.dmg` and
`RCQ_aarch64.app.tar.gz` with an ad-hoc signature. The publish script ignores
them, but delete them from the release and upload the local
`RCQ_<v>_universal.dmg` instead, or Intel users download a build that cannot
run for them.

⚠ Do **not** point a locally downgraded dev build at the live manifest to test
the updater. `tauri dev` runs a bare binary, so the macOS installer resolves
its install path to `src-tauri/target/debug/` and replaces that whole directory
with the downloaded app. Use a local manifest and a local file URL instead.

## Getting through blocks

A sing-box built from pinned upstream ships as a Tauri sidecar. With the
setting on, it starts before the window is built, listens on a loopback SOCKS
port, and the webview is created with `proxy_url` pointing at it — so every
request the page makes leaves through a relay. Verified on a release build:
the webview's network process held only loopback sockets to that port and no
direct connection at all, while sing-box raced three relays over UDP/443.

The relay list is the same signed payload the phones use (`src/relay.rs`):
GitHub raw, then Cloudflare, Ed25519-verified over the canonical JSON of
everything but `sig`, cached, with a bundled copy for a first launch that can
reach neither mirror. It refreshes in the background through the tunnel when
one is up, because a censored user cannot reach either mirror any other way.

The sing-box config carries **no `direct` outbound** on purpose: if every
relay is unreachable the tunnel must fail loudly rather than quietly carry the
user's traffic in the clear.

```bash
scripts/build-singbox-sidecar.sh          # host platform (CI does this per runner)
scripts/build-singbox-sidecar.sh --all    # all three; Go cross-compiles
```

The binaries are gitignored — three platforms is ~80 MB and it would have to be
re-committed on every bump. Bump `SING_BOX_REV` in the script deliberately.

Two things worth knowing:

- **The proxy can only be attached while the webview is being built**, wry has
  no runtime API for it. So the on/off flag lives in Rust (`bypass.json` in the
  app config dir) rather than in the page, which does not exist yet at the
  moment we have to decide — and flipping it restarts the app.
- **macOS is off by default** (`mac-bypass` Cargo feature). wry reaches the
  macOS proxy through `nw_proxy_config_create_socksv5`, introduced in macOS 14
  and linked non-weakly — `nm -m` shows it as a plain undefined external, so a
  build with the feature on refuses to launch on macOS 13 even for someone who
  never turns the bypass on, and the updater would hand them that build. Turn
  it on to develop against (`npx tauri build --features mac-bypass`) or
  fleet-wide once the macOS floor moves to 14. Without it the setting reports
  itself unsupported instead of silently doing nothing.

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
2. **Windows code signing** (avoid the SmartScreen warning).
3. **Circumvention on macOS**: decide whether the macOS floor moves to 14 (see
   above). We ship arm64 only and every Apple Silicon Mac can run 14, so the
   cost is small — but pre-14 users would be handed a build that cannot launch,
   and the manifest has no way to hold them back.
4. Onion (2-hop) and the user's-own-proxy mode, both of which the phone clients
   already have and the desktop core does not.
