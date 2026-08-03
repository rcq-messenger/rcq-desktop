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
