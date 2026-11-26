pub mod auth;
pub mod rpc;
pub mod sftp_http;
pub mod state;
pub mod ws;

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use lighterm_core::error::CoreResult;
use lighterm_core::LightermCore;
use lighterm_plugin_history::HistoryPlugin;
use lighterm_plugin_monitor::MonitorPlugin;
use lighterm_plugin_sftp::SftpPlugin;
use lighterm_plugin_snippets::SnippetsPlugin;
use lighterm_plugin_sync::SyncPlugin;
use serde::Serialize;
use tower_http::services::ServeDir;

use crate::auth::{auth_login_handler, auth_logout_handler, auth_status_handler};
use crate::rpc::rpc_handler;
use crate::sftp_http::{sftp_download_handler, sftp_upload_handler};
use crate::state::ServerState;
use crate::ws::ws_handler;

pub fn init_core(data_dir: PathBuf) -> CoreResult<Arc<LightermCore>> {
    let core = Arc::new(LightermCore::with_data_dir(data_dir)?);
    core.register_plugin(Arc::new(SftpPlugin::new()))?;
    core.register_plugin(Arc::new(MonitorPlugin::new()))?;
    core.register_plugin(Arc::new(SnippetsPlugin::new()))?;
    core.register_plugin(Arc::new(HistoryPlugin::new()))?;
    core.register_plugin(Arc::new(SyncPlugin::new()))?;
    Ok(core)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
}

async fn health_handler() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WebBootstrapPayload {
    mode: &'static str,
    version: &'static str,
    auth_required: bool,
    username_required: bool,
    authenticated: bool,
    local_shell_enabled: bool,
}

pub fn inject_web_bootstrap(html: &str, state: &ServerState, headers: &HeaderMap) -> String {
    let payload = WebBootstrapPayload {
        mode: "web",
        version: env!("CARGO_PKG_VERSION"),
        auth_required: state.auth.is_enabled(),
        username_required: state.auth.username_required(),
        authenticated: state.auth.is_authenticated(headers),
        local_shell_enabled: state.is_local_shell_enabled(),
    };

    let json = serde_json::to_string(&payload)
        .unwrap_or_else(|_| "{\"mode\":\"web\"}".to_string())
        .replace("</", "<\\/");
    let script = format!("<script>window.__LIGHTERM_WEB__={json};</script>");

    if let Some(idx) = html.find("</head>") {
        let mut out = String::with_capacity(html.len() + script.len() + 1);
        out.push_str(&html[..idx]);
        out.push_str(&script);
        out.push_str(&html[idx..]);
        out
    } else {
        format!("{script}{html}")
    }
}

async fn serve_index(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    let index_path = state.static_dir.join("index.html");
    let raw = match tokio::fs::read_to_string(&index_path).await {
        Ok(content) => content,
        Err(err) => {
            return (
                StatusCode::NOT_FOUND,
                format!(
                    "Frontend dist/index.html not found at '{}': {err}. Build the frontend with 'pnpm run build' or set LIGHTERM_STATIC_DIR.",
                    index_path.display()
                ),
            )
                .into_response();
        }
    };

    let injected = inject_web_bootstrap(&raw, &state, &headers);
    let mut resp = Html(injected).into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    resp
}

async fn security_headers_middleware(req: Request, next: Next) -> Response {
    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();
    headers
        .entry(header::HeaderName::from_static("x-content-type-options"))
        .or_insert_with(|| HeaderValue::from_static("nosniff"));
    headers
        .entry(header::HeaderName::from_static("referrer-policy"))
        .or_insert_with(|| HeaderValue::from_static("same-origin"));
    headers
        .entry(header::HeaderName::from_static("x-frame-options"))
        .or_insert_with(|| HeaderValue::from_static("SAMEORIGIN"));
    resp
}

pub fn build_router(state: Arc<ServerState>) -> Router {
    let static_service = ServeDir::new(&state.static_dir).append_index_html_on_directories(false);

    Router::new()
        .route("/", get(serve_index))
        .route("/index.html", get(serve_index))
        .route("/api/health", get(health_handler))
        .route("/api/auth/status", get(auth_status_handler))
        .route("/api/auth/login", post(auth_login_handler))
        .route("/api/auth/logout", post(auth_logout_handler))
        .route("/api/rpc/{command}", post(rpc_handler))
        .route(
            "/api/sftp/upload",
            post(sftp_upload_handler).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/sftp/download", get(sftp_download_handler))
        .route("/ws", get(ws_handler))
        .fallback_service(static_service)
        .layer(middleware::from_fn(security_headers_middleware))
        .with_state(state)
}
