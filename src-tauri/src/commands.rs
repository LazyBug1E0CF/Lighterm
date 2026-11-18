use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use lighterm_core::error::{CoreError, CoreResult};
use lighterm_core::events::CoreEventSink;
use lighterm_core::models::{
    AppSettings, ConnectionTestResult, HistoryEntry, HostConfig, SessionInfo, SessionKind,
    SessionStatus, SftpEntry, SftpTransferProgress, Snippet, SystemStats,
};
use lighterm_core::ssh::connect_host;
use lighterm_core::LightermCore;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub struct AppState {
    pub core: Arc<LightermCore>,
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

    fn on_sftp_progress(&self, progress: SftpTransferProgress) {
        let _ = self.app.emit("sftp:progress", progress);
    }
}

fn sink_for(app: &AppHandle) -> Arc<dyn CoreEventSink> {
    Arc::new(TauriEventSink { app: app.clone() })
}

fn resolve_host(state: &State<'_, AppState>, host_id: &str) -> CoreResult<HostConfig> {
    state
        .core
        .storage
        .get_host(host_id)?
        .ok_or_else(|| CoreError::InvalidInput(format!("Host '{host_id}' not found")))
}

// ---- Terminal Commands ----

#[tauri::command]
pub fn terminal_create_local(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    title: Option<String>,
) -> CoreResult<SessionInfo> {
    state
        .core
        .sessions
        .create_local(cols, rows, cwd, shell, title, sink_for(&app))
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

// ---- Hosts Commands ----

#[tauri::command]
pub fn hosts_list(state: State<'_, AppState>) -> CoreResult<Vec<HostConfig>> {
    state.core.storage.list_hosts()
}

#[tauri::command]
pub fn hosts_save(state: State<'_, AppState>, host: HostConfig) -> CoreResult<HostConfig> {
    state.core.ssh_pool.invalidate(&host.id);
    state.core.sftp.invalidate(&host.id);
    state.core.storage.save_host(host)
}

#[tauri::command]
pub fn hosts_delete(state: State<'_, AppState>, id: String) -> CoreResult<()> {
    state.core.ssh_pool.invalidate(&id);
    state.core.sftp.invalidate(&id);
    state.core.storage.delete_host(&id)
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

// ---- SFTP Commands ----

#[tauri::command]
pub async fn sftp_canonicalize(
    state: State<'_, AppState>,
    host_id: String,
    path: String,
) -> CoreResult<String> {
    let host = resolve_host(&state, &host_id)?;
    state.core.sftp.canonicalize(&host, &path).await
}

#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, AppState>,
    host_id: String,
    path: String,
) -> CoreResult<Vec<SftpEntry>> {
    let host = resolve_host(&state, &host_id)?;
    state.core.sftp.list_dir(&host, &path).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    host_id: String,
    path: String,
) -> CoreResult<()> {
    let host = resolve_host(&state, &host_id)?;
    state.core.sftp.create_dir(&host, &path).await
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    host_id: String,
    path: String,
    is_dir: bool,
) -> CoreResult<()> {
    let host = resolve_host(&state, &host_id)?;
    state.core.sftp.remove_entry(&host, &path, is_dir).await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    host_id: String,
    old_path: String,
    new_path: String,
) -> CoreResult<()> {
    let host = resolve_host(&state, &host_id)?;
    state.core.sftp.rename_entry(&host, &old_path, &new_path).await
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    local_path: String,
    remote_path: String,
) -> CoreResult<()> {
    let host = resolve_host(&state, &host_id)?;
    let sink = sink_for(&app);
    state
        .core
        .sftp
        .upload_file(&host, Path::new(&local_path), &remote_path, sink.as_ref())
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
    let host = resolve_host(&state, &host_id)?;
    let sink = sink_for(&app);
    state
        .core
        .sftp
        .download_file(&host, &remote_path, Path::new(&local_path), sink.as_ref())
        .await
}

// ---- Snippets Commands ----

#[tauri::command]
pub fn snippets_list(state: State<'_, AppState>) -> CoreResult<Vec<Snippet>> {
    state.core.storage.list_snippets()
}

#[tauri::command]
pub fn snippets_save(state: State<'_, AppState>, snippet: Snippet) -> CoreResult<Snippet> {
    state.core.storage.save_snippet(snippet)
}

#[tauri::command]
pub fn snippets_delete(state: State<'_, AppState>, id: String) -> CoreResult<()> {
    state.core.storage.delete_snippet(&id)
}

// ---- History Commands ----

#[tauri::command]
pub fn history_list(
    state: State<'_, AppState>,
    query: Option<String>,
    limit: Option<usize>,
) -> CoreResult<Vec<HistoryEntry>> {
    state.core.storage.list_history(query.as_deref(), limit)
}

#[tauri::command]
pub fn history_record(
    state: State<'_, AppState>,
    command: String,
    session_kind: SessionKind,
    host_label: String,
) -> CoreResult<Option<HistoryEntry>> {
    state
        .core
        .storage
        .record_history(command, session_kind, host_label)
}

#[tauri::command]
pub fn history_delete(state: State<'_, AppState>, id: String) -> CoreResult<()> {
    state.core.storage.delete_history(&id)
}

#[tauri::command]
pub fn history_clear(state: State<'_, AppState>) -> CoreResult<()> {
    state.core.storage.clear_history()
}

// ---- Settings Commands ----

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> CoreResult<AppSettings> {
    state.core.storage.get_settings()
}

#[tauri::command]
pub fn settings_save(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> CoreResult<AppSettings> {
    state.core.storage.save_settings(settings)
}

// ---- System Monitor Commands ----

#[tauri::command]
pub async fn monitor_get_stats(
    state: State<'_, AppState>,
    kind: SessionKind,
    host_id: Option<String>,
    host_config: Option<HostConfig>,
) -> CoreResult<SystemStats> {
    match kind {
        SessionKind::Local => {
            let core = Arc::clone(&state.core);
            tokio::task::spawn_blocking(move || core.monitor.collect_local())
                .await
                .map_err(|e| CoreError::InvalidInput(format!("Monitor task panicked: {e}")))?
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
            state.core.monitor.collect_ssh(&host).await
        }
    }
}
