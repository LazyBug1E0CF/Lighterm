use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use lighterm_core::error::{CoreError, CoreResult};
use lighterm_core::events::CoreEventSink;
use lighterm_core::models::{
    AppSettings, ConnectionTestResult, HostConfig, MonitorRect, PluginInfo, SavedWorkspace,
    SessionInfo, SessionKind, SessionStatus, UpdatePreferences, WindowBounds,
};
use lighterm_core::ssh::connect_host;
use lighterm_core::updater::{
    open_external_https_url, DownloadedUpdate, UpdateAssetInfo, UpdateCheckResult,
};
use lighterm_core::LightermCore;
use lighterm_plugin_history::{HistoryEntry, HistoryPlugin};
use lighterm_plugin_monitor::{MonitorPlugin, SystemStats};
use lighterm_plugin_sftp::{SftpEntry, SftpPlugin};
use lighterm_plugin_snippets::{Snippet, SnippetsPlugin};
use lighterm_plugin_sync::{
    DiscoveredGist, GitHubSyncConfig, OAuthDeviceFlowStart, OAuthPollResult, SyncConfigUpdateInput,
    SyncConfigView, SyncOperationResult, SyncPlugin, SyncTestResult,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WindowBoundsTracker {
    pub current: Mutex<Option<WindowBounds>>,
    pub save_seq: AtomicU64,
}

pub struct AppState {
    pub core: Arc<LightermCore>,
    pub window_bounds: Arc<WindowBoundsTracker>,
}

struct TauriEventSink {
    app: AppHandle,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
    session_id: String,
    data_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    session_id: String,
    exit_code: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStatusPayload {
    session_id: String,
    status: SessionStatus,
    message: Option<String>,
}

impl CoreEventSink for TauriEventSink {
    fn on_terminal_output(&self, session_id: &str, data_base64: String) {
        let _ = self.app.emit(
            "terminal:output",
            TerminalOutputPayload {
                session_id: session_id.to_string(),
                data_base64,
            },
        );
    }

    fn on_terminal_exit(&self, session_id: &str, exit_code: Option<u32>) {
        let _ = self.app.emit(
            "terminal:exit",
            TerminalExitPayload {
                session_id: session_id.to_string(),
                exit_code,
            },
        );
    }

    fn on_terminal_status(&self, session_id: &str, status: SessionStatus, message: Option<String>) {
        let _ = self.app.emit(
            "terminal:status",
            TerminalStatusPayload {
                session_id: session_id.to_string(),
                status,
                message,
            },
        );
    }

    fn on_plugin_event(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event, payload);
    }
}

fn sink_for(app: &AppHandle) -> Arc<dyn CoreEventSink> {
    Arc::new(TauriEventSink { app: app.clone() })
}

async fn run_blocking<T, F>(on_panic: fn(String) -> CoreError, f: F) -> CoreResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CoreResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| on_panic(format!("Background task panicked: {e}")))?
}

fn resolve_host(state: &State<'_, AppState>, host_id: &str) -> CoreResult<HostConfig> {
    state
        .core
        .storage
        .get_host(host_id)?
        .ok_or_else(|| CoreError::InvalidInput(format!("Host '{host_id}' not found")))
}

// ---- Window Lifecycle Commands ----

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStatePayload {
    pub platform: &'static str,
    pub maximized: bool,
    pub focused: bool,
}

pub fn build_window_state(maximized: bool, focused: bool) -> WindowStatePayload {
    WindowStatePayload {
        platform: std::env::consts::OS,
        maximized,
        focused,
    }
}

fn apply_geometry_sample(
    tracker: &WindowBoundsTracker,
    is_minimized: bool,
    is_maximized: bool,
    pos: Option<(i32, i32)>,
    size: Option<(u32, u32)>,
) {
    if is_minimized {
        return;
    }
    let Ok(mut guard) = tracker.current.lock() else {
        return;
    };
    if is_maximized {
        if let Some(prev) = *guard {
            *guard = Some(WindowBounds {
                maximized: true,
                ..prev
            });
            return;
        }
        if let (Some((x, y)), Some((width, height))) = (pos, size) {
            let candidate = WindowBounds {
                x,
                y,
                width,
                height,
                maximized: true,
            };
            if candidate.is_sane() {
                *guard = Some(candidate);
            }
        }
        return;
    }

    if let (Some((x, y)), Some((width, height))) = (pos, size) {
        let candidate = WindowBounds {
            x,
            y,
            width,
            height,
            maximized: false,
        };
        if candidate.is_sane() {
            *guard = Some(candidate);
        }
    }
}

pub fn update_bounds_from_webview_window(
    win: &tauri::WebviewWindow,
    tracker: &WindowBoundsTracker,
) {
    let is_minimized = win.is_minimized().unwrap_or(false);
    let is_maximized = win.is_maximized().unwrap_or(false);
    let pos = win.outer_position().ok().map(|p| (p.x, p.y));
    let size = win.inner_size().ok().map(|s| (s.width, s.height));
    apply_geometry_sample(tracker, is_minimized, is_maximized, pos, size);
}

pub fn update_bounds_from_window(win: &tauri::Window, tracker: &WindowBoundsTracker) {
    let is_minimized = win.is_minimized().unwrap_or(false);
    let is_maximized = win.is_maximized().unwrap_or(false);
    let pos = win.outer_position().ok().map(|p| (p.x, p.y));
    let size = win.inner_size().ok().map(|s| (s.width, s.height));
    apply_geometry_sample(tracker, is_minimized, is_maximized, pos, size);
}

pub fn restore_window_bounds(
    win: &tauri::WebviewWindow,
    core: &LightermCore,
    tracker: &WindowBoundsTracker,
) {
    let saved = core.storage.get_window_bounds().ok().flatten();
    let monitors: Vec<MonitorRect> = win
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            MonitorRect {
                x: p.x,
                y: p.y,
                width: s.width,
                height: s.height,
            }
        })
        .collect();

    if let Some(clamped) = saved.and_then(|b| b.clamp_to_monitors(&monitors)) {
        if let Ok(mut guard) = tracker.current.lock() {
            *guard = Some(clamped);
        }
        let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
            clamped.width,
            clamped.height,
        )));
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            clamped.x, clamped.y,
        )));
        if clamped.maximized {
            let _ = win.maximize();
        }
    } else {
        update_bounds_from_webview_window(win, tracker);
    }
}

pub fn schedule_window_bounds_save(core: &Arc<LightermCore>, tracker: &Arc<WindowBoundsTracker>) {
    let seq = tracker.save_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let core = Arc::clone(core);
    let tracker = Arc::clone(tracker);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        if tracker.save_seq.load(Ordering::SeqCst) != seq {
            return;
        }
        let snapshot = tracker.current.lock().ok().and_then(|g| *g);
        if let Some(bounds) = snapshot {
            let _ = tokio::task::spawn_blocking(move || core.storage.save_window_bounds(bounds)).await;
        }
    });
}

pub fn flush_window_bounds_sync(core: &LightermCore, tracker: &WindowBoundsTracker) {
    tracker.save_seq.fetch_add(1, Ordering::SeqCst);
    let snapshot = tracker.current.lock().ok().and_then(|g| *g);
    if let Some(bounds) = snapshot {
        let _ = core.storage.save_window_bounds(bounds);
    }
}

/// Reveals and focuses the main window as soon as React commits its initial UI DOM.
#[tauri::command]
pub fn window_ready(window: tauri::Window) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// Clears the opaque startup fallback background after the first visible compositor frame.
#[tauri::command]
pub fn window_enable_transparency(window: tauri::Window, webview: tauri::Webview) {
    let _ = window.set_background_color(None);
    let _ = webview.set_background_color(Some(tauri::webview::Color(0, 0, 0, 0)));
}

#[tauri::command]
pub fn window_get_state(window: tauri::Window) -> WindowStatePayload {
    build_window_state(
        window.is_maximized().unwrap_or(false),
        window.is_focused().unwrap_or(true),
    )
}

#[tauri::command]
pub fn window_minimize(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn window_toggle_maximize(state: State<'_, AppState>, window: tauri::Window) -> bool {
    let currently_maximized = window.is_maximized().unwrap_or(false);
    if currently_maximized {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
    update_bounds_from_window(&window, &state.window_bounds);
    schedule_window_bounds_save(&state.core, &state.window_bounds);
    window.is_maximized().unwrap_or(!currently_maximized)
}

#[tauri::command]
pub fn window_close(state: State<'_, AppState>, window: tauri::Window) {
    update_bounds_from_window(&window, &state.window_bounds);
    flush_window_bounds_sync(&state.core, &state.window_bounds);
    let _ = window.close();
}

#[tauri::command]
pub fn window_start_dragging(window: tauri::Window) {
    let _ = window.start_dragging();
}

// ---- Core Shell Session Commands ----

#[tauri::command]
pub async fn terminal_create_local(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    title: Option<String>,
) -> CoreResult<SessionInfo> {
    let core = Arc::clone(&state.core);
    let sink = sink_for(&app);
    run_blocking(CoreError::PtyError, move || {
        core.sessions
            .create_local(cols, rows, cwd, shell, title, sink)
    })
    .await
}

#[tauri::command]
pub async fn terminal_create_ssh(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: Option<String>,
    host_config: Option<HostConfig>,
    cols: u16,
    rows: u16,
) -> CoreResult<SessionInfo> {
    let host = if let Some(cfg) = host_config {
        cfg
    } else if let Some(id) = host_id {
        resolve_host(&state, &id)?
    } else {
        return Err(CoreError::InvalidInput(
            "Either hostId or hostConfig is required".to_string(),
        ));
    };

    state
        .core
        .sessions
        .create_ssh(&host, cols, rows, sink_for(&app))
        .await
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data_base64: String,
) -> CoreResult<()> {
    state.core.sessions.write_base64(&session_id, &data_base64)
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> CoreResult<()> {
    state.core.sessions.resize(&session_id, cols, rows)
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, session_id: String) -> CoreResult<()> {
    state.core.sessions.close(&session_id)
}

#[tauri::command]
pub fn terminal_list(state: State<'_, AppState>) -> Vec<SessionInfo> {
    state.core.sessions.list_sessions()
}

// ---- Core Hosts Commands ----

#[tauri::command]
pub async fn hosts_list(state: State<'_, AppState>) -> CoreResult<Vec<HostConfig>> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || core.storage.list_hosts()).await
}

#[tauri::command]
pub async fn hosts_save(state: State<'_, AppState>, host: HostConfig) -> CoreResult<HostConfig> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || {
        core.ssh_pool.invalidate(&host.id);
        core.plugins.notify_host_invalidated(&host.id);
        core.storage.save_host(host)
    })
    .await
}

#[tauri::command]
pub async fn hosts_delete(state: State<'_, AppState>, id: String) -> CoreResult<()> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || {
        core.ssh_pool.invalidate(&id);
        core.plugins.notify_host_invalidated(&id);
        core.storage.delete_host(&id)
    })
    .await
}

#[tauri::command]
pub async fn hosts_test_connection(host: HostConfig) -> ConnectionTestResult {
    let start = Instant::now();
    match connect_host(&host).await {
        Ok(_) => ConnectionTestResult {
            success: true,
            latency_ms: start.elapsed().as_millis() as u64,
            message: format!("Authenticated to {}@{}:{}", host.username, host.host, host.port),
        },
        Err(err) => ConnectionTestResult {
            success: false,
            latency_ms: start.elapsed().as_millis() as u64,
            message: err.to_string(),
        },
    }
}

// ---- Core Workspaces Commands ----

#[tauri::command]
pub async fn workspaces_list(state: State<'_, AppState>) -> CoreResult<Vec<SavedWorkspace>> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || core.storage.list_workspaces()).await
}

#[tauri::command]
pub async fn workspaces_save(
    state: State<'_, AppState>,
    workspace: SavedWorkspace,
) -> CoreResult<SavedWorkspace> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || {
        core.storage.save_workspace(workspace)
    })
    .await
}

#[tauri::command]
pub async fn workspaces_delete(state: State<'_, AppState>, id: String) -> CoreResult<()> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || {
        core.storage.delete_workspace(&id)
    })
    .await
}

// ---- Core Settings Commands ----

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> CoreResult<AppSettings> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || core.storage.get_settings()).await
}

#[tauri::command]
pub async fn settings_save(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> CoreResult<AppSettings> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || {
        core.storage.save_settings(settings)
    })
    .await
}

// ---- Core Plugin Registry Commands ----

#[tauri::command]
pub fn plugins_list(state: State<'_, AppState>) -> Vec<PluginInfo> {
    state.core.plugins.list()
}

#[tauri::command]
pub async fn plugins_set_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> CoreResult<Vec<PluginInfo>> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::PluginError, move || {
        let ctx = core.context();
        core.plugins.set_enabled(&id, enabled, &ctx)
    })
    .await
}

#[tauri::command]
pub async fn plugin_configs_get_all(
    state: State<'_, AppState>,
) -> CoreResult<std::collections::HashMap<String, serde_json::Value>> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || {
        core.storage.get_all_plugin_configs()
    })
    .await
}

#[tauri::command]
pub async fn plugin_config_get(
    state: State<'_, AppState>,
    plugin_id: String,
) -> CoreResult<serde_json::Value> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || {
        core.storage.get_plugin_config(&plugin_id)
    })
    .await
}

#[tauri::command]
pub async fn plugin_config_save(
    state: State<'_, AppState>,
    plugin_id: String,
    config: serde_json::Value,
) -> CoreResult<serde_json::Value> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || {
        core.storage.save_plugin_config(&plugin_id, config)
    })
    .await
}

#[tauri::command]
pub async fn plugin_config_reset(
    state: State<'_, AppState>,
    plugin_id: String,
) -> CoreResult<()> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || {
        core.storage.reset_plugin_config(&plugin_id)
    })
    .await
}

// ---- SFTP Plugin Commands ----

#[tauri::command]
pub async fn sftp_canonicalize(
    state: State<'_, AppState>,
    host_id: String,
    path: String,
) -> CoreResult<String> {
    let sftp = state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp")?;
    let host = resolve_host(&state, &host_id)?;
    sftp.canonicalize(&host, &path).await
}

#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, AppState>,
    host_id: String,
    path: String,
) -> CoreResult<Vec<SftpEntry>> {
    let sftp = state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp")?;
    let host = resolve_host(&state, &host_id)?;
    sftp.list_dir(&host, &path).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    host_id: String,
    path: String,
) -> CoreResult<()> {
    let sftp = state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp")?;
    let host = resolve_host(&state, &host_id)?;
    sftp.create_dir(&host, &path).await
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    host_id: String,
    path: String,
    is_dir: bool,
) -> CoreResult<()> {
    let sftp = state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp")?;
    let host = resolve_host(&state, &host_id)?;
    sftp.remove_entry(&host, &path, is_dir).await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    host_id: String,
    old_path: String,
    new_path: String,
) -> CoreResult<()> {
    let sftp = state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp")?;
    let host = resolve_host(&state, &host_id)?;
    sftp.rename_entry(&host, &old_path, &new_path).await
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    local_path: String,
    remote_path: String,
) -> CoreResult<()> {
    let sftp = state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp")?;
    let host = resolve_host(&state, &host_id)?;
    let sink = sink_for(&app);
    sftp.upload_file(&host, Path::new(&local_path), &remote_path, sink.as_ref())
        .await
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    remote_path: String,
    local_path: String,
) -> CoreResult<()> {
    let sftp = state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp")?;
    let host = resolve_host(&state, &host_id)?;
    let sink = sink_for(&app);
    sftp.download_file(&host, &remote_path, Path::new(&local_path), sink.as_ref())
        .await
}

// ---- Snippets Plugin Commands ----

#[tauri::command]
pub async fn snippets_list(state: State<'_, AppState>) -> CoreResult<Vec<Snippet>> {
    let snippets = state
        .core
        .plugins
        .get_active::<SnippetsPlugin>("lighterm.snippets")?;
    run_blocking(CoreError::PluginError, move || snippets.list_snippets()).await
}

#[tauri::command]
pub async fn snippets_save(state: State<'_, AppState>, snippet: Snippet) -> CoreResult<Snippet> {
    let snippets = state
        .core
        .plugins
        .get_active::<SnippetsPlugin>("lighterm.snippets")?;
    run_blocking(CoreError::PluginError, move || snippets.save_snippet(snippet)).await
}

#[tauri::command]
pub async fn snippets_delete(state: State<'_, AppState>, id: String) -> CoreResult<()> {
    let snippets = state
        .core
        .plugins
        .get_active::<SnippetsPlugin>("lighterm.snippets")?;
    run_blocking(CoreError::PluginError, move || snippets.delete_snippet(&id)).await
}

// ---- History Plugin Commands ----

#[tauri::command]
pub async fn history_list(
    state: State<'_, AppState>,
    query: Option<String>,
    limit: Option<usize>,
) -> CoreResult<Vec<HistoryEntry>> {
    let history = state
        .core
        .plugins
        .get_active::<HistoryPlugin>("lighterm.history")?;
    run_blocking(CoreError::PluginError, move || {
        history.list_history(query.as_deref(), limit)
    })
    .await
}

#[tauri::command]
pub async fn history_record(
    state: State<'_, AppState>,
    command: String,
    session_kind: SessionKind,
    host_label: String,
) -> CoreResult<Option<HistoryEntry>> {
    let history = state
        .core
        .plugins
        .get_active::<HistoryPlugin>("lighterm.history")?;
    run_blocking(CoreError::PluginError, move || {
        history.record_history(command, session_kind, host_label)
    })
    .await
}

#[tauri::command]
pub async fn history_delete(state: State<'_, AppState>, id: String) -> CoreResult<()> {
    let history = state
        .core
        .plugins
        .get_active::<HistoryPlugin>("lighterm.history")?;
    run_blocking(CoreError::PluginError, move || history.delete_history(&id)).await
}

#[tauri::command]
pub async fn history_clear(state: State<'_, AppState>) -> CoreResult<()> {
    let history = state
        .core
        .plugins
        .get_active::<HistoryPlugin>("lighterm.history")?;
    run_blocking(CoreError::PluginError, move || history.clear_history()).await
}

// ---- Monitor Plugin Commands ----

#[tauri::command]
pub async fn monitor_get_stats(
    state: State<'_, AppState>,
    kind: SessionKind,
    host_id: Option<String>,
    host_config: Option<HostConfig>,
) -> CoreResult<SystemStats> {
    let monitor = state
        .core
        .plugins
        .get_active::<MonitorPlugin>("lighterm.monitor")?;
    match kind {
        SessionKind::Local => {
            run_blocking(CoreError::PluginError, move || monitor.collect_local()).await
        }
        SessionKind::Ssh => {
            let host = if let Some(cfg) = host_config {
                cfg
            } else if let Some(id) = host_id {
                resolve_host(&state, &id)?
            } else {
                return Err(CoreError::InvalidInput(
                    "Either hostId or hostConfig is required for SSH monitoring".to_string(),
                ));
            };
            monitor.collect_ssh(&host).await
        }
    }
}

// ---- GitHub Sync Plugin Commands ----

fn apply_sync_side_effects(core: &LightermCore, result: &SyncOperationResult) {
    for host_id in &result.invalidated_host_ids {
        core.ssh_pool.invalidate(host_id);
        core.plugins.notify_host_invalidated(host_id);
    }
    if !result.updated_plugin_states.is_empty() {
        let ctx = core.context();
        for (plugin_id, enabled) in &result.updated_plugin_states {
            if plugin_id == "lighterm.sync" {
                continue;
            }
            let _ = core.plugins.set_enabled(plugin_id, *enabled, &ctx);
        }
    }
}

#[tauri::command]
pub async fn sync_get_config(state: State<'_, AppState>) -> CoreResult<SyncConfigView> {
    let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
    run_blocking(CoreError::PluginError, move || sync.get_config_view()).await
}

#[tauri::command]
pub async fn sync_save_config(
    state: State<'_, AppState>,
    input: SyncConfigUpdateInput,
) -> CoreResult<SyncConfigView> {
    let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
    run_blocking(CoreError::PluginError, move || sync.save_config(input)).await
}

#[tauri::command]
pub async fn sync_reset_state(state: State<'_, AppState>) -> CoreResult<SyncConfigView> {
    let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
    run_blocking(CoreError::PluginError, move || sync.reset_local_state()).await
}

#[tauri::command]
pub async fn sync_oauth_start(
    state: State<'_, AppState>,
    config_override: Option<GitHubSyncConfig>,
    open_browser: Option<bool>,
) -> CoreResult<OAuthDeviceFlowStart> {
    let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
    sync.start_oauth_device_flow(config_override, open_browser.unwrap_or(true))
        .await
}

#[tauri::command]
pub async fn sync_oauth_poll(
    state: State<'_, AppState>,
    flow_id: String,
) -> CoreResult<OAuthPollResult> {
    let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
    sync.poll_oauth_device_flow(&flow_id).await
}

#[tauri::command]
pub async fn sync_oauth_cancel(state: State<'_, AppState>, flow_id: String) -> CoreResult<()> {
    let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
    run_blocking(CoreError::PluginError, move || {
        sync.cancel_oauth_device_flow(&flow_id)
    })
    .await
}

#[tauri::command]
pub async fn sync_oauth_logout(state: State<'_, AppState>) -> CoreResult<SyncConfigView> {
    let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
    run_blocking(CoreError::PluginError, move || sync.logout_oauth()).await
}

#[tauri::command]
pub async fn sync_open_verification_url(
    state: State<'_, AppState>,
    url: String,
) -> CoreResult<()> {
    let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
    run_blocking(CoreError::PluginError, move || sync.open_verification_url(&url)).await
}

#[tauri::command]
pub async fn sync_test_connection(
    state: State<'_, AppState>,
    config_override: Option<GitHubSyncConfig>,
) -> CoreResult<SyncTestResult> {
    let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
    sync.test_connection(config_override).await
}

#[tauri::command]
pub async fn sync_discover_gists(
    state: State<'_, AppState>,
    api_base_url: Option<String>,
    file_name: Option<String>,
) -> CoreResult<Vec<DiscoveredGist>> {
    let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
    sync.discover_gists(api_base_url, file_name).await
}

#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>) -> CoreResult<SyncOperationResult> {
    let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
    let result = sync.sync_now().await?;
    apply_sync_side_effects(&state.core, &result);
    Ok(result)
}

#[tauri::command]
pub async fn sync_push(state: State<'_, AppState>) -> CoreResult<SyncOperationResult> {
    let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
    sync.push().await
}

#[tauri::command]
pub async fn sync_pull(state: State<'_, AppState>) -> CoreResult<SyncOperationResult> {
    let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
    let result = sync.pull().await?;
    apply_sync_side_effects(&state.core, &result);
    Ok(result)
}

// ---- App Updater Commands ----

fn resolve_desktop_app_version(app: &AppHandle) -> String {
    std::env::var("LIGHTERM_APP_VERSION")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| app.package_info().version.to_string())
}

#[tauri::command]
pub async fn updater_get_state(state: State<'_, AppState>) -> CoreResult<UpdatePreferences> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || {
        core.storage.get_update_preferences()
    })
    .await
}

#[tauri::command]
pub async fn updater_save_preferences(
    state: State<'_, AppState>,
    preferences: UpdatePreferences,
) -> CoreResult<UpdatePreferences> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::StorageError, move || {
        core.storage.save_update_preferences(preferences)
    })
    .await
}

#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CoreResult<UpdateCheckResult> {
    let current_version = resolve_desktop_app_version(&app);
    state
        .core
        .updater
        .check_for_updates(&current_version, true)
        .await
}

#[tauri::command]
pub async fn updater_download(
    app: AppHandle,
    state: State<'_, AppState>,
    download_id: String,
    version: String,
    asset: UpdateAssetInfo,
) -> CoreResult<DownloadedUpdate> {
    let sink = sink_for(&app);
    state
        .core
        .updater
        .download_update(download_id, version, asset, sink)
        .await
}

#[tauri::command]
pub fn updater_cancel_download(
    state: State<'_, AppState>,
    download_id: Option<String>,
) -> CoreResult<()> {
    state.core.updater.cancel_download(download_id.as_deref());
    Ok(())
}

#[tauri::command]
pub async fn updater_install(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
) -> CoreResult<()> {
    let core = Arc::clone(&state.core);
    run_blocking(CoreError::PluginError, move || {
        core.updater.install_downloaded_update(&file_path)
    })
    .await?;

    flush_window_bounds_sync(&state.core, &state.window_bounds);

    #[cfg(target_os = "windows")]
    {
        let exit_app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            exit_app.exit(0);
        });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;

    Ok(())
}

#[tauri::command]
pub async fn updater_open_url(url: String) -> CoreResult<()> {
    run_blocking(CoreError::PluginError, move || open_external_https_url(&url)).await
}
