pub mod commands;

use std::sync::Arc;

use commands::AppState;
use lighterm_core::LightermCore;
use lighterm_plugin_history::HistoryPlugin;
use lighterm_plugin_monitor::MonitorPlugin;
use lighterm_plugin_sftp::SftpPlugin;
use lighterm_plugin_snippets::SnippetsPlugin;
use tauri::{Emitter, Manager};

#[cfg(target_os = "linux")]
fn install_linux_gtk_log_filter() {
    use std::sync::Once;
    static INIT: Once = Once::new();

    INIT.call_once(|| {
        // Silence noisy system GTK3 CSS theme parsing warnings (e.g. Deepin gtk-dark.css)
        // while forwarding all other GLib/GTK/WebKit logs unchanged.
        glib::log_set_writer_func(|level, fields| {
            let mut domain: Option<&str> = None;
            let mut message: Option<&str> = None;
            for field in fields {
                match field.key() {
                    "GLIB_DOMAIN" => domain = field.value_str(),
                    "MESSAGE" => message = field.value_str(),
                    _ => {}
                }
            }

            if domain == Some("Gtk")
                && message.is_some_and(|m| m.contains("Theme parsing error:"))
            {
                return glib::LogWriterOutput::Handled;
            }

            glib::log_writer_default(level, fields)
        });

        glib::log_set_handler(
            Some("Gtk"),
            glib::LogLevels::LEVEL_WARNING,
            false,
            false,
            |domain, level, message| {
                if !message.contains("Theme parsing error:") {
                    glib::log_default_handler(domain, level, Some(message));
                }
            },
        );
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    install_linux_gtk_log_filter();

    let core = Arc::new(LightermCore::default_instance().expect("Failed to initialize Lighterm core"));
    core.register_plugin(Arc::new(SftpPlugin::new()))
        .expect("Failed to register SFTP plugin");
    core.register_plugin(Arc::new(MonitorPlugin::new()))
        .expect("Failed to register Monitor plugin");
    core.register_plugin(Arc::new(SnippetsPlugin::new()))
        .expect("Failed to register Snippets plugin");
    core.register_plugin(Arc::new(HistoryPlugin::new()))
        .expect("Failed to register History plugin");

    let window_bounds = Arc::new(commands::WindowBoundsTracker::default());
    let core_setup = Arc::clone(&core);
    let bounds_setup = Arc::clone(&window_bounds);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            core,
            window_bounds,
        })
        .setup(move |app| {
            if let Some(main_win) = app.get_webview_window("main") {
                commands::restore_window_bounds(&main_win, &core_setup, &bounds_setup);
                let win_events = main_win.clone();
                let core_events = Arc::clone(&core_setup);
                let bounds_events = Arc::clone(&bounds_setup);
                main_win.on_window_event(move |event| match event {
                    tauri::WindowEvent::Moved(_) => {
                        commands::update_bounds_from_webview_window(&win_events, &bounds_events);
                        commands::schedule_window_bounds_save(&core_events, &bounds_events);
                    }
                    tauri::WindowEvent::Resized(_) => {
                        commands::update_bounds_from_webview_window(&win_events, &bounds_events);
                        commands::schedule_window_bounds_save(&core_events, &bounds_events);
                        let maximized = win_events.is_maximized().unwrap_or(false);
                        let focused = win_events.is_focused().unwrap_or(true);
                        let _ = win_events.emit(
                            "window:state-changed",
                            commands::build_window_state(maximized, focused),
                        );
                    }
                    tauri::WindowEvent::Focused(focused) => {
                        let maximized = win_events.is_maximized().unwrap_or(false);
                        let _ = win_events.emit(
                            "window:state-changed",
                            commands::build_window_state(maximized, *focused),
                        );
                    }
                    tauri::WindowEvent::CloseRequested { .. } => {
                        commands::update_bounds_from_webview_window(&win_events, &bounds_events);
                        commands::flush_window_bounds_sync(&core_events, &bounds_events);
                    }
                    tauri::WindowEvent::Destroyed => {
                        commands::flush_window_bounds_sync(&core_events, &bounds_events);
                    }
                    _ => {}
                });
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                if let Some(win) = handle.get_webview_window("main") {
                    if !win.is_visible().unwrap_or(true) {
                        let _ = win.show();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::window_ready,
            commands::window_enable_transparency,
            commands::window_get_state,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_close,
            commands::window_start_dragging,
            commands::terminal_create_local,
            commands::terminal_create_ssh,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_close,
            commands::terminal_list,
            commands::hosts_list,
            commands::hosts_save,
            commands::hosts_delete,
            commands::hosts_test_connection,
            commands::workspaces_list,
            commands::workspaces_save,
            commands::workspaces_delete,
            commands::settings_get,
            commands::settings_save,
            commands::plugins_list,
            commands::plugins_set_enabled,
            commands::sftp_canonicalize,
            commands::sftp_list_dir,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_upload,
            commands::sftp_download,
            commands::snippets_list,
            commands::snippets_save,
            commands::snippets_delete,
            commands::history_list,
            commands::history_record,
            commands::history_delete,
            commands::history_clear,
            commands::monitor_get_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lighterm");
}
