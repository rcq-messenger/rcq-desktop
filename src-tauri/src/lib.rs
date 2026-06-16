// RCQ desktop shell. Wraps the web-chat frontend in a native window and adds
// the desktop chrome the browser can't do: a tray icon, run-in-background
// (closing the window hides it instead of quitting, so OS notifications keep
// arriving), single-instance focus, and the OS notification plugin (driven
// from JS via lib/desktop.ts).

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Desktop-only plugins: single-instance focus, auto-updater, process
    // (relaunch after update), and dialogs (the update prompt).
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                focus_main(app);
            }))
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_dialog::init());
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
        let _ = (app_handle, &event);
    });
}
