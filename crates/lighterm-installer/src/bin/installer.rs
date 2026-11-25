#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("lighterm-installer GUI only runs on Windows.");
    std::process::exit(1);
}

#[cfg(target_os = "windows")]
mod app {
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use lighterm_installer::bundle::{
        extract_sfx_to_dir, inspect_sfx, verify_sfx_bundle, SfxTrailer,
    };
    use lighterm_installer::config::{normalize_browse_folder, InstallOptions, APP_EXE_NAME, APP_VERSION};
    use lighterm_installer::win_ops::{
        apply_install_integrations, get_free_disk_bytes, launch_installed_app,
        resolve_uninstall_dir, run_uninstall, schedule_self_delete_if_inside,
        stop_running_lighterm,
    };
    use serde::{Deserialize, Serialize};
    use tao::dpi::{LogicalSize, PhysicalPosition};
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::platform::windows::WindowBuilderExtWindows;
    use tao::window::WindowBuilder;
    use wry::{WebContext, WebViewBuilder};

    const UI_HTML: &str = include_str!("../ui.html");

    #[derive(Debug, Deserialize)]
    #[serde(tag = "cmd", rename_all = "snake_case")]
    enum IpcCommand {
        UiReady,
        Minimize,
        Close,
        DragWindow,
        BrowseDir {
            #[serde(rename = "currentDir")]
            current_dir: String,
        },
        StartInstall {
            options: InstallOptions,
        },
        LaunchApp {
            #[serde(rename = "installDir")]
            install_dir: String,
        },
        StartUninstall {
            #[serde(rename = "installDir")]
            install_dir: String,
            #[serde(rename = "purgeUserData")]
            purge_user_data: bool,
        },
        FinishUninstall {
            #[serde(rename = "installDir")]
            install_dir: String,
        },
    }

    #[derive(Debug)]
    enum AppEvent {
        Ipc(IpcCommand),
        BrowsePicked(PathBuf),
        Progress { progress: f64, status_text: String },
        OperationDone { install_dir: PathBuf },
        OperationError(String),
        SelfTestTimeout,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct InitPayload {
        mode: &'static str,
        version: &'static str,
        install_dir: String,
        desktop_shortcut: bool,
        start_menu_shortcut: bool,
        add_to_path: bool,
        context_menu: bool,
        required_mb: f64,
        free_gb: f64,
    }

    struct CliFlags {
        verify_bundle: bool,
        self_test_ui: bool,
        silent: bool,
        uninstall: bool,
        no_system_integration: bool,
        dir: Option<String>,
    }

    impl CliFlags {
        fn parse() -> Self {
            let args: Vec<String> = std::env::args().skip(1).collect();
            let mut flags = Self {
                verify_bundle: false,
                self_test_ui: false,
                silent: false,
                uninstall: false,
                no_system_integration: false,
                dir: None,
            };

            let mut i = 0;
            while i < args.len() {
                match args[i].as_str() {
                    "--verify-bundle" => flags.verify_bundle = true,
                    "--self-test-ui" => flags.self_test_ui = true,
                    "--silent" => flags.silent = true,
                    "--uninstall" => flags.uninstall = true,
                    "--no-system-integration" => flags.no_system_integration = true,
                    "--dir" => {
                        if let Some(val) = args.get(i + 1) {
                            flags.dir = Some(val.clone());
                            i += 1;
                        }
                    }
                    other if other.starts_with("--dir=") => {
                        flags.dir = Some(other.trim_start_matches("--dir=").to_string());
                    }
                    _ => {}
                }
                i += 1;
            }
            flags
        }
    }

    fn execute_install_pipeline(
        exe_path: &Path,
        trailer: &SfxTrailer,
        options: &InstallOptions,
        touch_system_integration: bool,
        mut emit_progress: impl FnMut(f64, &str),
    ) -> Result<(), String> {
        let install_dir = PathBuf::from(&options.install_dir);
        let target_exe = install_dir.join(APP_EXE_NAME);

        emit_progress(0.02, "正在检查目标程序状态...");
        stop_running_lighterm(&target_exe);

        extract_sfx_to_dir(exe_path, trailer, &install_dir, |p, msg| {
            emit_progress(p, msg);
        })?;

        apply_install_integrations(
            options,
            trailer.uncompressed_bytes,
            touch_system_integration,
            &mut emit_progress,
        )?;
        Ok(())
    }

    fn pace_progress(started: Instant, target_min_secs: f64, frac: f64) {
        let desired_elapsed = Duration::from_secs_f64(target_min_secs * frac.clamp(0.0, 1.0));
        let actual_elapsed = started.elapsed();
        if desired_elapsed > actual_elapsed {
            std::thread::sleep(desired_elapsed - actual_elapsed);
        }
    }

    pub fn run() -> i32 {
        let flags = CliFlags::parse();
        let current_exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("Failed resolving current_exe: {e}");
                return 1;
            }
        };

        if flags.verify_bundle {
            match verify_sfx_bundle(&current_exe) {
                Ok(summary) => {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&summary).unwrap_or_default()
                    );
                    return 0;
                }
                Err(e) => {
                    eprintln!("Bundle verification failed: {e}");
                    return 1;
                }
            }
        }

        let trailer_opt = match inspect_sfx(&current_exe) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("Failed inspecting SFX trailer: {e}");
                return 1;
            }
        };

        let is_uninstall_mode = flags.uninstall || trailer_opt.is_none();

        if flags.silent {
            let touch_integration = !flags.no_system_integration;
            if is_uninstall_mode {
                let target_dir = resolve_uninstall_dir(flags.dir.as_deref(), &current_exe);
                if let Err(e) =
                    run_uninstall(&target_dir, false, touch_integration, &mut |_, _| {})
                {
                    eprintln!("Silent uninstall failed: {e}");
                    return 1;
                }
                if touch_integration {
                    schedule_self_delete_if_inside(&target_dir);
                }
                return 0;
            }

            let trailer = trailer_opt.expect("setup mode requires SFX trailer");
            let mut options = InstallOptions::default();
            if let Some(dir) = flags.dir {
                options.install_dir = dir;
            }
            if let Err(e) = execute_install_pipeline(
                &current_exe,
                &trailer,
                &options,
                touch_integration,
                |_, _| {},
            ) {
                eprintln!("Silent install failed: {e}");
                return 1;
            }
            return 0;
        }

        run_gui(flags.self_test_ui, current_exe, trailer_opt, is_uninstall_mode)
    }

    fn run_gui(
        self_test_ui: bool,
        current_exe: PathBuf,
        trailer_opt: Option<SfxTrailer>,
        is_uninstall_mode: bool,
    ) -> i32 {
        let event_loop = EventLoopBuilder::<AppEvent>::with_user_event().build();
        let window = WindowBuilder::new()
            .with_title(if is_uninstall_mode {
                "Lighterm 卸载程序"
            } else {
                "Lighterm 安装程序"
            })
            .with_inner_size(LogicalSize::new(668.0, 392.0))
            .with_resizable(false)
            .with_decorations(false)
            .with_transparent(true)
            .with_undecorated_shadow(false)
            .with_visible(true)
            .build(&event_loop)
            .expect("Failed creating installer window");

        if let Some(monitor) = window
            .current_monitor()
            .or_else(|| window.primary_monitor())
        {
            let mon_pos = monitor.position();
            let mon_size = monitor.size();
            let win_size = window.outer_size();
            let x = mon_pos.x + (mon_size.width as i32 - win_size.width as i32) / 2;
            let y = mon_pos.y + (mon_size.height as i32 - win_size.height as i32) / 2;
            window.set_outer_position(PhysicalPosition::new(x, y));
        }

        let wv2_data_dir =
            std::env::temp_dir().join(format!("lighterm-installer-wv2-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&wv2_data_dir);
        let mut web_context = WebContext::new(Some(wv2_data_dir.clone()));

        let proxy = event_loop.create_proxy();
        let webview = WebViewBuilder::new_with_web_context(&mut web_context)
            .with_transparent(true)
            .with_html(UI_HTML)
            .with_ipc_handler(move |req| {
                if let Ok(cmd) = serde_json::from_str::<IpcCommand>(req.body()) {
                    let _ = proxy.send_event(AppEvent::Ipc(cmd));
                }
            })
            .build(&window)
            .expect("Failed building WebView2 installer UI");

        if self_test_ui {
            let timeout_proxy = event_loop.create_proxy();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(10));
                let _ = timeout_proxy.send_event(AppEvent::SelfTestTimeout);
            });
        }

        let defaults = InstallOptions::default();
        let initial_dir = if is_uninstall_mode {
            resolve_uninstall_dir(None, &current_exe)
        } else {
            PathBuf::from(&defaults.install_dir)
        };
        let free_gb = get_free_disk_bytes(&initial_dir)
            .map(|b| b as f64 / (1024.0 * 1024.0 * 1024.0))
            .unwrap_or(0.0);
        let required_mb = trailer_opt
            .map(|t| t.uncompressed_bytes as f64 / (1024.0 * 1024.0))
            .unwrap_or(0.0);

        let init_payload = InitPayload {
            mode: if is_uninstall_mode {
                "uninstall"
            } else {
                "setup"
            },
            version: APP_VERSION,
            install_dir: initial_dir.to_string_lossy().into_owned(),
            desktop_shortcut: defaults.desktop_shortcut,
            start_menu_shortcut: defaults.start_menu_shortcut,
            add_to_path: defaults.add_to_path,
            context_menu: defaults.context_menu,
            required_mb,
            free_gb,
        };

        let mut webview_opt = Some(webview);
        let mut active_busy = false;
        let mut pending_self_delete_dir: Option<PathBuf> = None;
        let loop_proxy = event_loop.create_proxy();

        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::Wait;

            match event {
                Event::WindowEvent {
                    event: WindowEvent::CloseRequested,
                    ..
                } => {
                    if !active_busy {
                        let _ = webview_opt.take();
                        let _ = std::fs::remove_dir_all(&wv2_data_dir);
                        *control_flow = ControlFlow::Exit;
                    }
                }
                Event::UserEvent(app_event) => match app_event {
                    AppEvent::SelfTestTimeout => {
                        eprintln!("UI self-test timed out waiting for ui_ready");
                        let _ = webview_opt.take();
                        let _ = std::fs::remove_dir_all(&wv2_data_dir);
                        std::process::exit(1);
                    }
                    AppEvent::BrowsePicked(picked) => {
                        let normalized = normalize_browse_folder(&picked);
                        let free_gb = get_free_disk_bytes(&normalized)
                            .map(|b| b as f64 / (1024.0 * 1024.0 * 1024.0))
                            .unwrap_or(0.0);
                        let js_payload = serde_json::json!({
                            "installDir": normalized.to_string_lossy(),
                            "freeGb": free_gb
                        });
                        if let Some(wv) = &webview_opt {
                            let _ = wv.evaluate_script(&format!(
                                "window.__INSTALLER__.setPathInfo({js_payload});"
                            ));
                        }
                    }
                    AppEvent::Progress {
                        progress,
                        status_text,
                    } => {
                        let js_payload = serde_json::json!({
                            "progress": progress,
                            "statusText": status_text
                        });
                        if let Some(wv) = &webview_opt {
                            let _ = wv.evaluate_script(&format!(
                                "window.__INSTALLER__.setProgress({js_payload});"
                            ));
                        }
                    }
                    AppEvent::OperationDone { install_dir } => {
                        active_busy = false;
                        if is_uninstall_mode {
                            pending_self_delete_dir = Some(install_dir.clone());
                        }
                        let js_payload = serde_json::json!({
                            "installDir": install_dir.to_string_lossy()
                        });
                        if let Some(wv) = &webview_opt {
                            let _ = wv.evaluate_script(&format!(
                                "window.__INSTALLER__.setComplete({js_payload});"
                            ));
                        }
                    }
                    AppEvent::OperationError(msg) => {
                        active_busy = false;
                        let js_payload = serde_json::json!({ "message": msg });
                        if let Some(wv) = &webview_opt {
                            let _ = wv.evaluate_script(&format!(
                                "window.__INSTALLER__.setError({js_payload});"
                            ));
                        }
                    }
                    AppEvent::Ipc(cmd) => match cmd {
                        IpcCommand::UiReady => {
                            if let Some(wv) = &webview_opt {
                                if let Ok(json) = serde_json::to_string(&init_payload) {
                                    let _ = wv.evaluate_script(&format!(
                                        "window.__INSTALLER__.init({json});"
                                    ));
                                }
                            }
                            if self_test_ui {
                                println!("UI_SELF_TEST_OK");
                                let _ = webview_opt.take();
                                let _ = std::fs::remove_dir_all(&wv2_data_dir);
                                std::process::exit(0);
                            }
                        }
                        IpcCommand::Minimize => window.set_minimized(true),
                        IpcCommand::Close => {
                            if !active_busy {
                                if let Some(dir) = pending_self_delete_dir.take() {
                                    schedule_self_delete_if_inside(&dir);
                                }
                                let _ = webview_opt.take();
                                let _ = std::fs::remove_dir_all(&wv2_data_dir);
                                *control_flow = ControlFlow::Exit;
                            }
                        }
                        IpcCommand::DragWindow => {
                            let _ = window.drag_window();
                        }
                        IpcCommand::BrowseDir { current_dir } => {
                            let proxy = loop_proxy.clone();
                            std::thread::spawn(move || {
                                let mut dialog = rfd::FileDialog::new();
                                let cur = PathBuf::from(&current_dir);
                                if cur.exists() {
                                    dialog = dialog.set_directory(&cur);
                                } else if let Some(parent) = cur.parent() {
                                    if parent.exists() {
                                        dialog = dialog.set_directory(parent);
                                    }
                                }
                                if let Some(folder) = dialog.pick_folder() {
                                    let _ = proxy.send_event(AppEvent::BrowsePicked(folder));
                                }
                            });
                        }
                        IpcCommand::StartInstall { options } => {
                            let Some(trailer) = trailer_opt else {
                                let _ = loop_proxy.send_event(
                                    AppEvent::OperationError("安装包缺少内嵌负载".to_string()),
                                );
                                return;
                            };
                            active_busy = true;
                            let exe_clone = current_exe.clone();
                            let proxy = loop_proxy.clone();
                            std::thread::spawn(move || {
                                let started = Instant::now();
                                let mut last_emit = Instant::now() - Duration::from_millis(100);
                                let res = execute_install_pipeline(
                                    &exe_clone,
                                    &trailer,
                                    &options,
                                    true,
                                    |frac, msg| {
                                        pace_progress(started, 1.8, frac);
                                        if frac >= 1.0
                                            || last_emit.elapsed() >= Duration::from_millis(32)
                                        {
                                            last_emit = Instant::now();
                                            let _ = proxy.send_event(AppEvent::Progress {
                                                progress: frac * 100.0,
                                                status_text: msg.to_string(),
                                            });
                                        }
                                    },
                                );
                                match res {
                                    Ok(()) => {
                                        let _ = proxy.send_event(AppEvent::OperationDone {
                                            install_dir: PathBuf::from(&options.install_dir),
                                        });
                                    }
                                    Err(err) => {
                                        let _ = proxy.send_event(AppEvent::OperationError(err));
                                    }
                                }
                            });
                        }
                        IpcCommand::LaunchApp { install_dir } => {
                            match launch_installed_app(Path::new(&install_dir)) {
                                Ok(()) => {
                                    let _ = webview_opt.take();
                                    let _ = std::fs::remove_dir_all(&wv2_data_dir);
                                    *control_flow = ControlFlow::Exit;
                                }
                                Err(err) => {
                                    let _ = loop_proxy.send_event(AppEvent::OperationError(err));
                                }
                            }
                        }
                        IpcCommand::StartUninstall {
                            install_dir,
                            purge_user_data,
                        } => {
                            active_busy = true;
                            let proxy = loop_proxy.clone();
                            let dir = PathBuf::from(&install_dir);
                            std::thread::spawn(move || {
                                let started = Instant::now();
                                let res = run_uninstall(
                                    &dir,
                                    purge_user_data,
                                    true,
                                    &mut |frac, msg| {
                                        pace_progress(started, 1.4, frac);
                                        let _ = proxy.send_event(AppEvent::Progress {
                                            progress: frac * 100.0,
                                            status_text: msg.to_string(),
                                        });
                                    },
                                );
                                match res {
                                    Ok(()) => {
                                        let _ = proxy.send_event(AppEvent::OperationDone {
                                            install_dir: dir,
                                        });
                                    }
                                    Err(err) => {
                                        let _ = proxy.send_event(AppEvent::OperationError(err));
                                    }
                                }
                            });
                        }
                        IpcCommand::FinishUninstall { install_dir } => {
                            schedule_self_delete_if_inside(Path::new(&install_dir));
                            let _ = webview_opt.take();
                            let _ = std::fs::remove_dir_all(&wv2_data_dir);
                            *control_flow = ControlFlow::Exit;
                        }
                    },
                },
                _ => {}
            }
        });
    }
}

#[cfg(target_os = "windows")]
fn main() {
    std::process::exit(app::run());
}
