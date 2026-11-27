pub mod commands;

use std::sync::Arc;

use commands::AppState;
use lighterm_core::LightermCore;
use lighterm_plugin_history::HistoryPlugin;
use lighterm_plugin_monitor::MonitorPlugin;
use lighterm_plugin_sftp::SftpPlugin;
use lighterm_plugin_snippets::SnippetsPlugin;
use lighterm_plugin_sync::SyncPlugin;
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

fn resolve_cli_startup_cwd() -> Option<std::path::PathBuf> {
    let mut args = std::env::args().skip(1);
    let mut candidate: Option<String> = None;

    while let Some(arg) = args.next() {
        if arg == "--cwd" {
            if let Some(val) = args.next() {
                candidate = Some(val);
                break;
            }
        } else if let Some(val) = arg.strip_prefix("--cwd=") {
            candidate = Some(val.to_string());
            break;
        } else if !arg.starts_with('-') {
            candidate = Some(arg);
            break;
        }
    }

    let raw = candidate?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut path = std::path::PathBuf::from(trimmed);
    if path.is_relative() {
        if let Ok(cwd) = std::env::current_dir() {
            path = cwd.join(path);
        }
    }
    if path.exists() && path.is_dir() {
        Some(path)
    } else {
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    install_linux_gtk_log_filter();

    if let Some(startup_cwd) = resolve_cli_startup_cwd() {
        lighterm_core::pty::set_startup_cwd(startup_cwd);
    }

    let core = Arc::new(LightermCore::default_instance().expect("Failed to initialize Lighterm core"));
    core.register_plugin(Arc::new(SftpPlugin::new()))
        .expect("Failed to register SFTP plugin");
    core.register_plugin(Arc::new(MonitorPlugin::new()))
        .expect("Failed to register Monitor plugin");
    core.register_plugin(Arc::new(SnippetsPlugin::new()))
        .expect("Failed to register Snippets plugin");
    core.register_plugin(Arc::new(HistoryPlugin::new()))
        .expect("Failed to register History plugin");
    core.register_plugin(Arc::new(SyncPlugin::new()))
        .expect("Failed to register Sync plugin");

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
            commands::terminal_list_local_shells,
            commands::hosts_list,
            commands::hosts_save,
            commands::hosts_delete,
            commands::hosts_test_connection,
            commands::recent_hosts_list,
            commands::recent_hosts_save,
            commands::workspaces_list,
            commands::workspaces_save,
            commands::workspaces_delete,
            commands::settings_get,
            commands::settings_save,
            commands::plugins_list,
            commands::plugins_set_enabled,
            commands::plugin_configs_get_all,
            commands::plugin_config_get,
            commands::plugin_config_save,
            commands::plugin_config_reset,
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
            commands::sync_get_config,
            commands::sync_save_config,
            commands::sync_reset_state,
            commands::sync_oauth_start,
            commands::sync_oauth_poll,
            commands::sync_oauth_cancel,
            commands::sync_oauth_logout,
            commands::sync_open_verification_url,
            commands::sync_test_connection,
            commands::sync_discover_gists,
            commands::sync_now,
            commands::sync_push,
            commands::sync_pull,
            commands::updater_get_state,
            commands::updater_save_preferences,
            commands::updater_check,
            commands::updater_download,
            commands::updater_cancel_download,
            commands::updater_install,
            commands::updater_open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lighterm");
}
