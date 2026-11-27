use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use lighterm_core::storage::Storage;
use lighterm_server::auth::{AuthConfig, CookieSecureMode};
use lighterm_server::state::{ServerConfig, ServerState};
use lighterm_server::{build_router, init_core};
use tracing_subscriber::EnvFilter;

fn resolve_static_dir() -> PathBuf {
    if let Some(val) = std::env::var_os("LIGHTERM_STATIC_DIR") {
        let path = PathBuf::from(val);
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    let local_dist = PathBuf::from("dist");
    if local_dist.exists() {
        return local_dist;
    }
    let container_dist = PathBuf::from("/app/dist");
    if container_dist.exists() {
        return container_dist;
    }
    local_dist
}

fn load_config_from_env() -> ServerConfig {
    let port = std::env::var("PORT")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "8080".to_string());

    let bind = std::env::var("LIGHTERM_BIND")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("0.0.0.0:{port}"));

    let data_dir = std::env::var_os("LIGHTERM_DATA_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(Storage::default_dir);

    let static_dir = resolve_static_dir();

    let password = std::env::var("LIGHTERM_AUTH_PASSWORD")
        .ok()
        .filter(|s| !s.is_empty());
    let username = std::env::var("LIGHTERM_AUTH_USER")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let ttl_secs = std::env::var("LIGHTERM_SESSION_TTL_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(86_400);

    let cookie_secure = CookieSecureMode::from_env_str(
        std::env::var("LIGHTERM_COOKIE_SECURE").ok().as_deref(),
    );

    let self_update_enabled = std::env::var("LIGHTERM_SELF_UPDATE")
        .ok()
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);

    ServerConfig {
        bind,
        data_dir,
        static_dir,
        auth: AuthConfig {
            username,
            password,
            session_ttl: Duration::from_secs(ttl_secs),
            cookie_secure,
        },
        self_update_enabled,
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

#[tokio::main]
async fn main() {
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("lighterm-server {}", lighterm_server::current_server_version());
        return;
    }

    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(env_filter).init();

    let config = load_config_from_env();
    let core = init_core(config.data_dir.clone()).expect("Failed to initialize Lighterm core");
    let state = Arc::new(ServerState::new(Arc::clone(&core), &config));

    if !state.auth.is_enabled() {
        tracing::warn!(
            "LIGHTERM_AUTH_PASSWORD is not set — web UI and terminal/SSH endpoints are unauthenticated. Set LIGHTERM_AUTH_PASSWORD before exposing to a network."
        );
    }

    tracing::info!(
        version = %lighterm_server::current_server_version(),
        bind = %config.bind,
        data_dir = %config.data_dir.display(),
        static_dir = %config.static_dir.display(),
        auth_enabled = state.auth.is_enabled(),
        allow_local_shell = state.is_local_shell_enabled(),
        self_update_enabled = state.is_self_update_enabled(),
        "Starting Lighterm web server"
    );

    let listener = tokio::net::TcpListener::bind(&config.bind)
        .await
        .unwrap_or_else(|e| panic!("Failed to bind '{}': {e}", config.bind));

    let shutdown_state = Arc::clone(&state);
    let app = build_router(Arc::clone(&state));
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = shutdown_signal() => {}
                _ = shutdown_state.wait_for_restart() => {}
            }
        })
        .await
        .expect("Lighterm web server error");

    for session in core.sessions.list_sessions() {
        let _ = core.sessions.close(&session.id);
    }
    tracing::info!("Lighterm web server stopped cleanly");

    if state.is_restart_requested() {
        tracing::info!(
            exit_code = lighterm_core::updater::SELF_UPDATE_RESTART_EXIT_CODE,
            "Restarting Lighterm web server to activate staged update"
        );
        std::process::exit(lighterm_core::updater::SELF_UPDATE_RESTART_EXIT_CODE);
    }
}
