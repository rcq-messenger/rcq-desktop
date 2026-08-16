// Desktop (Tauri) integration helpers.
//
// web-chat ships to BOTH a normal browser (chat.rcq.app) and the Tauri desktop
// shell. Every Tauri API here is lazy-imported so the plain web build never
// loads desktop-only code, and every export no-ops in a browser. Detection:
// Tauri v2 injects `__TAURI_INTERNALS__` on window.

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/// The `t()` from the i18n context. Passed in rather than imported so this
/// module stays free of React — the update dialog is native, not our own UI,
/// so its strings have to come from the caller.
export type Translate = (key: string, params?: Record<string, string | number>) => string

// Resolve the OS notification permission once (the first request shows the
// system prompt on macOS). Cached so we don't re-ask per message.
let permission: Promise<boolean> | null = null
async function ensurePermission(): Promise<boolean> {
  if (!permission) {
    permission = (async () => {
      const n = await import('@tauri-apps/plugin-notification')
      let granted = await n.isPermissionGranted()
      if (!granted) granted = (await n.requestPermission()) === 'granted'
      return granted
    })().catch(() => false)
  }
  return permission
}

/// Fire an OS notification. No-op off desktop or without permission.
export async function notifyDesktop(title: string, body: string): Promise<void> {
  if (!isTauri()) return
  try {
    if (!(await ensurePermission())) return
    const n = await import('@tauri-apps/plugin-notification')
    n.sendNotification({ title, body })
  } catch {
    /* notification plugin unavailable — ignore */
  }
}

/// Set the app (dock / taskbar) badge to the unread count; 0 clears it.
/// App-wide, not per-window. No-op off desktop.
export async function setDesktopBadge(count: number): Promise<void> {
  if (!isTauri()) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined)
  } catch {
    /* window API unavailable — ignore */
  }
}

/// Bring the app forward — used when a call comes in. Closing the window hides
/// it to the tray rather than quitting, so without this an incoming call would
/// ring from an app the user cannot see, with nothing to answer it on. No-op
/// off desktop, where the browser tab is wherever the user left it.
export async function raiseDesktopWindow(): Promise<void> {
  if (!isTauri()) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    await win.show()
    await win.unminimize()
    await win.setFocus()
  } catch {
    /* window API unavailable — ignore */
  }
}

/// State of the bundled circumvention core, as the Rust side sees it.
export interface BypassStatus {
  /// Whether this build can route the webview through a proxy at all. False on
  /// a macOS build without the `mac-bypass` feature, where the setting would
  /// look like it worked and quietly do nothing.
  supported: boolean
  /// What the user asked for. Survives a restart.
  enabled: boolean
  /// Whether the core is actually up in this session. Differs from `enabled`
  /// between flipping the toggle and restarting, and when the core failed.
  running: boolean
  /// Whether this session tried to bring the core up. With `running` false
  /// that means it failed; without it, the user has just not restarted yet.
  tried_at_startup: boolean
  relay_config_version: number | null
  relay_count: number
  /** Bare hostname of the CF front, when the signed list names one. The page
   *  owns the front rather than Rust, because it is the one circumvention
   *  layer that can be applied to a window already open. */
  relay_front: string | null
  /** The tunnel came up because the island was unreachable, not because the
   *  user asked. The UI says so rather than looking like it flipped itself. */
  auto: boolean
  /** The island stopped answering while the app was running and the tunnel was
   *  raised for it — but a webview's proxy is fixed when the webview is built,
   *  so nothing actually changes until relaunch. Say so: a tunnel the page is
   *  not using looks exactly like an app that is simply broken. */
  needs_relaunch: boolean
}

/** A relay the user pasted by hand. Unsigned by nature — the whole point is
 *  that it travels out of band, over any channel that still works. */
export interface UserRelay {
  tag: string
  proto: string
  server: string
  port: number
  sni: string
}

export async function userRelays(): Promise<UserRelay[]> {
  if (!isTauri()) return []
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<UserRelay[]>('user_relays')
  } catch {
    return []
  }
}

/** Add from an `rcq-relay://` token. Rejects anything that would build an
 *  outbound sing-box cannot dial, so the error surfaces at paste time rather
 *  than as a tunnel that silently carries nothing. */
export async function addUserRelay(token: string): Promise<{ ok: boolean; error?: string }> {
  if (!isTauri()) return { ok: false }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('user_relay_add', { token })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export async function removeUserRelay(tag: string): Promise<boolean> {
  if (!isTauri()) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('user_relay_remove', { tag })
    return true
  } catch {
    return false
  }
}

export async function bypassStatus(): Promise<BypassStatus | null> {
  if (!isTauri()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<BypassStatus>('bypass_status')
  } catch {
    return null
  }
}

/// Record the choice. It only takes effect on the next launch: the webview
/// proxy is fixed when the webview is built, so there is nothing to flip live.
export async function setBypassEnabled(enabled: boolean): Promise<boolean> {
  if (!isTauri()) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('bypass_set', { enabled })
    return true
  } catch {
    return false
  }
}

/// What the diagnostics screen reports, mirroring the phones'. The two probes
/// together say whether the network is blocking us and whether the relay is
/// doing its job.
export interface NetworkDiagnostics {
  tunnel: boolean
  direct_ok: boolean
  route_ok: boolean
  relay_count: number
  relay_config_version: number | null
}

/// `host` is a bare hostname, not a URL. Takes seconds on a censored network:
/// each probe waits the timeout out three times before calling it blocked.
export async function networkDiagnostics(host: string): Promise<NetworkDiagnostics | null> {
  if (!isTauri()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<NetworkDiagnostics>('network_diagnostics', { host })
  } catch {
    return null
  }
}

/// 'macos' | 'windows' | 'linux', or null in a browser. Used so the app names
/// itself correctly rather than calling itself the web client.
export async function desktopPlatform(): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<string>('desktop_platform')
  } catch {
    return null
  }
}

export async function relaunchApp(): Promise<void> {
  if (!isTauri()) return
  try {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch {
    /* nothing sensible to do — the user can restart it themselves */
  }
}

/// The installed app version, e.g. `0.1.3`. Null in a browser.
export async function appVersion(): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch {
    return null
  }
}

/// Take the bundled sing-box down before an installer runs.
///
/// ⚠ Windows refuses to overwrite a running executable, so the update failed
/// for everyone with the bypass on: the installer could not replace
/// `sing-box.exe` while our child process held it. Reported 2026-08-16, with
/// "приходится вручную качать и перезагружать ПК" as the workaround people
/// had found.
///
/// The SETTING is untouched — the tunnel is back on the next launch. Failure
/// is ignored on purpose: an update that might work is better than one this
/// helper refuses to start. The short wait gives the OS time to release the
/// handle, which is not instant on Windows.
async function haltBypassForInstall(): Promise<void> {
  if (!isTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('bypass_halt')
    await new Promise((r) => setTimeout(r, 600))
  } catch {
    /* older shell without the command, or nothing running */
  }
}

// Ask about a pending update and, on yes, download, install, and relaunch.
// Returns when the user declines; on accept the process is replaced.
async function promptAndInstall(
  update: { version: string; downloadAndInstall: () => Promise<void> },
  t: Translate,
): Promise<void> {
  const { ask } = await import('@tauri-apps/plugin-dialog')
  const go = await ask(t('desktop.update.body', { version: update.version }), {
    title: t('desktop.update.title'),
    kind: 'info',
    okLabel: t('desktop.update.install'),
    cancelLabel: t('desktop.update.later'),
  })
  if (!go) return
  await haltBypassForInstall()
  await update.downloadAndInstall()
  const { relaunch } = await import('@tauri-apps/plugin-process')
  await relaunch()
}

// ── pending update, as a fact the UI can watch ──────────────────────────
//
// The app used to learn about a release exactly twice: once at launch, and
// whenever somebody thought to press the button in Settings. A window left
// open for a week never heard about anything (it hides to the tray rather than
// quitting), which is the whole of the founder's request: "показывать
// обновление в момент её появления, а не только при входе".
//
// So: a poll that only ever lights a badge, and one dialog per launch at most.
// A modal that appears by itself while you are typing is the thing nobody
// wants, and on desktop it is an OS window that the app cannot draw over —
// including over a ringing call.
export interface PendingUpdate {
  version: string
}

let pendingUpdate: PendingUpdate | null = null
let lastCheckAt = 0
const updateListeners = new Set<() => void>()

/// Poll no more often than this, whoever asks. The manual button bypasses it.
///
/// Was 30 minutes against a six-hour interval, which meant a release published
/// while the app was open could go unnoticed for most of a working day: the
/// launch check had already spent the window, the focus tick kept being turned
/// away by the floor, and the next interval was hours out. Ten minutes costs
/// one small request and makes "I shipped it and the badge did not appear"
/// a matter of minutes.
const MIN_CHECK_GAP_MS = 10 * 60 * 1000

export function subscribeUpdate(cb: () => void): () => void {
  updateListeners.add(cb)
  return () => updateListeners.delete(cb)
}

export function getPendingUpdate(): PendingUpdate | null {
  return pendingUpdate
}

function announceUpdate(next: PendingUpdate | null) {
  const changed = (pendingUpdate?.version ?? null) !== (next?.version ?? null)
  pendingUpdate = next
  if (changed) updateListeners.forEach((cb) => cb())
}

/// Ask the endpoint, remember what it said, and tell nobody loudly.
///
/// ⚠ The `Update` handle is a Rust-side resource with an rid; it is closed
/// immediately rather than parked across a six-hour interval. The install path
/// re-checks and gets a fresh one.
export async function pollForUpdates(force = false): Promise<void> {
  if (!isTauri()) return
  const now = Date.now()
  if (!force && now - lastCheckAt < MIN_CHECK_GAP_MS) return
  lastCheckAt = now
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      announceUpdate(null)
      return
    }
    const version = update.version
    await update.close().catch(() => {})
    announceUpdate({ version })
  } catch {
    /* endpoint unreachable — say nothing, try again on the next tick */
  }
}

/// Download the pending update and restart into it. Used by the badge.
export async function installPendingUpdate(): Promise<UpdateCheck> {
  if (!isTauri()) return { kind: 'unsupported' }
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      announceUpdate(null)
      return { kind: 'current' }
    }
    await haltBypassForInstall()
    await update.downloadAndInstall()
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
    return { kind: 'found' }
  } catch (e) {
    console.error('[updater] install failed', e)
    return { kind: 'install_failed', reason: reasonOf(e) }
  }
}

// Check the update endpoint once per launch; if a newer signed build is
// published, ask the user and (on yes) download, install, and relaunch.
// No-op off desktop / when the endpoint is unreachable.
let updateChecked = false
export async function checkForUpdatesOnLaunch(t: Translate, quiet = false): Promise<void> {
  if (!isTauri() || updateChecked) return
  updateChecked = true
  lastCheckAt = Date.now()
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      announceUpdate(null)
      return
    }
    announceUpdate({ version: update.version })
    // `quiet` is the ringing phone: `ask()` is an OS-modal window, so it lands
    // OVER the call screen and takes the Answer button with it. The badge has
    // already been lit, so nothing is lost by staying silent — Android learned
    // this the same way, in #478.
    if (quiet) {
      await update.close().catch(() => {})
      return
    }
    await promptAndInstall(update, t)
  } catch {
    /* no update / endpoint unreachable / not yet hosted — ignore */
  }
}

/// What a manual check found, so the caller can say so in the UI. The launch
/// check stays silent instead, because nobody asked it a question.
///
/// ⚠ `install_failed` exists because it used to be indistinguishable from
/// `failed`: one try/catch wrapped BOTH the check and the download-and-install,
/// so a build that downloaded fine and then failed to apply told the user
/// "could not check for updates", which sent everyone looking at their network
/// instead of at the installer. They are separate now, and the reason string
/// travels with the result — an updater that cannot say why it stopped is an
/// updater nobody can debug from a report.
export type UpdateCheck =
  | { kind: 'unsupported' | 'current' | 'found' }
  | { kind: 'failed' | 'install_failed'; reason: string }

function reasonOf(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

/// Check on demand, from a button. Unlike the launch check this one runs every
/// time it's called and reports back — being told "you're up to date" is the
/// whole point of pressing it.
export async function checkForUpdatesNow(t: Translate): Promise<UpdateCheck> {
  if (!isTauri()) return { kind: 'unsupported' }
  let update: Awaited<ReturnType<typeof import('@tauri-apps/plugin-updater')['check']>>
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    update = await check()
  } catch (e) {
    console.error('[updater] check failed', e)
    return { kind: 'failed', reason: reasonOf(e) }
  }
  if (!update) return { kind: 'current' }
  updateChecked = true
  try {
    await promptAndInstall(update, t)
  } catch (e) {
    // Download, signature check and the swap itself all land here. The message
    // is the only thing that distinguishes "no disk space" from "signature did
    // not verify", and the user is the one who has to read it back to us.
    console.error('[updater] install failed', e)
    return { kind: 'install_failed', reason: reasonOf(e) }
  }
  return { kind: 'found' }
}

export interface RelayKeyStatus {
  present: boolean
  verdict: string | null
  private_count: number
}

/** Whether this install holds a paid access key, and what the broker last made
 *  of it. The key itself never comes back: it is a bearer credential, and
 *  nothing on screen needs its value. */
export async function relayKeyStatus(): Promise<RelayKeyStatus> {
  if (!isTauri()) return { present: false, verdict: null, private_count: 0 }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<RelayKeyStatus>('relay_key_status')
  } catch {
    return { present: false, verdict: null, private_count: 0 }
  }
}

/** Store a paid access key (or clear it with null) and rebuild the tunnel
 *  around it immediately. Unlike every other tunnel change here, this one does
 *  NOT need a relaunch: the core is restarted behind the same loopback port, so
 *  the address the window was built against never moves.
 *
 *  Returns the broker's verdict: `ok`, `unknown` (a key it does not know),
 *  `expired`, or `offline` when the question never got through — which is not
 *  the same as a bad key and must not be reported as one. */
export async function setRelayKey(
  key: string | null,
): Promise<{ verdict: string; private_count: number }> {
  if (!isTauri()) return { verdict: 'offline', private_count: 0 }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<{ verdict: string; private_count: number }>('relay_key_set', { key })
  } catch {
    return { verdict: 'offline', private_count: 0 }
  }
}

/** Open a link in the user's real browser.
 *
 *  Needed because every external link in this app is `<a target="_blank">`,
 *  which in a webview means `window.open` — and wry implements none, so on the
 *  desktop those links did nothing at all. In a browser this is a no-op and the
 *  anchor behaves normally.
 *
 *  Returns whether it took the link, so the caller knows whether to let the
 *  default happen. */
export async function openExternal(url: string): Promise<boolean> {
  if (!isTauri()) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_external', { url })
    return true
  } catch {
    return false
  }
}

/** Catch every click on an external link, once, at the document root.
 *
 *  A handler per link would mean touching every place that renders one, and
 *  missing the next one somebody adds. Capture phase so it runs before React's
 *  own listeners, and it only acts on plain left clicks with no modifier: a
 *  middle click or cmd-click is the user asking for something else. */
export function installExternalLinkHandler() {
  if (!isTauri()) return
  document.addEventListener(
    'click',
    (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as HTMLElement | null)?.closest?.('a')
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      if (!/^https?:\/\//i.test(href)) return
      e.preventDefault()
      void openExternal(href)
    },
    true,
  )
}
