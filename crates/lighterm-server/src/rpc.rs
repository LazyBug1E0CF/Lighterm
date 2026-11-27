use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use bytes::Bytes;
use lighterm_core::error::{CoreError, CoreResult};
use lighterm_core::models::{
    AppSettings, ConnectionTestResult, HostConfig, RecentHostEntry, SavedWorkspace, SessionKind,
    UpdatePreferences,
};
use lighterm_core::ssh::connect_host;
use lighterm_core::LightermCore;
use lighterm_plugin_history::HistoryPlugin;
use lighterm_plugin_monitor::MonitorPlugin;
use lighterm_plugin_sftp::SftpPlugin;
use lighterm_plugin_snippets::SnippetsPlugin;
use lighterm_plugin_sync::{
    GitHubSyncConfig, SyncConfigUpdateInput, SyncOperationResult, SyncPlugin,
};
use serde::de::DeserializeOwned;
use serde::Deserialize;

use crate::auth::require_auth_response;
use crate::state::{ServerState, WebAppSettings};

pub fn core_error_response(err: CoreError) -> Response {
    let status = match &err {
        CoreError::InvalidInput(_) => StatusCode::BAD_REQUEST,
        // Never return 401 here so SSH/GitHub auth errors don't trigger Web UI session logout.
        CoreError::AuthFailed(_) => StatusCode::UNPROCESSABLE_ENTITY,
        CoreError::SessionNotFound(_) => StatusCode::NOT_FOUND,
        CoreError::PluginDisabled(_) => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, Json(&err)).into_response()
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

fn parse_args<T: DeserializeOwned>(raw: &serde_json::Value) -> CoreResult<T> {
    serde_json::from_value(raw.clone())
        .map_err(|e| CoreError::InvalidInput(format!("Invalid RPC arguments: {e}")))
}

fn resolve_host(core: &LightermCore, host_id: &str) -> CoreResult<HostConfig> {
    core.storage
        .get_host(host_id)?
        .ok_or_else(|| CoreError::InvalidInput(format!("Host '{host_id}' not found")))
}

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateLocalArgs {
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    title: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSshArgs {
    host_id: Option<String>,
    host_config: Option<HostConfig>,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalWriteArgs {
    session_id: String,
    data_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResizeArgs {
    session_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdArgs {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostArgs {
    host: HostConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveRecentHostsArgs {
    entries: Vec<RecentHostEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceArgs {
    workspace: SavedWorkspace,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsArgs {
    settings: AppSettings,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSettingsSaveArgs {
    settings: WebAppSettings,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginSetEnabledArgs {
    id: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginIdArgs {
    plugin_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginConfigSaveArgs {
    plugin_id: String,
    config: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SftpPathArgs {
    host_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SftpRemoveArgs {
    host_id: String,
    path: String,
    is_dir: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SftpRenameArgs {
    host_id: String,
    old_path: String,
    new_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnippetArgs {
    snippet: lighterm_plugin_snippets::Snippet,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryListArgs {
    query: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryRecordArgs {
    command: String,
    session_kind: SessionKind,
    host_label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonitorStatsArgs {
    kind: SessionKind,
    host_id: Option<String>,
    host_config: Option<HostConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncSaveConfigArgs {
    input: SyncConfigUpdateInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncOAuthStartArgs {
    config_override: Option<GitHubSyncConfig>,
    #[allow(dead_code)]
    open_browser: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlowIdArgs {
    flow_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncTestArgs {
    config_override: Option<GitHubSyncConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncDiscoverGistsArgs {
    api_base_url: Option<String>,
    file_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncOpenUrlArgs {
    #[allow(dead_code)]
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterSavePrefsArgs {
    preferences: UpdatePreferences,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterOpenUrlArgs {
    #[allow(dead_code)]
    url: String,
}

pub async fn rpc_handler(
    State(state): State<Arc<ServerState>>,
    Path(command): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !state.auth.is_authenticated(&headers) {
        return require_auth_response();
    }

    let raw_args: serde_json::Value = if body.is_empty() {
        serde_json::Value::Object(Default::default())
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => {
                return core_error_response(CoreError::InvalidInput(format!(
                    "Invalid JSON body: {e}"
                )));
            }
        }
    };

    match dispatch_rpc(&state, &command, &raw_args).await {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(err) => core_error_response(err),
    }
}

async fn dispatch_rpc(
    state: &Arc<ServerState>,
    command: &str,
    raw_args: &serde_json::Value,
) -> CoreResult<serde_json::Value> {
    match command {
        // ---- Terminal Sessions ----
        "terminal_create_local" => {
            if !state.is_local_shell_enabled() {
                return Err(CoreError::InvalidInput(
                    "Local shell is disabled. Enable 'Allow Local Shell' in Settings -> Web App."
                        .to_string(),
                ));
            }
            let args: CreateLocalArgs = parse_args(raw_args)?;
            let core = Arc::clone(&state.core);
            let sink = Arc::clone(&state.event_sink);
            let info = run_blocking(CoreError::PtyError, move || {
                let resolved_shell = args
                    .shell
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        core.storage
                            .get_settings()
                            .ok()
                            .and_then(|s| {
                                lighterm_core::pty::resolve_configured_default_shell(
                                    s.default_local_shell.as_deref(),
                                )
                            })
                    });
                core.sessions.create_local(
                    args.cols,
                    args.rows,
                    args.cwd,
                    resolved_shell,
                    args.title,
                    sink,
                )
            })
            .await?;
            Ok(serde_json::to_value(info).map_err(|e| CoreError::PtyError(e.to_string()))?)
        }
        "terminal_create_ssh" => {
            let args: CreateSshArgs = parse_args(raw_args)?;
            let host = if let Some(cfg) = args.host_config {
                cfg
            } else if let Some(id) = args.host_id {
                resolve_host(&state.core, &id)?
            } else {
                return Err(CoreError::InvalidInput(
                    "Either hostId or hostConfig is required".to_string(),
                ));
            };
            let info = state
                .core
                .sessions
                .create_ssh(&host, args.cols, args.rows, Arc::clone(&state.event_sink))
                .await?;
            Ok(serde_json::to_value(info).map_err(|e| CoreError::SshError(e.to_string()))?)
        }
        "terminal_write" => {
            let args: TerminalWriteArgs = parse_args(raw_args)?;
            state
                .core
                .sessions
                .write_base64(&args.session_id, &args.data_base64)?;
            Ok(serde_json::Value::Null)
        }
        "terminal_resize" => {
            let args: TerminalResizeArgs = parse_args(raw_args)?;
            state
                .core
                .sessions
                .resize(&args.session_id, args.cols, args.rows)?;
            Ok(serde_json::Value::Null)
        }
        "terminal_close" => {
            let args: SessionIdArgs = parse_args(raw_args)?;
            state.core.sessions.close(&args.session_id)?;
            Ok(serde_json::Value::Null)
        }
        "terminal_list" => {
            let list = state.core.sessions.list_sessions();
            Ok(serde_json::to_value(list).map_err(|e| CoreError::PtyError(e.to_string()))?)
        }
        "terminal_list_local_shells" => {
            if !state.is_local_shell_enabled() {
                return Ok(serde_json::json!([]));
            }
            let shells = run_blocking(CoreError::PtyError, || {
                Ok(lighterm_core::pty::detect_local_shells())
            })
            .await?;
            Ok(serde_json::to_value(shells).map_err(|e| CoreError::PtyError(e.to_string()))?)
        }

        // ---- Hosts ----
        "hosts_list" => {
            let core = Arc::clone(&state.core);
            let hosts = run_blocking(CoreError::StorageError, move || core.storage.list_hosts()).await?;
            Ok(serde_json::to_value(hosts).map_err(|e| CoreError::StorageError(e.to_string()))?)
        }
        "hosts_save" => {
            let args: HostArgs = parse_args(raw_args)?;
            let core = Arc::clone(&state.core);
            let saved = run_blocking(CoreError::StorageError, move || {
                core.ssh_pool.invalidate(&args.host.id);
                core.plugins.notify_host_invalidated(&args.host.id);
                core.storage.save_host(args.host)
            })
            .await?;
            Ok(serde_json::to_value(saved).map_err(|e| CoreError::StorageError(e.to_string()))?)
        }
        "hosts_delete" => {
            let args: IdArgs = parse_args(raw_args)?;
            let core = Arc::clone(&state.core);
            run_blocking(CoreError::StorageError, move || {
                core.ssh_pool.invalidate(&args.id);
                core.plugins.notify_host_invalidated(&args.id);
                core.storage.delete_host(&args.id)
            })
            .await?;
            Ok(serde_json::Value::Null)
        }
        "hosts_test_connection" => {
            let args: HostArgs = parse_args(raw_args)?;
            let start = Instant::now();
            let res = match connect_host(&args.host).await {
                Ok(_) => ConnectionTestResult {
                    success: true,
                    latency_ms: start.elapsed().as_millis() as u64,
                    message: format!(
                        "Authenticated to {}@{}:{}",
                        args.host.username, args.host.host, args.host.port
                    ),
                },
                Err(err) => ConnectionTestResult {
                    success: false,
                    latency_ms: start.elapsed().as_millis() as u64,
                    message: err.to_string(),
                },
            };
            Ok(serde_json::to_value(res).map_err(|e| CoreError::SshError(e.to_string()))?)
        }
        "recent_hosts_list" => {
            let core = Arc::clone(&state.core);
            let list =
                run_blocking(CoreError::StorageError, move || core.storage.list_recent_hosts())
                    .await?;
            Ok(serde_json::to_value(list).map_err(|e| CoreError::StorageError(e.to_string()))?)
        }
        "recent_hosts_save" => {
            let args: SaveRecentHostsArgs = parse_args(raw_args)?;
            let core = Arc::clone(&state.core);
            let saved = run_blocking(CoreError::StorageError, move || {
                core.storage.save_recent_hosts(args.entries)
            })
            .await?;
            Ok(serde_json::to_value(saved).map_err(|e| CoreError::StorageError(e.to_string()))?)
        }

        // ---- Workspaces ----
        "workspaces_list" => {
            let core = Arc::clone(&state.core);
            let list =
                run_blocking(CoreError::StorageError, move || core.storage.list_workspaces()).await?;
            Ok(serde_json::to_value(list).map_err(|e| CoreError::StorageError(e.to_string()))?)
        }
        "workspaces_save" => {
            let args: WorkspaceArgs = parse_args(raw_args)?;
            let core = Arc::clone(&state.core);
            let saved = run_blocking(CoreError::StorageError, move || {
                core.storage.save_workspace(args.workspace)
            })
            .await?;
            Ok(serde_json::to_value(saved).map_err(|e| CoreError::StorageError(e.to_string()))?)
        }
        "workspaces_delete" => {
            let args: IdArgs = parse_args(raw_args)?;
            let core = Arc::clone(&state.core);
            run_blocking(CoreError::StorageError, move || {
                core.storage.delete_workspace(&args.id)
            })
            .await?;
            Ok(serde_json::Value::Null)
        }

        // ---- Settings ----
        "settings_get" => {
            let core = Arc::clone(&state.core);
            let settings =
                run_blocking(CoreError::StorageError, move || core.storage.get_settings()).await?;
            Ok(serde_json::to_value(settings).map_err(|e| CoreError::StorageError(e.to_string()))?)
        }
        "settings_save" => {
            let args: SettingsArgs = parse_args(raw_args)?;
            let core = Arc::clone(&state.core);
            let saved = run_blocking(CoreError::StorageError, move || {
                core.storage.save_settings(args.settings)
            })
            .await?;
            Ok(serde_json::to_value(saved).map_err(|e| CoreError::StorageError(e.to_string()))?)
        }

        // ---- Web App Settings ----
        "web_settings_get" => {
            let settings = state.web_settings();
            Ok(serde_json::to_value(settings)
                .map_err(|e| CoreError::StorageError(e.to_string()))?)
        }
        "web_settings_save" => {
            let args: WebSettingsSaveArgs = parse_args(raw_args)?;
            let state_clone = Arc::clone(state);
            let saved = run_blocking(CoreError::StorageError, move || {
                state_clone.save_web_settings(args.settings)
            })
            .await?;
            Ok(serde_json::to_value(saved)
                .map_err(|e| CoreError::StorageError(e.to_string()))?)
        }

        // ---- Plugins ----
        "plugins_list" => {
            let list = state.core.plugins.list();
            Ok(serde_json::to_value(list).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "plugins_set_enabled" => {
            let args: PluginSetEnabledArgs = parse_args(raw_args)?;
            let core = Arc::clone(&state.core);
            let list = run_blocking(CoreError::PluginError, move || {
                let ctx = core.context();
                core.plugins.set_enabled(&args.id, args.enabled, &ctx)
            })
            .await?;
            Ok(serde_json::to_value(list).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "plugin_configs_get_all" => {
            let core = Arc::clone(&state.core);
            let map = run_blocking(CoreError::StorageError, move || {
                core.storage.get_all_plugin_configs()
            })
            .await?;
            Ok(serde_json::to_value(map).map_err(|e| CoreError::StorageError(e.to_string()))?)
        }
        "plugin_config_get" => {
            let args: PluginIdArgs = parse_args(raw_args)?;
            let core = Arc::clone(&state.core);
            let cfg = run_blocking(CoreError::StorageError, move || {
                core.storage.get_plugin_config(&args.plugin_id)
            })
            .await?;
            Ok(cfg)
        }
        "plugin_config_save" => {
            let args: PluginConfigSaveArgs = parse_args(raw_args)?;
            let core = Arc::clone(&state.core);
            let saved = run_blocking(CoreError::StorageError, move || {
                core.storage.save_plugin_config(&args.plugin_id, args.config)
            })
            .await?;
            Ok(saved)
        }
        "plugin_config_reset" => {
            let args: PluginIdArgs = parse_args(raw_args)?;
            let core = Arc::clone(&state.core);
            run_blocking(CoreError::StorageError, move || {
                core.storage.reset_plugin_config(&args.plugin_id)
            })
            .await?;
            Ok(serde_json::Value::Null)
        }

        // ---- SFTP (directory/metadata operations; transfers use /api/sftp/upload & /api/sftp/download) ----
        "sftp_canonicalize" => {
            let args: SftpPathArgs = parse_args(raw_args)?;
            let sftp = state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp")?;
            let host = resolve_host(&state.core, &args.host_id)?;
            let resolved = sftp.canonicalize(&host, &args.path).await?;
            Ok(serde_json::Value::String(resolved))
        }
        "sftp_list_dir" => {
            let args: SftpPathArgs = parse_args(raw_args)?;
            let sftp = state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp")?;
            let host = resolve_host(&state.core, &args.host_id)?;
            let entries = sftp.list_dir(&host, &args.path).await?;
            Ok(serde_json::to_value(entries).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "sftp_mkdir" => {
            let args: SftpPathArgs = parse_args(raw_args)?;
            let sftp = state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp")?;
            let host = resolve_host(&state.core, &args.host_id)?;
            sftp.create_dir(&host, &args.path).await?;
            Ok(serde_json::Value::Null)
        }
        "sftp_remove" => {
            let args: SftpRemoveArgs = parse_args(raw_args)?;
            let sftp = state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp")?;
            let host = resolve_host(&state.core, &args.host_id)?;
            sftp.remove_entry(&host, &args.path, args.is_dir).await?;
            Ok(serde_json::Value::Null)
        }
        "sftp_rename" => {
            let args: SftpRenameArgs = parse_args(raw_args)?;
            let sftp = state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp")?;
            let host = resolve_host(&state.core, &args.host_id)?;
            sftp.rename_entry(&host, &args.old_path, &args.new_path)
                .await?;
            Ok(serde_json::Value::Null)
        }
        "sftp_upload" | "sftp_download" => Err(CoreError::InvalidInput(
            "Use streaming HTTP endpoints /api/sftp/upload and /api/sftp/download in web mode"
                .to_string(),
        )),

        // ---- Snippets ----
        "snippets_list" => {
            let snippets = state
                .core
                .plugins
                .get_active::<SnippetsPlugin>("lighterm.snippets")?;
            let list =
                run_blocking(CoreError::PluginError, move || snippets.list_snippets()).await?;
            Ok(serde_json::to_value(list).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "snippets_save" => {
            let args: SnippetArgs = parse_args(raw_args)?;
            let snippets = state
                .core
                .plugins
                .get_active::<SnippetsPlugin>("lighterm.snippets")?;
            let saved = run_blocking(CoreError::PluginError, move || {
                snippets.save_snippet(args.snippet)
            })
            .await?;
            Ok(serde_json::to_value(saved).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "snippets_delete" => {
            let args: IdArgs = parse_args(raw_args)?;
            let snippets = state
                .core
                .plugins
                .get_active::<SnippetsPlugin>("lighterm.snippets")?;
            run_blocking(CoreError::PluginError, move || {
                snippets.delete_snippet(&args.id)
            })
            .await?;
            Ok(serde_json::Value::Null)
        }

        // ---- History ----
        "history_list" => {
            let args: HistoryListArgs = parse_args(raw_args)?;
            let history = state
                .core
                .plugins
                .get_active::<HistoryPlugin>("lighterm.history")?;
            let list = run_blocking(CoreError::PluginError, move || {
                history.list_history(args.query.as_deref(), args.limit)
            })
            .await?;
            Ok(serde_json::to_value(list).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "history_record" => {
            let args: HistoryRecordArgs = parse_args(raw_args)?;
            let history = state
                .core
                .plugins
                .get_active::<HistoryPlugin>("lighterm.history")?;
            let saved = run_blocking(CoreError::PluginError, move || {
                history.record_history(args.command, args.session_kind, args.host_label)
            })
            .await?;
            Ok(serde_json::to_value(saved).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "history_delete" => {
            let args: IdArgs = parse_args(raw_args)?;
            let history = state
                .core
                .plugins
                .get_active::<HistoryPlugin>("lighterm.history")?;
            run_blocking(CoreError::PluginError, move || {
                history.delete_history(&args.id)
            })
            .await?;
            Ok(serde_json::Value::Null)
        }
        "history_clear" => {
            let history = state
                .core
                .plugins
                .get_active::<HistoryPlugin>("lighterm.history")?;
            run_blocking(CoreError::PluginError, move || history.clear_history()).await?;
            Ok(serde_json::Value::Null)
        }

        // ---- Monitor ----
        "monitor_get_stats" => {
            let args: MonitorStatsArgs = parse_args(raw_args)?;
            let monitor = state
                .core
                .plugins
                .get_active::<MonitorPlugin>("lighterm.monitor")?;
            let stats = match args.kind {
                SessionKind::Local => {
                    run_blocking(CoreError::PluginError, move || monitor.collect_local()).await?
                }
                SessionKind::Ssh => {
                    let host = if let Some(cfg) = args.host_config {
                        cfg
                    } else if let Some(id) = args.host_id {
                        resolve_host(&state.core, &id)?
                    } else {
                        return Err(CoreError::InvalidInput(
                            "Either hostId or hostConfig is required for SSH monitoring"
                                .to_string(),
                        ));
                    };
                    monitor.collect_ssh(&host).await?
                }
            };
            Ok(serde_json::to_value(stats).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }

        // ---- GitHub Sync ----
        "sync_get_config" => {
            let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
            let view =
                run_blocking(CoreError::PluginError, move || sync.get_config_view()).await?;
            Ok(serde_json::to_value(view).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "sync_save_config" => {
            let args: SyncSaveConfigArgs = parse_args(raw_args)?;
            let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
            let view = run_blocking(CoreError::PluginError, move || {
                sync.save_config(args.input)
            })
            .await?;
            Ok(serde_json::to_value(view).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "sync_reset_state" => {
            let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
            let view =
                run_blocking(CoreError::PluginError, move || sync.reset_local_state()).await?;
            Ok(serde_json::to_value(view).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "sync_oauth_start" => {
            let args: SyncOAuthStartArgs = parse_args(raw_args)?;
            let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
            // Headless server must never attempt xdg-open; client opens the URL in browser.
            let flow = sync
                .start_oauth_device_flow(args.config_override, false)
                .await?;
            Ok(serde_json::to_value(flow).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "sync_oauth_poll" => {
            let args: FlowIdArgs = parse_args(raw_args)?;
            let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
            let res = sync.poll_oauth_device_flow(&args.flow_id).await?;
            Ok(serde_json::to_value(res).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "sync_oauth_cancel" => {
            let args: FlowIdArgs = parse_args(raw_args)?;
            let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
            run_blocking(CoreError::PluginError, move || {
                sync.cancel_oauth_device_flow(&args.flow_id)
            })
            .await?;
            Ok(serde_json::Value::Null)
        }
        "sync_oauth_logout" => {
            let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
            let view =
                run_blocking(CoreError::PluginError, move || sync.logout_oauth()).await?;
            Ok(serde_json::to_value(view).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "sync_open_verification_url" => {
            let _args: SyncOpenUrlArgs = parse_args(raw_args)?;
            Ok(serde_json::Value::Null)
        }
        "sync_test_connection" => {
            let args: SyncTestArgs = parse_args(raw_args)?;
            let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
            let res = sync.test_connection(args.config_override).await?;
            Ok(serde_json::to_value(res).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "sync_discover_gists" => {
            let args: SyncDiscoverGistsArgs = parse_args(raw_args)?;
            let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
            let gists = sync
                .discover_gists(args.api_base_url, args.file_name)
                .await?;
            Ok(serde_json::to_value(gists).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "sync_now" => {
            let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
            let result = sync.sync_now().await?;
            apply_sync_side_effects(&state.core, &result);
            Ok(serde_json::to_value(result).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "sync_push" => {
            let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
            let result = sync.push().await?;
            Ok(serde_json::to_value(result).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "sync_pull" => {
            let sync = state.core.plugins.get_active::<SyncPlugin>("lighterm.sync")?;
            let result = sync.pull().await?;
            apply_sync_side_effects(&state.core, &result);
            Ok(serde_json::to_value(result).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }

        "updater_get_state" => {
            let core = Arc::clone(&state.core);
            let prefs = run_blocking(CoreError::StorageError, move || {
                core.storage.get_update_preferences()
            })
            .await?;
            Ok(serde_json::to_value(prefs).map_err(|e| CoreError::StorageError(e.to_string()))?)
        }
        "updater_save_preferences" => {
            let args: UpdaterSavePrefsArgs = parse_args(raw_args)?;
            let core = Arc::clone(&state.core);
            let saved = run_blocking(CoreError::StorageError, move || {
                core.storage.save_update_preferences(args.preferences)
            })
            .await?;
            Ok(serde_json::to_value(saved).map_err(|e| CoreError::StorageError(e.to_string()))?)
        }
        "updater_check" => {
            let current_version = std::env::var("LIGHTERM_APP_VERSION")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
            let res = state
                .core
                .updater
                .check_for_updates(&current_version, false)
                .await?;
            Ok(serde_json::to_value(res).map_err(|e| CoreError::PluginError(e.to_string()))?)
        }
        "updater_open_url" => {
            let _args: UpdaterOpenUrlArgs = parse_args(raw_args)?;
            Ok(serde_json::Value::Null)
        }
        "updater_download" | "updater_cancel_download" | "updater_install" => {
            Err(CoreError::InvalidInput(
                "Automatic installer download is only supported in the desktop app".to_string(),
            ))
        }

        _ => Err(CoreError::InvalidInput(format!(
            "Unknown RPC command '{command}'"
        ))),
    }
}
