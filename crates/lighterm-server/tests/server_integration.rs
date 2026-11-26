use std::fs;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http::Method;
use lighterm_server::auth::{AuthConfig, CookieSecureMode};
use lighterm_server::state::{ServerConfig, ServerState};
use lighterm_server::{build_router, init_core};
use serde_json::{json, Value};
use tower::ServiceExt;

fn setup_app(password: Option<&str>, username: Option<&str>) -> (tempfile::TempDir, axum::Router) {
    let temp = tempfile::tempdir().expect("tempdir");
    let data_dir = temp.path().join("data");
    let static_dir = temp.path().join("dist");
    fs::create_dir_all(&static_dir).expect("create dist dir");
    fs::write(
        static_dir.join("index.html"),
        "<!doctype html><html><head><title>Lighterm</title></head><body><div id=\"root\"></div></body></html>",
    )
    .expect("write index.html");

    let core = init_core(data_dir.clone()).expect("init_core");
    let cfg = ServerConfig {
        bind: "127.0.0.1:0".to_string(),
        data_dir,
        static_dir,
        auth: AuthConfig {
            username: username.map(str::to_string),
            password: password.map(str::to_string),
            session_ttl: Duration::from_secs(3600),
            cookie_secure: CookieSecureMode::Never,
        },
    };
    let state = Arc::new(ServerState::new(core, &cfg));
    (temp, build_router(state))
}

async fn response_json(resp: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("parse json")
}

#[tokio::test]
async fn health_and_index_bootstrap_injection_work() {
    let (_tmp, app) = setup_app(Some("secret-pass"), None);

    let health = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    let h_json = response_json(health).await;
    assert_eq!(h_json["status"], "ok");

    let idx = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(idx.status(), StatusCode::OK);
    assert!(idx
        .headers()
        .get(header::CACHE_CONTROL)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("no-store"));
    assert_eq!(
        idx.headers().get("x-content-type-options").unwrap(),
        "nosniff"
    );

    let html_bytes = axum::body::to_bytes(idx.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let html = String::from_utf8(html_bytes.to_vec()).unwrap();
    assert!(html.contains("window.__LIGHTERM_WEB__="));
    assert!(html.contains("\"mode\":\"web\""));
    assert!(html.contains("\"authRequired\":true"));
    assert!(html.contains("\"authenticated\":false"));
    assert!(html.contains("\"localShellEnabled\":false"));
}

#[tokio::test]
async fn auth_enforces_401_issues_cookie_and_supports_logout() {
    let (_tmp, app) = setup_app(Some("top-secret"), Some("admin"));

    // Unauthenticated RPC fails with 401 WEB_AUTH_REQUIRED
    let unauth = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/settings_get")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response_json(unauth).await["code"], "WEB_AUTH_REQUIRED");

    // Wrong password fails with 401 INVALID_CREDENTIALS
    let bad_login = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "username": "admin", "password": "wrong" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bad_login.status(), StatusCode::UNAUTHORIZED);

    // Valid login returns Set-Cookie
    let ok_login = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "username": "admin", "password": "top-secret" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ok_login.status(), StatusCode::OK);
    let set_cookie = ok_login
        .headers()
        .get(header::SET_COOKIE)
        .expect("set-cookie header")
        .to_str()
        .unwrap()
        .to_string();
    let cookie_pair = set_cookie.split(';').next().unwrap().to_string();
    assert!(cookie_pair.starts_with("lighterm_session="));

    // Authenticated RPC succeeds
    let authed_rpc = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/settings_get")
                .header(header::COOKIE, &cookie_pair)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(authed_rpc.status(), StatusCode::OK);
    let settings = response_json(authed_rpc).await;
    assert_eq!(settings["themeId"], "tokyo-night");

    // Logout revokes token
    let logout = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/auth/logout")
                .header(header::COOKIE, &cookie_pair)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(logout.status(), StatusCode::OK);

    let after_logout = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/settings_get")
                .header(header::COOKIE, &cookie_pair)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(after_logout.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn login_rate_limiting_triggers_429() {
    let (_tmp, app) = setup_app(Some("secret"), None);

    for _ in 0..10 {
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/auth/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header("x-forwarded-for", "203.0.113.5")
                    .body(Body::from(json!({ "password": "bad" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    let blocked = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-forwarded-for", "203.0.113.5")
                .body(Body::from(json!({ "password": "secret" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(blocked.status(), StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn web_settings_default_disables_local_shell_persists_and_toggles_live() {
    let (tmp, app) = setup_app(None, None);
    let data_dir = tmp.path().join("data");
    let static_dir = tmp.path().join("dist");

    // Default web_settings_get returns allowLocalShell: false
    let get_default = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/web_settings_get")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_default.status(), StatusCode::OK);
    assert_eq!(response_json(get_default).await["allowLocalShell"], false);

    // Default terminal_create_local is rejected
    let local_err = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/terminal_create_local")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "cols": 80, "rows": 24 }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(local_err.status(), StatusCode::BAD_REQUEST);
    assert_eq!(response_json(local_err).await["code"], "INVALID_INPUT");

    // Enable allowLocalShell via web_settings_save
    let save_enable = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/web_settings_save")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "settings": { "allowLocalShell": true } }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(save_enable.status(), StatusCode::OK);
    assert_eq!(response_json(save_enable).await["allowLocalShell"], true);

    // Index bootstrap reflects localShellEnabled: true
    let idx_enabled = app
        .clone()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let html_bytes = axum::body::to_bytes(idx_enabled.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let html = String::from_utf8(html_bytes.to_vec()).unwrap();
    assert!(html.contains("\"localShellEnabled\":true"));

    // Persists across ServerState restart on the same data_dir
    let core2 = init_core(data_dir.clone()).expect("re-init core");
    let state2 = Arc::new(ServerState::new(
        core2,
        &ServerConfig {
            bind: "127.0.0.1:0".to_string(),
            data_dir,
            static_dir,
            auth: AuthConfig::default(),
        },
    ));
    let app2 = build_router(state2);
    let get_reloaded = app2
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/web_settings_get")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response_json(get_reloaded).await["allowLocalShell"], true);

    // Toggling back to false blocks terminal_create_local again
    let save_disable = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/web_settings_save")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "settings": { "allowLocalShell": false } }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(save_disable.status(), StatusCode::OK);
    assert_eq!(response_json(save_disable).await["allowLocalShell"], false);

    let local_err_again = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/terminal_create_local")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "cols": 80, "rows": 24 }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(local_err_again.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn rpc_crud_works() {
    let (_tmp, app) = setup_app(None, None);

    // Hosts CRUD
    let saved_host = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/hosts_save")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "host": {
                            "id": "",
                            "name": "Prod 01",
                            "group": "Prod",
                            "host": "10.0.0.5",
                            "port": 22,
                            "username": "deploy",
                            "auth": { "type": "password", "password": "pw" },
                            "defaultPath": null,
                            "startupCommand": null,
                            "color": "#7aa2f7",
                            "updatedAt": 0
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(saved_host.status(), StatusCode::OK);
    let host_json = response_json(saved_host).await;
    let host_id = host_json["id"].as_str().unwrap().to_string();
    assert!(!host_id.is_empty());

    let listed_hosts = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/hosts_list")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response_json(listed_hosts).await.as_array().unwrap().len(), 1);

    // Snippets & History
    let snippets = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/snippets_list")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(snippets.status(), StatusCode::OK);
    assert!(!response_json(snippets).await.as_array().unwrap().is_empty());

    let recorded = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/history_record")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "command": "uname -a",
                        "sessionKind": "ssh",
                        "hostLabel": "Prod 01"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(recorded.status(), StatusCode::OK);

    // Plugins & Plugin Configs
    let plugins = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/plugins_list")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(plugins.status(), StatusCode::OK);
    assert_eq!(response_json(plugins).await.as_array().unwrap().len(), 5);

    let cfg_save = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/plugin_config_save")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "pluginId": "lighterm.sftp", "config": { "showHiddenByDefault": true } })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cfg_save.status(), StatusCode::OK);

    // SFTP local-path RPC is disabled in web mode
    let sftp_err = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/rpc/sftp_upload")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(sftp_err.status(), StatusCode::BAD_REQUEST);
}
