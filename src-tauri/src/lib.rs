// RCQ desktop shell. Wraps the web-chat frontend in a native window and adds
// the desktop chrome the browser can't do: a tray icon, run-in-background
// (closing the window hides it instead of quitting, so OS notifications keep
// arriving), single-instance focus, the OS notification plugin (driven from JS
// via lib/desktop.ts), and circumvention through a bundled sing-box.

#[cfg(desktop)]
mod user_relay;
mod broker;
mod bypass;
#[cfg(desktop)]
mod relay;
mod dns_txt;
mod signing_keys;
mod vault;

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WebviewUrl, WebviewWindowBuilder,
};
use tauri::{Manager, WindowEvent};

// What the window remembers between launches: size, position, maximized and
// fullscreen — everything EXCEPT visibility.
//
// VISIBLE has to stay out. The plugin restores `show()` only when the saved
// visible flag is true, and in this app the window is usually hidden when the
// app exits: closing it goes to the tray rather than quitting. Saving that
// would mean the next launch decides whether to draw a window based on how the
// last one ended, and anyone who later gives the builder `.visible(false)`
// (the usual cure for the restore flicker) would get a launch with no window
// at all, just a tray icon.
#[cfg(desktop)]
fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    use tauri_plugin_window_state::StateFlags;
    StateFlags::all() & !StateFlags::VISIBLE
}

// The plugin only writes the file on RunEvent::Exit, and this app spends most
// of its life not reaching that: the close button hides to the tray, so a
// Windows restart or a killed process takes the geometry with it. Saving is a
// small JSON write, so it is cheaper to do it whenever the window settles than
// to reason about which exits are clean.
#[cfg(desktop)]
fn save_window_state_now(app: &tauri::AppHandle) {
    use tauri_plugin_window_state::AppHandleExt;
    if let Err(e) = app.save_window_state(window_state_flags()) {
        log::error!("could not save the window geometry: {e}");
    }
}

// Dragging a window emits a Moved per frame, so the write is coalesced: the
// first event arms a one-shot, and everything until it fires is free.
//
// ⚠ The spawned thread is a TIMER ONLY. Saving reads the window's geometry,
// and those getters block on a reply from the event loop while the plugin's
// own move/resize handler is holding its cache mutex on that same loop — call
// it off the main thread and the two can wait on each other with the whole app
// frozen. So the work is bounced back with `run_on_main_thread`, where every
// getter takes the in-thread fast path and nothing is contended.
#[cfg(desktop)]
fn schedule_window_state_save(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static PENDING: AtomicBool = AtomicBool::new(false);

    if PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800));
        PENDING.store(false, Ordering::SeqCst);
        let inner = app.clone();
        // Fails only once the event loop is gone, and then the plugin's own
        // Exit handler has already written the file.
        let _ = app.run_on_main_thread(move || save_window_state_now(&inner));
    });
}

// Bring the main window to the foreground (used by the tray, single-instance
// re-launch, and macOS dock re-click).
#[cfg(desktop)]
fn focus_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Relays the user pasted by hand. Kept apart from the signed pool: these
/// arrive out of band and nothing vouches for them.
#[cfg(desktop)]
#[tauri::command]
fn user_relays(app: tauri::AppHandle) -> Vec<user_relay::UserRelay> {
    user_relay::list(&app)
}

/// Takes effect on the next launch, like every other change to the tunnel —
/// the proxy is bound when the webview is built.
#[cfg(desktop)]
#[tauri::command]
fn user_relay_add(app: tauri::AppHandle, token: String) -> Result<user_relay::UserRelay, String> {
    user_relay::add(&app, &token)
}

#[cfg(desktop)]
#[tauri::command]
fn user_relay_remove(app: tauri::AppHandle, tag: String) -> Result<(), String> {
    user_relay::remove(&app, &tag)
}


/// The paid access key. Storing it asks the broker what it is worth right away
/// and rebuilds the running tunnel, so the endpoints are carrying traffic
/// before the person who pasted the key has looked away. Everywhere else on
/// this platform a change to the tunnel waits for a relaunch, because the
/// webview's proxy is bound when the window is built — that constraint is about
/// the ADDRESS the page talks to, and rebuilding the core behind the same
/// loopback port does not move it.
#[cfg(desktop)]
#[tauri::command]
fn relay_key_set(app: tauri::AppHandle, key: Option<String>) -> broker::KeyResult {
    let proxy = bypass::proxy_for_fetch();
    let result = broker::set_key(&app, key, proxy.as_deref());
    if result.verdict == "ok" {
        bypass::rebuild(&app);
    }
    result
}

/// Whether a key is stored and what the broker last made of it. The key itself
/// is never handed back to the page: it is a bearer credential, and the page has
/// no use for it that showing a masked state does not cover.
#[cfg(desktop)]
#[tauri::command]
fn relay_key_status(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "present": broker::key(&app).is_some(),
        "verdict": broker::verdict(&app),
        "private_count": broker::relays(&app).len(),
    })
}

#[cfg(desktop)]
#[tauri::command]
fn bypass_status(app: tauri::AppHandle) -> bypass::Status {
    let config = bypass::current_config(&app);
    bypass::Status {
        supported: bypass::supported(),
        enabled: bypass::is_enabled(&app),
        running: bypass::is_running(),
        tried_at_startup: bypass::tried_at_startup(),
        relay_config_version: config.as_ref().and_then(|c| c.version),
        relay_front: config.as_ref().and_then(|c| c.front.clone()),
        relay_count: config.map(|c| c.relays.len()).unwrap_or(0),
        auto: bypass::is_auto(&app),
        needs_relaunch: bypass::needs_relaunch(),
    }
}

/// Record the choice. It takes effect on the next launch: the webview proxy is
/// fixed when the webview is built, so there is nothing to flip in place.
#[cfg(desktop)]
#[tauri::command]
fn bypass_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if !bypass::supported() {
        return Err("unsupported".into());
    }
    bypass::set_enabled(&app, enabled)
}

/// Probe the island directly and over the current route. Blocking work, so it
/// goes to the blocking pool rather than stalling a runtime worker for the
/// seconds a censored network takes to time out.
#[cfg(desktop)]
#[tauri::command]
async fn network_diagnostics(app: tauri::AppHandle, host: String) -> bypass::Diagnostics {
    // The only place the island's host crosses into Rust. Remember it so the
    // next launch can probe the right one before any window exists.
    bypass::remember_host(&app, &host);
    tauri::async_runtime::spawn_blocking(move || bypass::diagnostics(&app, &host))
        .await
        .unwrap_or_default()
}

/// Which desktop this is, so the app can name itself correctly instead of
/// calling itself the web client.
#[cfg(desktop)]
// ── PIN vault ───────────────────────────────────────────────────────────────
// The page holds the account material; this side holds the only copy that
// survives a restart, and it is sealed. See vault.rs for what that does and
// does not protect.

#[tauri::command]
fn vault_state(app: tauri::AppHandle, open: tauri::State<vault::Unlocked>) -> vault::VaultState {
    vault::state(&app, &open)
}

#[tauri::command]
fn vault_create(
    app: tauri::AppHandle,
    open: tauri::State<vault::Unlocked>,
    pin: String,
    plaintext: String,
) -> Result<(), String> {
    vault::create(&app, &open, &pin, &plaintext)
}

#[tauri::command]
fn vault_unlock(
    app: tauri::AppHandle,
    open: tauri::State<vault::Unlocked>,
    pin: String,
) -> Result<String, String> {
    vault::unlock(&app, &open, &pin)
}

/// The ordinary write while unlocked — no PIN, because the page does this
/// every time a token is refreshed and asking again would train people to
/// type their PIN at any prompt.
#[tauri::command]
fn vault_write(
    app: tauri::AppHandle,
    open: tauri::State<vault::Unlocked>,
    plaintext: String,
) -> Result<(), String> {
    vault::write_unlocked(&app, &open, &plaintext)
}

/// Hand the contents back to a page that reloaded inside an already-unlocked
/// session (an account switch, an island switch). No PIN: the key is already
/// held, and asking again is what taught people to type it at any prompt.
#[tauri::command]
fn vault_read(
    app: tauri::AppHandle,
    open: tauri::State<vault::Unlocked>,
) -> Result<String, String> {
    vault::read_unlocked(&app, &open)
}

#[tauri::command]
fn vault_lock(open: tauri::State<vault::Unlocked>) {
    vault::lock(&open)
}

#[tauri::command]
fn vault_remove(
    app: tauri::AppHandle,
    open: tauri::State<vault::Unlocked>,
    pin: String,
) -> Result<String, String> {
    vault::remove(&app, &open, &pin)
}

/// Forgot the PIN: drop the vault unopened. See `vault::destroy`.
#[tauri::command]
fn vault_destroy(
    app: tauri::AppHandle,
    open: tauri::State<vault::Unlocked>,
) -> Result<(), String> {
    vault::destroy(&app, &open)
}

/// Stop the bundled sing-box so an installer can replace its file.
///
/// ⚠ Windows will not overwrite a running executable. The updater downloads
/// the new build, the installer tries to write `sing-box.exe` while our own
/// child process still holds it, and the update fails — every time, for
/// anyone who has the bypass on. Reported 2026-08-16: "всё время такая ошибка
/// что синг бокс не может обновить, приходится вручную качать и
/// перезагружать ПК".
///
/// Deliberately NOT `bypass_set(false)`: the setting stays on, so the tunnel
/// comes back by itself on the next launch. This only takes the process down
/// for the seconds the installer needs.
#[tauri::command]
fn bypass_halt() {
    bypass::stop();
}

#[tauri::command]
fn desktop_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// Hand a link to the real browser.
///
/// Every external link in the app is an `<a target="_blank">`, which in a
/// webview means `window.open` — and wry implements no window.open, so the
/// click did nothing at all: the cursor changed, the underline appeared, and
/// that was the whole of it (founder, 2026-08-13). The `on_navigation` hook
/// below cannot help, because a `_blank` link never navigates THIS window.
///
/// ⚠ http/https only. This is reachable from the page, so it must not become a
/// way to launch `file://`, a custom scheme, or anything else the OS would
/// hand to an application.
#[cfg(desktop)]
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("refusing to open scheme {}", parsed.scheme()));
    }
    #[allow(deprecated)]
    tauri_plugin_shell::ShellExt::shell(&app)
        .open(parsed.as_str(), None)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Desktop-only plugins: single-instance focus, auto-updater, process
    // (relaunch after update), dialogs (the update prompt), and shell (the
    // sing-box sidecar).
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                focus_main(app);
            }))
            .plugin(tauri_plugin_updater::Builder::new().build())
            // Remember where the window was and how big it got (#474). The
            // builder below still sets 1100x760 centered — that is the first
            // launch, and the fallback when the saved position lands on a
            // monitor that is no longer there.
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(window_state_flags())
                    .build(),
            )
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_shell::init())
            .invoke_handler(tauri::generate_handler![
                bypass_status,
                user_relays,
                user_relay_add,
                user_relay_remove,
                bypass_set,
                bypass_halt,
                relay_key_set,
                relay_key_status,
                network_diagnostics,
                desktop_platform,
                open_external,
                vault_state,
                vault_create,
                vault_unlock,
                vault_read,
                vault_write,
                vault_lock,
                vault_remove,
                vault_destroy
            ]);
    }

    let app = builder
        // The PIN-derived key lives here for as long as the app stays
        // unlocked, and nowhere else. See vault.rs.
        .manage(vault::Unlocked::default())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(desktop)]
            {
                // The proxy can only be attached while the webview is being
                // built, so the core has to be up before the window exists.
                // Starting it costs a moment of blank screen on a censored
                // network; showing a window we then have to throw away costs
                // more.
                // The user's own choice first; failing that, ask the network.
                // A blocked user could not reach the toggle before — the app
                // they needed the toggle FOR was the thing that would not
                // connect — so the probe decides for them, once, with a short
                // budget (this runs before the window exists).
                let proxy_port = if bypass::is_enabled(app.handle()) {
                    bypass::start(app.handle())
                } else {
                    bypass::auto_engage_if_blocked(app.handle())
                };
                // The startup probe answers "is it blocked right now". A network
                // that starts blocking with the window already open used to go
                // unnoticed until the next launch, which is the moment nobody
                // suspects a setting. This keeps asking.
                bypass::watch(app.handle());

                let nav_handle = app.handle().clone();
                let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                    .title("RCQ")
                    .inner_size(1100.0, 760.0)
                    .min_inner_size(380.0, 560.0)
                    .resizable(true)
                    .center()
                    // An ordinary <a href> to another site would navigate THIS
                    // window away from the app. The user is then looking at a
                    // web page where they are not signed in, with no way back
                    // except restarting — which is exactly what the UIN market
                    // link in Settings did, and it read as "it logged me out"
                    // (reported 2026-08-04).
                    //
                    // The app owns its window: only its own pages may load in
                    // it, and anything else goes to the real browser, where
                    // links belong.
                    .on_navigation(move |url| {
                        let scheme = url.scheme();
                        let internal = matches!(scheme, "tauri" | "ipc" | "asset")
                            || url.host_str() == Some("tauri.localhost")
                            || url.host_str() == Some("localhost")
                            || url.host_str() == Some("127.0.0.1");
                        if internal {
                            return true;
                        }
                        #[allow(deprecated)]
                        if let Err(e) = tauri_plugin_shell::ShellExt::shell(&nav_handle)
                            .open(url.as_str(), None)
                        {
                            log::error!("could not hand {url} to the browser: {e}");
                        }
                        false
                    });
                if let Some(port) = proxy_port {
                    let url = format!("socks5://127.0.0.1:{port}");
                    match url.parse() {
                        Ok(url) => window = window.proxy_url(url),
                        Err(e) => log::error!("bad proxy url {url}: {e}"),
                    }
                }
                let main_window = window.build()?;

                // ⚠ The plugin SAVES on its own but only RESTORES windows it is
                // asked about. This window is built here in `setup` rather than
                // declared in tauri.conf.json, so without this call the size and
                // position were written to disk every session and then ignored
                // on every launch: the builder's 1100x760 `.center()` won.
                #[cfg(desktop)]
                {
                    use tauri_plugin_window_state::WindowExt;
                    if let Err(e) = main_window.restore_state(window_state_flags()) {
                        log::warn!("window state restore failed: {e}");
                    }
                }

                // Calls need a microphone, and only ONE of the three webviews
                // hands one over by itself.
                //
                // macOS: wry answers the WKUIDelegate capture request with
                // `Grant`, so the page gets the device as soon as the OS has
                // granted it to the app (Info.plist + entitlements, below).
                // Windows: WebView2 asks the user with its own prompt.
                // Linux: WebKitGTK ships the media stream switched OFF, so
                // `navigator.mediaDevices` does not even exist, and it denies
                // any permission request nobody handles. Both are ours to turn
                // on, and this is the only place they can be turned on from.
                #[cfg(target_os = "linux")]
                {
                    use webkit2gtk::glib::prelude::ObjectExt;
                    use webkit2gtk::{
                        PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt,
                    };

                    if let Err(e) = main_window.with_webview(|webview| {
                        let view = webview.inner();
                        if let Some(settings) = WebViewExt::settings(&view) {
                            settings.set_enable_media_stream(true);
                            settings.set_enable_webrtc(true);
                        }
                        view.connect_permission_request(|_, request| {
                            // Camera and microphone only. The webview never
                            // navigates off our own page, so there is no third
                            // party here to be granting anything to — but a
                            // blanket yes would also cover geolocation and
                            // notifications, which is not ours to give away.
                            if request.is::<UserMediaPermissionRequest>() {
                                request.allow();
                                return true;
                            }
                            false
                        });
                    }) {
                        log::error!("could not enable media capture on the webview: {e}");
                    }
                }
                #[cfg(not(target_os = "linux"))]
                let _ = &main_window;

                // Pick up relay rotations for the next launch, through the
                // tunnel when it is up (a censored user cannot reach the
                // mirrors any other way).
                bypass::refresh_relays_in_background(app.handle(), proxy_port);
            }

            // Tray icon with an Open / Quit menu; left-click reopens the window.
            #[cfg(desktop)]
            {
                let open = MenuItem::with_id(app, "open", "Open RCQ", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit RCQ", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &quit])?;
                let icon = app
                    .default_window_icon()
                    .cloned()
                    .expect("app has a default window icon");
                let _tray = TrayIconBuilder::with_id("main")
                    .icon(icon)
                    .tooltip("RCQ")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "open" => focus_main(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            focus_main(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }
            Ok(())
        })
        // Closing the window hides it to the tray instead of quitting, so the
        // app keeps running and OS notifications still arrive. Real quit is
        // Cmd+Q or the tray's Quit item.
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                // Before the hide, not after: a hidden window is no longer a
                // reliable thing to read a position off.
                #[cfg(desktop)]
                save_window_state_now(window.app_handle());
                let _ = window.hide();
                api.prevent_close();
            }
            #[cfg(desktop)]
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                schedule_window_state_save(window.app_handle());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        // macOS: clicking the dock icon with no visible window reopens it.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            focus_main(app_handle);
        }
        // Take the core down with us. It is a child process, so a hard exit
        // would otherwise leave it holding a port until the OS reaps it.
        #[cfg(desktop)]
        if let tauri::RunEvent::Exit = event {
            bypass::stop();
        }
        let _ = (app_handle, &event);
    });
}
