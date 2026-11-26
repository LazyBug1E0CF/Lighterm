use std::path::PathBuf;
use std::sync::Arc;

use lighterm_core::error::CoreResult;
use lighterm_core::events::CoreEventSink;
use lighterm_core::models::{SessionKind, SessionStatus};
use lighterm_core::LightermCore;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::auth::{AuthConfig, AuthManager};

pub const WEB_SETTINGS_FILE: &str = "web-settings.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebAppSettings {
    #[serde(default)]
    pub allow_local_shell: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsServerEvent {
    pub event: String,
    pub payload: serde_json::Value,
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

pub struct WebEventSink {
    tx: broadcast::Sender<WsServerEvent>,
}

impl WebEventSink {
    pub fn new(tx: broadcast::Sender<WsServerEvent>) -> Self {
        Self { tx }
    }
}

impl CoreEventSink for WebEventSink {
    fn on_terminal_output(&self, session_id: &str, data_base64: String) {
        if let Ok(payload) = serde_json::to_value(TerminalOutputPayload {
            session_id: session_id.to_string(),
            data_base64,
        }) {
            let _ = self.tx.send(WsServerEvent {
                event: "terminal:output".to_string(),
                payload,
            });
        }
    }

    fn on_terminal_exit(&self, session_id: &str, exit_code: Option<u32>) {
        if let Ok(payload) = serde_json::to_value(TerminalExitPayload {
            session_id: session_id.to_string(),
            exit_code,
        }) {
            let _ = self.tx.send(WsServerEvent {
                event: "terminal:exit".to_string(),
                payload,
            });
        }
    }

    fn on_terminal_status(&self, session_id: &str, status: SessionStatus, message: Option<String>) {
        if let Ok(payload) = serde_json::to_value(TerminalStatusPayload {
            session_id: session_id.to_string(),
            status,
            message,
        }) {
            let _ = self.tx.send(WsServerEvent {
                event: "terminal:status".to_string(),
                payload,
            });
        }
    }

    fn on_plugin_event(&self, event: &str, payload: serde_json::Value) {
        let _ = self.tx.send(WsServerEvent {
            event: event.to_string(),
            payload,
        });
    }
}

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub bind: String,
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    pub auth: AuthConfig,
}

pub struct ServerState {
    pub core: Arc<LightermCore>,
    pub event_tx: broadcast::Sender<WsServerEvent>,
    pub event_sink: Arc<dyn CoreEventSink>,
    pub auth: Arc<AuthManager>,
    pub static_dir: PathBuf,
    pub web_settings: RwLock<WebAppSettings>,
}

impl ServerState {
    pub fn new(core: Arc<LightermCore>, config: &ServerConfig) -> Self {
        let (event_tx, _) = broadcast::channel(4096);
        let event_sink: Arc<dyn CoreEventSink> = Arc::new(WebEventSink::new(event_tx.clone()));
        let auth = Arc::new(AuthManager::new(config.auth.clone()));
        let initial_web_settings = core
            .storage
            .read_plugin_json::<WebAppSettings>(WEB_SETTINGS_FILE)
            .unwrap_or_default();
        Self {
            core,
            event_tx,
            event_sink,
            auth,
            static_dir: config.static_dir.clone(),
            web_settings: RwLock::new(initial_web_settings),
        }
    }

    pub fn web_settings(&self) -> WebAppSettings {
        self.web_settings.read().clone()
    }

    pub fn is_local_shell_enabled(&self) -> bool {
        self.web_settings.read().allow_local_shell
    }

    pub fn save_web_settings(&self, next: WebAppSettings) -> CoreResult<WebAppSettings> {
        self.core
            .storage
            .write_plugin_json(WEB_SETTINGS_FILE, &next, false)?;
        *self.web_settings.write() = next.clone();
        if !next.allow_local_shell {
            for session in self.core.sessions.list_sessions() {
                if session.kind == SessionKind::Local {
                    let _ = self.core.sessions.close(&session.id);
                }
            }
        }
        Ok(next)
    }
}
