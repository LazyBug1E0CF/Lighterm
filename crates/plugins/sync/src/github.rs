use std::collections::HashMap;
use std::process::Command;
use std::sync::Once;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use lighterm_core::error::{CoreError, CoreResult};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use reqwest::{Client, Method, Response, StatusCode};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::models::DiscoveredGist;

pub const MANAGED_GIST_DESCRIPTION: &str = "Lighterm Config Sync [lighterm-managed-sync-v1]";

static RUSTLS_INIT: Once = Once::new();

fn ensure_rustls_provider() {
    RUSTLS_INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn validate_http_base_url(raw: &str, default_url: &str, label: &str) -> CoreResult<(String, bool)> {
    let trimmed = raw.trim().trim_end_matches('/');
    let base_str = if trimmed.is_empty() {
        default_url
    } else {
        trimmed
    };
    let parsed = Url::parse(base_str)
        .map_err(|e| CoreError::InvalidInput(format!("Invalid {label} '{base_str}': {e}")))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(CoreError::InvalidInput(format!(
            "{label} must use http or https"
        )));
    }
    let is_local = parsed
        .host_str()
        .is_some_and(|h| h.eq_ignore_ascii_case("localhost") || h == "127.0.0.1" || h == "::1");
    Ok((base_str.to_string(), is_local))
}

pub fn open_https_url_in_browser(raw_url: &str) -> CoreResult<()> {
    let parsed = Url::parse(raw_url.trim())
        .map_err(|e| CoreError::InvalidInput(format!("Invalid verification URL: {e}")))?;
    if parsed.scheme() != "https" {
        return Err(CoreError::InvalidInput(
            "Only https:// verification URLs can be opened in the browser".to_string(),
        ));
    }

    let url_str = parsed.as_str();
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url_str]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(url_str);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(url_str);
        c
    };

    cmd.spawn()
        .map_err(|e| CoreError::PluginError(format!("Failed to launch browser: {e}")))?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct GitHubUser {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone)]
pub struct OAuthTokenResponse {
    pub access_token: String,
    pub scope: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
}

#[derive(Debug, Clone)]
pub enum DeviceTokenPollResponse {
    Pending,
    SlowDown(Option<u64>),
    Expired,
    Denied,
    Authorized(OAuthTokenResponse),
}

#[derive(Debug, Deserialize)]
struct ApiDeviceCodeResponse {
    device_code: Option<String>,
    user_code: Option<String>,
    verification_uri: Option<String>,
    expires_in: Option<u64>,
    interval: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiOAuthTokenResponse {
    access_token: Option<String>,
    scope: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    interval: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

pub struct GitHubOAuthClient {
    http: Client,
    base_url: String,
}

impl GitHubOAuthClient {
    pub fn new(oauth_base_url: &str) -> CoreResult<Self> {
        ensure_rustls_provider();
        let (base_url, is_local) =
            validate_http_base_url(oauth_base_url, "https://github.com", "GitHub OAuth base URL")?;

        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        headers.insert(USER_AGENT, HeaderValue::from_static("Lighterm/0.1.0"));
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/x-www-form-urlencoded"),
        );

        let mut builder = Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(30));
        if is_local {
            builder = builder.no_proxy();
        }

        let http = builder
            .build()
            .map_err(|e| CoreError::PluginError(format!("Failed to build OAuth HTTP client: {e}")))?;

        Ok(Self { http, base_url })
    }

    pub async fn request_device_code(
        &self,
        client_id: &str,
        scope: &str,
    ) -> CoreResult<DeviceCodeResponse> {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", client_id.trim())
            .append_pair("scope", scope.trim())
            .finish();

        let resp = self
            .http
            .post(format!("{}/login/device/code", self.base_url))
            .body(body)
            .send()
            .await
            .map_err(|e| CoreError::PluginError(format!("GitHub OAuth request failed: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to read OAuth response: {e}")))?;

        let parsed: ApiDeviceCodeResponse = serde_json::from_str(&text).map_err(|e| {
            CoreError::PluginError(format!(
                "Failed to parse GitHub OAuth device code response (HTTP {}): {e}",
                status.as_u16()
            ))
        })?;

        if let Some(err) = parsed.error {
            let desc = parsed
                .error_description
                .filter(|d| !d.trim().is_empty())
                .unwrap_or_else(|| err.clone());
            return Err(CoreError::AuthFailed(format!(
                "GitHub OAuth error ({err}): {desc}"
            )));
        }

        if !status.is_success() {
            return Err(CoreError::PluginError(format!(
                "GitHub OAuth device code failed with HTTP {}",
                status.as_u16()
            )));
        }

        let device_code = parsed
            .device_code
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| CoreError::PluginError("Missing device_code in OAuth response".into()))?;
        let user_code = parsed
            .user_code
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| CoreError::PluginError("Missing user_code in OAuth response".into()))?;
        let verification_uri = parsed
            .verification_uri
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("{}/login/device", self.base_url));

        Ok(DeviceCodeResponse {
            device_code,
            user_code,
            verification_uri,
            expires_in: parsed.expires_in.unwrap_or(900),
            interval: parsed.interval.unwrap_or(5).max(1),
        })
    }

    pub async fn poll_device_token(
        &self,
        client_id: &str,
        device_code: &str,
    ) -> CoreResult<DeviceTokenPollResponse> {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", client_id.trim())
            .append_pair("device_code", device_code.trim())
            .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
            .finish();

        let resp = self
            .http
            .post(format!("{}/login/oauth/access_token", self.base_url))
            .body(body)
            .send()
            .await
            .map_err(|e| CoreError::PluginError(format!("GitHub OAuth poll failed: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to read OAuth poll response: {e}")))?;

        let parsed: ApiOAuthTokenResponse = serde_json::from_str(&text).map_err(|e| {
            CoreError::PluginError(format!(
                "Failed to parse GitHub OAuth token response (HTTP {}): {e}",
                status.as_u16()
            ))
        })?;

        if let Some(err) = parsed.error.as_deref() {
            return match err {
                "authorization_pending" => Ok(DeviceTokenPollResponse::Pending),
                "slow_down" => Ok(DeviceTokenPollResponse::SlowDown(parsed.interval)),
                "expired_token" => Ok(DeviceTokenPollResponse::Expired),
                "access_denied" => Ok(DeviceTokenPollResponse::Denied),
                other => {
                    let desc = parsed
                        .error_description
                        .filter(|d| !d.trim().is_empty())
                        .unwrap_or_else(|| other.to_string());
                    Err(CoreError::AuthFailed(format!(
                        "GitHub OAuth authorization failed ({other}): {desc}"
                    )))
                }
            };
        }

        if !status.is_success() {
            return Err(CoreError::PluginError(format!(
                "GitHub OAuth token polling failed with HTTP {}",
                status.as_u16()
            )));
        }

        let access_token = parsed
            .access_token
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                CoreError::PluginError("Missing access_token in OAuth token response".into())
            })?;

        Ok(DeviceTokenPollResponse::Authorized(OAuthTokenResponse {
            access_token,
            scope: parsed.scope.unwrap_or_default(),
            refresh_token: parsed.refresh_token.filter(|s| !s.trim().is_empty()),
            expires_in: parsed.expires_in,
        }))
    }

    pub async fn refresh_access_token(
        &self,
        client_id: &str,
        refresh_token: &str,
    ) -> CoreResult<OAuthTokenResponse> {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", client_id.trim())
            .append_pair("grant_type", "refresh_token")
            .append_pair("refresh_token", refresh_token.trim())
            .finish();

        let resp = self
            .http
            .post(format!("{}/login/oauth/access_token", self.base_url))
            .body(body)
            .send()
            .await
            .map_err(|e| CoreError::PluginError(format!("GitHub OAuth refresh failed: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to read OAuth refresh response: {e}")))?;

        let parsed: ApiOAuthTokenResponse = serde_json::from_str(&text).map_err(|e| {
            CoreError::PluginError(format!(
                "Failed to parse GitHub OAuth refresh response (HTTP {}): {e}",
                status.as_u16()
            ))
        })?;

        if let Some(err) = parsed.error {
            let desc = parsed
                .error_description
                .filter(|d| !d.trim().is_empty())
                .unwrap_or_else(|| err.clone());
            return Err(CoreError::AuthFailed(format!(
                "GitHub OAuth session expired ({err}): {desc}. Please sign in with GitHub again."
            )));
        }

        if !status.is_success() {
            return Err(CoreError::AuthFailed(format!(
                "GitHub OAuth refresh failed with HTTP {}. Please sign in with GitHub again.",
                status.as_u16()
            )));
        }

        let access_token = parsed
            .access_token
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                CoreError::AuthFailed("Missing access_token in OAuth refresh response".into())
            })?;

        Ok(OAuthTokenResponse {
            access_token,
            scope: parsed.scope.unwrap_or_default(),
            refresh_token: parsed.refresh_token.filter(|s| !s.trim().is_empty()),
            expires_in: parsed.expires_in,
        })
    }
}

#[derive(Debug, Clone)]
pub struct GitHubRepoInfo {
    pub owner: String,
    pub name: String,
    pub private: bool,
    pub default_branch: String,
    pub html_url: String,
}

#[derive(Debug, Clone)]
pub struct RemoteFile {
    pub content: String,
    pub sha: Option<String>,
    pub html_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RemoteWriteResult {
    pub id: Option<String>,
    pub html_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiUser {
    login: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiGistOwner {
    login: String,
}

#[derive(Debug, Deserialize)]
struct ApiGistFile {
    content: Option<String>,
    truncated: Option<bool>,
    raw_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiGist {
    id: String,
    #[serde(default)]
    description: Option<String>,
    public: bool,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    files: HashMap<String, ApiGistFile>,
    #[serde(default)]
    owner: Option<ApiGistOwner>,
}

#[derive(Debug, Deserialize)]
struct ApiRepo {
    name: String,
    private: bool,
    default_branch: String,
    html_url: String,
    owner: ApiUser,
}

#[derive(Debug, Deserialize)]
struct ApiRepoContent {
    sha: Option<String>,
    content: Option<String>,
    encoding: Option<String>,
    html_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiGitBlob {
    content: String,
    encoding: String,
}

#[derive(Debug, Serialize)]
struct CreateGistRequest<'a> {
    description: &'a str,
    public: bool,
    files: HashMap<&'a str, GistFileInput<'a>>,
}

#[derive(Debug, Serialize)]
struct UpdateGistRequest<'a> {
    description: &'a str,
    files: HashMap<&'a str, GistFileInput<'a>>,
}

#[derive(Debug, Serialize)]
struct GistFileInput<'a> {
    content: &'a str,
}

#[derive(Debug, Serialize)]
struct CreateRepoRequest<'a> {
    name: &'a str,
    description: &'a str,
    private: bool,
    auto_init: bool,
}

#[derive(Debug, Serialize)]
struct PutRepoFileRequest<'a> {
    message: &'a str,
    content: String,
    branch: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha: Option<&'a str>,
}

pub struct GitHubClient {
    http: Client,
    base_url: String,
}

impl GitHubClient {
    pub fn new(api_base_url: &str, token: &str) -> CoreResult<Self> {
        ensure_rustls_provider();

        let clean_token = token.trim();
        if clean_token.is_empty() {
            return Err(CoreError::AuthFailed(
                "Not signed in to GitHub. Please sign in with GitHub OAuth first.".to_string(),
            ));
        }

        let (base_str, is_local) = validate_http_base_url(
            api_base_url,
            "https://api.github.com",
            "GitHub API base URL",
        )?;

        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github+json"),
        );
        headers.insert(USER_AGENT, HeaderValue::from_static("Lighterm/0.1.0"));
        headers.insert(
            "X-GitHub-Api-Version",
            HeaderValue::from_static("2022-11-28"),
        );
        let auth_val = HeaderValue::from_str(&format!("Bearer {clean_token}")).map_err(|_| {
            CoreError::InvalidInput("GitHub authorization token contains invalid header characters".to_string())
        })?;
        headers.insert(AUTHORIZATION, auth_val);

        let mut builder = Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(30));
        if is_local {
            builder = builder.no_proxy();
        }

        let http = builder
            .build()
            .map_err(|e| CoreError::PluginError(format!("Failed to build HTTP client: {e}")))?;

        Ok(Self {
            http,
            base_url: base_str,
        })
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    async fn send_json<B: Serialize>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> CoreResult<Response> {
        let mut req = self.http.request(method, self.endpoint(path));
        if let Some(payload) = body {
            req = req.json(payload);
        }
        req.send()
            .await
            .map_err(|e| CoreError::PluginError(format!("GitHub network request failed: {e}")))
    }

    async fn map_error_response(&self, resp: Response, context: &str) -> CoreError {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        let api_msg = serde_json::from_str::<ApiErrorBody>(&body_text)
            .ok()
            .and_then(|b| b.message)
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));

        match status {
            StatusCode::UNAUTHORIZED => CoreError::AuthFailed(format!(
                "GitHub OAuth authorization expired or revoked during {context}: {api_msg}. Please sign in with GitHub again."
            )),
            StatusCode::FORBIDDEN => CoreError::AuthFailed(format!(
                "GitHub access denied during {context}: {api_msg}"
            )),
            _ => CoreError::PluginError(format!(
                "GitHub API error during {context} ({}): {api_msg}",
                status.as_u16()
            )),
        }
    }

    pub async fn verify_user(&self) -> CoreResult<GitHubUser> {
        let resp = self
            .send_json::<()>(Method::GET, "/user", None)
            .await?;
        if !resp.status().is_success() {
            return Err(self.map_error_response(resp, "account verification").await);
        }
        let user: ApiUser = resp
            .json()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to parse GitHub user: {e}")))?;
        Ok(GitHubUser {
            login: user.login,
            name: user.name,
            avatar_url: user.avatar_url,
        })
    }

    pub async fn discover_sync_gists(&self, file_name: &str) -> CoreResult<Vec<DiscoveredGist>> {
        let resp = self
            .send_json::<()>(Method::GET, "/gists?per_page=100", None)
            .await?;
        if !resp.status().is_success() {
            return Err(self.map_error_response(resp, "listing gists").await);
        }
        let gists: Vec<ApiGist> = resp
            .json()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to parse gist list: {e}")))?;

        let target_name = if file_name.trim().is_empty() {
            "lighterm-sync.json"
        } else {
            file_name.trim()
        };

        let mut matches = Vec::new();
        for g in gists {
            let desc = g.description.unwrap_or_default();
            let matched_file = if g.files.contains_key(target_name) {
                Some(target_name.to_string())
            } else if g.files.contains_key("lighterm-sync.json") {
                Some("lighterm-sync.json".to_string())
            } else if desc.contains("Lighterm Config Sync") {
                g.files.keys().next().cloned()
            } else {
                None
            };

            if let Some(found_file) = matched_file {
                matches.push(DiscoveredGist {
                    id: g.id,
                    description: desc,
                    file_name: found_file,
                    public: g.public,
                    updated_at: g.updated_at,
                    html_url: g.html_url,
                });
            }
        }
        matches.sort_by(|a, b| {
            let a_managed = a.description.contains("[lighterm-managed-sync-v1]");
            let b_managed = b.description.contains("[lighterm-managed-sync-v1]");
            let a_secret = !a.public;
            let b_secret = !b.public;
            let a_target = a.file_name == target_name;
            let b_target = b.file_name == target_name;

            b_secret
                .cmp(&a_secret)
                .then_with(|| b_managed.cmp(&a_managed))
                .then_with(|| b_target.cmp(&a_target))
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        Ok(matches)
    }

    pub async fn get_gist_meta(&self, gist_id: &str) -> CoreResult<Option<DiscoveredGist>> {
        let clean_id = gist_id.trim();
        if clean_id.is_empty() {
            return Ok(None);
        }
        let resp = self
            .send_json::<()>(Method::GET, &format!("/gists/{clean_id}"), None)
            .await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(self.map_error_response(resp, "fetching gist metadata").await);
        }
        let g: ApiGist = resp
            .json()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to parse gist metadata: {e}")))?;
        let first_file = g.files.keys().next().cloned().unwrap_or_default();
        Ok(Some(DiscoveredGist {
            id: g.id,
            description: g.description.unwrap_or_default(),
            file_name: first_file,
            public: g.public,
            updated_at: g.updated_at,
            html_url: g.html_url,
        }))
    }

    pub async fn fetch_gist(&self, gist_id: &str, file_name: &str) -> CoreResult<Option<RemoteFile>> {
        let clean_id = gist_id.trim();
        let resp = self
            .send_json::<()>(Method::GET, &format!("/gists/{clean_id}"), None)
            .await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(self.map_error_response(resp, "fetching gist").await);
        }
        let g: ApiGist = resp
            .json()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to parse gist response: {e}")))?;
        let _owner = g.owner.as_ref().map(|o| o.login.as_str());

        let file = g
            .files
            .get(file_name)
            .or_else(|| g.files.get("lighterm-sync.json"));
        let Some(file) = file else {
            return Ok(None);
        };

        let content = if file.truncated.unwrap_or(false) {
            if let Some(raw_url) = file.raw_url.as_deref() {
                let raw_resp = self
                    .http
                    .get(raw_url)
                    .send()
                    .await
                    .map_err(|e| CoreError::PluginError(format!("Failed to fetch raw gist: {e}")))?;
                if !raw_resp.status().is_success() {
                    return Err(self.map_error_response(raw_resp, "fetching raw gist").await);
                }
                raw_resp
                    .text()
                    .await
                    .map_err(|e| CoreError::PluginError(format!("Failed to read raw gist: {e}")))?
            } else {
                file.content.clone().unwrap_or_default()
            }
        } else {
            file.content.clone().unwrap_or_default()
        };

        Ok(Some(RemoteFile {
            content,
            sha: None,
            html_url: Some(g.html_url),
        }))
    }

    pub async fn create_gist(
        &self,
        file_name: &str,
        content: &str,
    ) -> CoreResult<RemoteWriteResult> {
        let mut files = HashMap::new();
        files.insert(file_name, GistFileInput { content });
        let body = CreateGistRequest {
            description: MANAGED_GIST_DESCRIPTION,
            public: false,
            files,
        };
        let resp = self
            .send_json(Method::POST, "/gists", Some(&body))
            .await?;
        if !resp.status().is_success() {
            return Err(self.map_error_response(resp, "creating secret gist").await);
        }
        let created: ApiGist = resp
            .json()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to parse created gist: {e}")))?;
        Ok(RemoteWriteResult {
            id: Some(created.id),
            html_url: Some(created.html_url),
        })
    }

    pub async fn update_gist(
        &self,
        gist_id: &str,
        file_name: &str,
        content: &str,
    ) -> CoreResult<RemoteWriteResult> {
        let mut files = HashMap::new();
        files.insert(file_name, GistFileInput { content });
        let body = UpdateGistRequest {
            description: MANAGED_GIST_DESCRIPTION,
            files,
        };
        let resp = self
            .send_json(Method::PATCH, &format!("/gists/{}", gist_id.trim()), Some(&body))
            .await?;
        if !resp.status().is_success() {
            return Err(self.map_error_response(resp, "updating gist").await);
        }
        let updated: ApiGist = resp
            .json()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to parse updated gist: {e}")))?;
        Ok(RemoteWriteResult {
            id: Some(updated.id),
            html_url: Some(updated.html_url),
        })
    }

    pub async fn get_repo(&self, owner: &str, repo: &str) -> CoreResult<Option<GitHubRepoInfo>> {
        let path = format!("/repos/{}/{}", owner.trim(), repo.trim());
        let resp = self.send_json::<()>(Method::GET, &path, None).await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(self.map_error_response(resp, "inspecting repository").await);
        }
        let info: ApiRepo = resp
            .json()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to parse repository info: {e}")))?;
        Ok(Some(GitHubRepoInfo {
            owner: info.owner.login,
            name: info.name,
            private: info.private,
            default_branch: info.default_branch,
            html_url: info.html_url,
        }))
    }

    pub async fn create_private_repo(&self, repo: &str) -> CoreResult<GitHubRepoInfo> {
        let body = CreateRepoRequest {
            name: repo.trim(),
            description: "Lighterm cross-device configuration sync",
            private: true,
            auto_init: true,
        };
        let resp = self
            .send_json(Method::POST, "/user/repos", Some(&body))
            .await?;
        if !resp.status().is_success() {
            return Err(self
                .map_error_response(resp, "creating private repository")
                .await);
        }
        let info: ApiRepo = resp
            .json()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to parse created repo: {e}")))?;
        Ok(GitHubRepoInfo {
            owner: info.owner.login,
            name: info.name,
            private: info.private,
            default_branch: info.default_branch,
            html_url: info.html_url,
        })
    }

    pub async fn fetch_repo_file(
        &self,
        owner: &str,
        repo: &str,
        branch: &str,
        file_path: &str,
    ) -> CoreResult<Option<RemoteFile>> {
        let clean_path = file_path.trim().trim_start_matches('/');
        let encoded_ref = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("ref", branch.trim())
            .finish();
        let path = format!(
            "/repos/{}/{}/contents/{}?{}",
            owner.trim(),
            repo.trim(),
            clean_path,
            encoded_ref
        );
        let resp = self.send_json::<()>(Method::GET, &path, None).await?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(self
                .map_error_response(resp, "fetching repository file")
                .await);
        }
        let meta: ApiRepoContent = resp
            .json()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to parse repo contents: {e}")))?;

        let raw_b64 = if let (Some(content), Some(enc)) = (meta.content, meta.encoding) {
            if enc == "base64" && !content.trim().is_empty() {
                content
            } else if let Some(sha) = meta.sha.as_deref() {
                self.fetch_blob_base64(owner, repo, sha).await?
            } else {
                String::new()
            }
        } else if let Some(sha) = meta.sha.as_deref() {
            self.fetch_blob_base64(owner, repo, sha).await?
        } else {
            String::new()
        };

        let compact: String = raw_b64.chars().filter(|c| !c.is_whitespace()).collect();
        let decoded_bytes = BASE64
            .decode(compact)
            .map_err(|e| CoreError::PluginError(format!("Failed to decode GitHub base64: {e}")))?;
        let text = String::from_utf8(decoded_bytes)
            .map_err(|e| CoreError::PluginError(format!("Invalid UTF-8 in remote file: {e}")))?;

        Ok(Some(RemoteFile {
            content: text,
            sha: meta.sha,
            html_url: meta.html_url,
        }))
    }

    async fn fetch_blob_base64(&self, owner: &str, repo: &str, sha: &str) -> CoreResult<String> {
        let path = format!("/repos/{}/{}/git/blobs/{}", owner.trim(), repo.trim(), sha);
        let resp = self.send_json::<()>(Method::GET, &path, None).await?;
        if !resp.status().is_success() {
            return Err(self.map_error_response(resp, "fetching git blob").await);
        }
        let blob: ApiGitBlob = resp
            .json()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to parse git blob: {e}")))?;
        if blob.encoding != "base64" {
            return Err(CoreError::PluginError(format!(
                "Unexpected git blob encoding '{}'",
                blob.encoding
            )));
        }
        Ok(blob.content)
    }

    pub async fn put_repo_file(
        &self,
        owner: &str,
        repo: &str,
        branch: &str,
        file_path: &str,
        content: &str,
        sha: Option<&str>,
        message: &str,
    ) -> CoreResult<RemoteWriteResult> {
        let clean_path = file_path.trim().trim_start_matches('/');
        let path = format!(
            "/repos/{}/{}/contents/{}",
            owner.trim(),
            repo.trim(),
            clean_path
        );
        let body = PutRepoFileRequest {
            message,
            content: BASE64.encode(content.as_bytes()),
            branch: branch.trim(),
            sha,
        };
        let resp = self.send_json(Method::PUT, &path, Some(&body)).await?;
        if !resp.status().is_success() {
            return Err(self
                .map_error_response(resp, "updating repository file")
                .await);
        }
        Ok(RemoteWriteResult {
            id: None,
            html_url: Some(format!(
                "https://github.com/{}/{}",
                owner.trim(),
                repo.trim()
            )),
        })
    }
}
