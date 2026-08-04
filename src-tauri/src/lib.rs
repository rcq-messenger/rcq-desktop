// RCQ desktop shell. Wraps the web-chat frontend in a native window and adds
// the desktop chrome the browser can't do: a tray icon, run-in-background
// (closing the window hides it instead of quitting, so OS notifications keep
// arriving), single-instance focus, the OS notification plugin (driven from JS
// via lib/desktop.ts), and circumvention through a bundled sing-box.

#[cfg(desktop)]
mod bypass;
#[cfg(desktop)]
mod relay;

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WebviewUrl, WebviewWindowBuilder,
};
use tauri::{Manager, WindowEvent};

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
        relay_count: config.map(|c| c.relays.len()).unwrap_or(0),
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
    tauri::async_runtime::spawn_blocking(move || bypass::diagnostics(&app, &host))
        .await
        .unwrap_or_default()
}

/// Which desktop this is, so the app can name itself correctly instead of
/// calling itself the web client.
#[cfg(desktop)]
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
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_shell::init())
            .invoke_handler(tauri::generate_handler![
                bypass_status,
                bypass_set,
                network_diagnostics,
                desktop_platform
            ]);
    }

    let app = builder
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
                let proxy_port = if bypass::is_enabled(app.handle()) {
                    bypass::start(app.handle())
                } else {
                    None
                };

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
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
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
