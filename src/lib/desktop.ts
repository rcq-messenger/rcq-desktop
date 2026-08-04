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
  /** The tunnel came up because the island was unreachable, not because the
   *  user asked. The UI says so rather than looking like it flipped itself. */
  auto: boolean
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
  await update.downloadAndInstall()
  const { relaunch } = await import('@tauri-apps/plugin-process')
  await relaunch()
}

// Check the update endpoint once per launch; if a newer signed build is
// published, ask the user and (on yes) download, install, and relaunch.
// No-op off desktop / when the endpoint is unreachable.
let updateChecked = false
export async function checkForUpdatesOnLaunch(t: Translate): Promise<void> {
  if (!isTauri() || updateChecked) return
  updateChecked = true
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) return
    await promptAndInstall(update, t)
  } catch {
    /* no update / endpoint unreachable / not yet hosted — ignore */
  }
}

/// What a manual check found, so the caller can say so in the UI. The launch
/// check stays silent instead, because nobody asked it a question.
export type UpdateCheck = 'unsupported' | 'current' | 'found' | 'failed'

/// Check on demand, from a button. Unlike the launch check this one runs every
/// time it's called and reports back — being told "you're up to date" is the
/// whole point of pressing it.
export async function checkForUpdatesNow(t: Translate): Promise<UpdateCheck> {
  if (!isTauri()) return 'unsupported'
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) return 'current'
    updateChecked = true
    await promptAndInstall(update, t)
    return 'found'
  } catch {
    return 'failed'
  }
}
