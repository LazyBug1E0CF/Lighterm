use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use parking_lot::Mutex;
use ring::digest::{digest, SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

use crate::state::ServerState;

const SESSION_COOKIE_NAME: &str = "lighterm_session";
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);
const RATE_LIMIT_MAX_ATTEMPTS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CookieSecureMode {
    Auto,
    Always,
    Never,
}

impl CookieSecureMode {
    pub fn from_env_str(raw: Option<&str>) -> Self {
        match raw.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("true" | "1" | "always" | "yes") => Self::Always,
            Some("false" | "0" | "never" | "no") => Self::Never,
            _ => Self::Auto,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub username: Option<String>,
    pub password: Option<String>,
    pub session_ttl: Duration,
    pub cookie_secure: CookieSecureMode,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            username: None,
            password: None,
            session_ttl: Duration::from_secs(86_400),
            cookie_secure: CookieSecureMode::Auto,
        }
    }
}

pub struct AuthManager {
    config: AuthConfig,
    rng: SystemRandom,
    sessions: Mutex<HashMap<String, Instant>>,
    failed_attempts: Mutex<HashMap<String, Vec<Instant>>>,
}

impl AuthManager {
    pub fn new(config: AuthConfig) -> Self {
        Self {
            config,
            rng: SystemRandom::new(),
            sessions: Mutex::new(HashMap::new()),
            failed_attempts: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.config
            .password
            .as_deref()
            .is_some_and(|p| !p.is_empty())
    }

    pub fn username_required(&self) -> bool {
        self.config
            .username
            .as_deref()
            .is_some_and(|u| !u.trim().is_empty())
    }

    fn constant_time_eq(expected: &str, provided: &str) -> bool {
        let a = digest(&SHA256, expected.as_bytes());
        let b = digest(&SHA256, provided.as_bytes());
        let mut diff = 0u8;
        for (x, y) in a.as_ref().iter().zip(b.as_ref().iter()) {
            diff |= x ^ y;
        }
        std::hint::black_box(diff) == 0
    }

    fn verify_credentials(&self, username: Option<&str>, password: &str) -> bool {
        let Some(expected_password) = self.config.password.as_deref() else {
            return true;
        };
        if !Self::constant_time_eq(expected_password, password) {
            return false;
        }
        if let Some(expected_user) = self.config.username.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let provided_user = username.map(str::trim).unwrap_or("");
            return Self::constant_time_eq(expected_user, provided_user);
        }
        true
    }

    fn client_key(headers: &HeaderMap) -> String {
        headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|raw| raw.split(',').next())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("default")
            .to_string()
    }

    fn is_rate_limited(&self, client_key: &str) -> bool {
        let now = Instant::now();
        let mut guard = self.failed_attempts.lock();
        let Some(entries) = guard.get_mut(client_key) else {
            return false;
        };
        entries.retain(|&ts| now.saturating_duration_since(ts) < RATE_LIMIT_WINDOW);
        entries.len() >= RATE_LIMIT_MAX_ATTEMPTS
    }

    fn record_failed_attempt(&self, client_key: &str) {
        let now = Instant::now();
        let mut guard = self.failed_attempts.lock();
        let entries = guard.entry(client_key.to_string()).or_default();
        entries.retain(|&ts| now.saturating_duration_since(ts) < RATE_LIMIT_WINDOW);
        entries.push(now);
    }

    fn clear_failed_attempts(&self, client_key: &str) {
        self.failed_attempts.lock().remove(client_key);
    }

    fn generate_token(&self) -> Option<String> {
        let mut bytes = [0u8; 32];
        if self.rng.fill(&mut bytes).is_err() {
            return None;
        }
        let mut out = String::with_capacity(64);
        for b in bytes {
            out.push_str(&format!("{b:02x}"));
        }
        Some(out)
    }

    pub fn issue_session(&self) -> Option<String> {
        let token = self.generate_token()?;
        let now = Instant::now();
        let expires_at = now + self.config.session_ttl;
        let mut guard = self.sessions.lock();
        guard.retain(|_, exp| *exp > now);
        guard.insert(token.clone(), expires_at);
        Some(token)
    }

    pub fn revoke_token(&self, token: &str) {
        self.sessions.lock().remove(token);
    }

    pub fn extract_token(headers: &HeaderMap) -> Option<String> {
        if let Some(auth_header) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
            let trimmed = auth_header.trim();
            if trimmed.len() > 7 && trimmed[..7].eq_ignore_ascii_case("bearer ") {
                let token = trimmed[7..].trim();
                if !token.is_empty() {
                    return Some(token.to_string());
                }
            }
        }

        for cookie_header in headers.get_all(header::COOKIE) {
            if let Ok(raw) = cookie_header.to_str() {
                for part in raw.split(';') {
                    let trimmed = part.trim();
                    if let Some(val) = trimmed.strip_prefix("lighterm_session=") {
                        let tok = val.trim();
                        if !tok.is_empty() {
                            return Some(tok.to_string());
                        }
                    }
                }
            }
        }

        None
    }

    pub fn is_authenticated(&self, headers: &HeaderMap) -> bool {
        if !self.is_enabled() {
            return true;
        }
        let Some(token) = Self::extract_token(headers) else {
            return false;
        };
        let now = Instant::now();
        let mut guard = self.sessions.lock();
        if let Some(&exp) = guard.get(&token) {
            if exp > now {
                return true;
            }
            guard.remove(&token);
        }
        false
    }

    fn should_set_secure_cookie(&self, headers: &HeaderMap) -> bool {
        match self.config.cookie_secure {
            CookieSecureMode::Always => true,
            CookieSecureMode::Never => false,
            CookieSecureMode::Auto => headers
                .get("x-forwarded-proto")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|proto| {
                    proto
                        .split(',')
                        .next()
                        .map(str::trim)
                        .is_some_and(|p| p.eq_ignore_ascii_case("https"))
                }),
        }
    }

    pub fn build_session_cookie(&self, token: &str, headers: &HeaderMap) -> HeaderValue {
        let max_age = self.config.session_ttl.as_secs();
        let secure = if self.should_set_secure_cookie(headers) {
            "; Secure"
        } else {
            ""
        };
        let raw = format!(
            "{SESSION_COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age}{secure}"
        );
        HeaderValue::from_str(&raw).expect("valid session cookie header")
    }

    pub fn build_clear_cookie(&self, headers: &HeaderMap) -> HeaderValue {
        let secure = if self.should_set_secure_cookie(headers) {
            "; Secure"
        } else {
            ""
        };
        let raw = format!("{SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{secure}");
        HeaderValue::from_str(&raw).expect("valid clear cookie header")
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusResponse {
    pub auth_required: bool,
    pub username_required: bool,
    pub authenticated: bool,
    pub local_shell_enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub username: Option<String>,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload<'a> {
    code: &'a str,
    message: &'a str,
}

pub fn require_auth_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(ErrorPayload {
            code: "WEB_AUTH_REQUIRED",
            message: "Authentication required",
        }),
    )
        .into_response()
}

pub async fn auth_status_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Json<AuthStatusResponse> {
    Json(AuthStatusResponse {
        auth_required: state.auth.is_enabled(),
        username_required: state.auth.username_required(),
        authenticated: state.auth.is_authenticated(&headers),
        local_shell_enabled: state.is_local_shell_enabled(),
    })
}

pub async fn auth_login_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> Response {
    if !state.auth.is_enabled() {
        return (
            StatusCode::OK,
            Json(AuthStatusResponse {
                auth_required: false,
                username_required: false,
                authenticated: true,
                local_shell_enabled: state.is_local_shell_enabled(),
            }),
        )
            .into_response();
    }

    let client_key = AuthManager::client_key(&headers);
    if state.auth.is_rate_limited(&client_key) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(ErrorPayload {
                code: "RATE_LIMITED",
                message: "Too many failed login attempts. Please wait a minute and try again.",
            }),
        )
            .into_response();
    }

    if !state
        .auth
        .verify_credentials(req.username.as_deref(), &req.password)
    {
        state.auth.record_failed_attempt(&client_key);
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorPayload {
                code: "INVALID_CREDENTIALS",
                message: "Invalid username or password.",
            }),
        )
            .into_response();
    }

    state.auth.clear_failed_attempts(&client_key);

    let Some(token) = state.auth.issue_session() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorPayload {
                code: "SESSION_ERROR",
                message: "Failed to allocate session token.",
            }),
        )
            .into_response();
    };

    let cookie = state.auth.build_session_cookie(&token, &headers);
    let mut resp = (
        StatusCode::OK,
        Json(AuthStatusResponse {
            auth_required: true,
            username_required: state.auth.username_required(),
            authenticated: true,
            local_shell_enabled: state.is_local_shell_enabled(),
        }),
    )
        .into_response();
    resp.headers_mut().insert(header::SET_COOKIE, cookie);
    resp
}

pub async fn auth_logout_handler(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Response {
    if let Some(token) = AuthManager::extract_token(&headers) {
        state.auth.revoke_token(&token);
    }
    let cookie = state.auth.build_clear_cookie(&headers);
    let mut resp = (
        StatusCode::OK,
        Json(AuthStatusResponse {
            auth_required: state.auth.is_enabled(),
            username_required: state.auth.username_required(),
            authenticated: !state.auth.is_enabled(),
            local_shell_enabled: state.is_local_shell_enabled(),
        }),
    )
        .into_response();
    resp.headers_mut().insert(header::SET_COOKIE, cookie);
    resp
}
