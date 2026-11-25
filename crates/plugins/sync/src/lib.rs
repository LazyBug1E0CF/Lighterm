pub mod crypto;
pub mod github;
pub mod merge;
pub mod models;

use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::Utc;
use lighterm_core::error::{CoreError, CoreResult};
use lighterm_core::models::{AppSettings, HostConfig, SavedWorkspace};
use lighterm_core::plugin::{CoreContext, CorePlugin};
use lighterm_core::storage::Storage;
use parking_lot::RwLock;
use ring::rand::{SecureRandom, SystemRandom};

use crate::crypto::{decrypt_payload, encrypt_payload, sha256_hex};
use crate::github::{
    open_https_url_in_browser, DeviceTokenPollResponse, GitHubClient, GitHubOAuthClient,
};
use crate::merge::{
    collect_local_deletions, compute_invalidated_host_ids, filter_plugin_configs_for_sync,
    filter_plugin_states_for_sync, merge_entities, merge_hosts, merge_settings, merge_singleton,
    merge_snippets, merge_tombstones, strip_host_secrets, PluginBundle,
};
pub use crate::models::{
    ConflictResolution, DiscoveredGist, GitHubSyncConfig, OAuthDeviceFlowStart, OAuthPollResult,
    SyncAccountInfo, SyncConfigUpdateInput, SyncConfigView, SyncCounts, SyncCredentials,
    SyncEnvelope, SyncLocalState, SyncOperationResult, SyncPayload, SyncScopes, SyncStatusState,
    SyncTargetMode, SyncTestResult, SyncTombstones, SyncedSnippet,
};

const SYNC_PLUGIN_ID: &str = "lighterm.sync";
const CONFIG_FILE: &str = "github-sync-config.json";
const CREDENTIALS_FILE: &str = "github-sync-credentials.json";
const STATE_FILE: &str = "github-sync-state.json";
const SNIPPETS_FILE: &str = "snippets.json";
const ENVELOPE_FORMAT: &str = "lighterm-sync";
const ENVELOPE_VERSION: u32 = 1;
pub const DEFAULT_GITHUB_CLIENT_ID: &str = "Ov23li5PiJ6fLONB4O07";
const BUILTIN_CLIENT_ID: Option<&str> = option_env!("LIGHTERM_GITHUB_CLIENT_ID");

#[derive(Debug, Clone)]
struct PendingOAuthSession {
    flow_id: String,
    client_id: String,
    device_code: String,
    oauth_base_url: String,
    api_base_url: String,
    mode: SyncTargetMode,
    gist_file_name: String,
    expires_at_ms: i64,
    interval: u64,
}

#[derive(Default)]
pub struct SyncPlugin {
    storage: RwLock<Option<Arc<Storage>>>,
    pending_oauth: RwLock<Option<PendingOAuthSession>>,
    sync_lock: tokio::sync::Mutex<()>,
}

fn generate_flow_id() -> CoreResult<String> {
    let rng = SystemRandom::new();
    let mut bytes = [0u8; 16];
    rng.fill(&mut bytes)
        .map_err(|_| CoreError::PluginError("Failed to generate OAuth flow ID".to_string()))?;
    let mut out = String::with_capacity(32);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    Ok(out)
}

fn parse_oauth_scopes(raw: &str) -> Vec<String> {
    raw.split(|c: char| c.is_whitespace() || c == ',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .collect()
}

pub fn resolve_oauth_client_id(config: &GitHubSyncConfig) -> (Option<String>, &'static str) {
    let custom = config.oauth_client_id.trim();
    if !custom.is_empty() {
        return (Some(custom.to_string()), "custom");
    }
    if let Ok(env_id) = std::env::var("LIGHTERM_GITHUB_CLIENT_ID") {
        let trimmed = env_id.trim();
        if !trimmed.is_empty() {
            return (Some(trimmed.to_string()), "env");
        }
    }
    if let Some(builtin) = BUILTIN_CLIENT_ID {
        let trimmed = builtin.trim();
        if !trimmed.is_empty() {
            return (Some(trimmed.to_string()), "builtin");
        }
    }
    let default_id = DEFAULT_GITHUB_CLIENT_ID.trim();
    if !default_id.is_empty() {
        return (Some(default_id.to_string()), "builtin");
    }
    (None, "none")
}

impl SyncPlugin {
    pub fn new() -> Self {
        Self::default()
    }

    fn require_storage(&self) -> CoreResult<Arc<Storage>> {
        self.storage
            .read()
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| CoreError::PluginDisabled(SYNC_PLUGIN_ID.to_string()))
    }

    fn load_config(storage: &Storage) -> CoreResult<GitHubSyncConfig> {
        let mut cfg: GitHubSyncConfig = storage.read_plugin_json(CONFIG_FILE)?;
        if cfg.api_base_url.trim().is_empty() {
            cfg.api_base_url = "https://api.github.com".to_string();
        }
        if cfg.oauth_base_url.trim().is_empty() {
            cfg.oauth_base_url = "https://github.com".to_string();
        }
        if cfg.gist_file_name.trim().is_empty() {
            cfg.gist_file_name = "lighterm-sync.json".to_string();
        }
        if cfg.repo_name.trim().is_empty() {
            cfg.repo_name = "lighterm-sync".to_string();
        }
        if cfg.repo_branch.trim().is_empty() {
            cfg.repo_branch = "main".to_string();
        }
        if cfg.repo_file_path.trim().is_empty() {
            cfg.repo_file_path = "lighterm-sync.json".to_string();
        }
        if cfg.device_name.trim().is_empty() {
            cfg.device_name = models::default_device_name();
        }
        Ok(cfg)
    }

    fn load_credentials(storage: &Storage) -> CoreResult<SyncCredentials> {
        storage.read_plugin_json(CREDENTIALS_FILE)
    }

    fn save_credentials(storage: &Storage, creds: &SyncCredentials) -> CoreResult<()> {
        storage.write_plugin_json(CREDENTIALS_FILE, creds, true)
    }

    fn load_local_state(storage: &Storage) -> CoreResult<SyncLocalState> {
        storage.read_plugin_json(STATE_FILE)
    }

    fn save_local_state(storage: &Storage, state: &SyncLocalState) -> CoreResult<()> {
        storage.write_plugin_json(STATE_FILE, state, false)
    }

    fn normalize_config(mut config: GitHubSyncConfig) -> GitHubSyncConfig {
        config.api_base_url = config.api_base_url.trim().trim_end_matches('/').to_string();
        if config.api_base_url.is_empty() {
            config.api_base_url = "https://api.github.com".to_string();
        }
        config.oauth_base_url = config.oauth_base_url.trim().trim_end_matches('/').to_string();
        if config.oauth_base_url.is_empty() {
            config.oauth_base_url = "https://github.com".to_string();
        }
        config.oauth_client_id = config.oauth_client_id.trim().to_string();
        config.gist_id = config.gist_id.trim().to_string();
        config.gist_file_name = config.gist_file_name.trim().to_string();
        if config.gist_file_name.is_empty() {
            config.gist_file_name = "lighterm-sync.json".to_string();
        }
        config.repo_owner = config.repo_owner.trim().to_string();
        config.repo_name = config.repo_name.trim().to_string();
        if config.repo_name.is_empty() {
            config.repo_name = "lighterm-sync".to_string();
        }
        config.repo_branch = config.repo_branch.trim().to_string();
        if config.repo_branch.is_empty() {
            config.repo_branch = "main".to_string();
        }
        config.repo_file_path = config
            .repo_file_path
            .trim()
            .trim_start_matches('/')
            .to_string();
        if config.repo_file_path.is_empty() {
            config.repo_file_path = "lighterm-sync.json".to_string();
        }
        config.device_name = config.device_name.trim().to_string();
        if config.device_name.is_empty() {
            config.device_name = models::default_device_name();
        }
        config
    }

    fn build_config_view(
        config: GitHubSyncConfig,
        creds: SyncCredentials,
        state: SyncLocalState,
    ) -> SyncConfigView {
        let (resolved_id, source) = resolve_oauth_client_id(&config);
        let is_authenticated = !creds.access_token.trim().is_empty();
        let account = if is_authenticated {
            creds
                .account_login
                .or_else(|| state.status.remote_account.clone())
                .map(|login| SyncAccountInfo {
                    login,
                    name: creds.account_name,
                    avatar_url: creds.account_avatar_url,
                })
        } else {
            None
        };

        SyncConfigView {
            config,
            is_authenticated,
            account,
            oauth_scopes: if is_authenticated {
                creds.scopes
            } else {
                Vec::new()
            },
            oauth_client_configured: resolved_id.is_some(),
            oauth_client_id_source: source.to_string(),
            has_passphrase: !creds.encryption_passphrase.trim().is_empty(),
            status: state.status,
        }
    }

    pub fn get_config_view(&self) -> CoreResult<SyncConfigView> {
        let storage = self.require_storage()?;
        let config = Self::load_config(&storage)?;
        let creds = Self::load_credentials(&storage)?;
        let state = Self::load_local_state(&storage)?;
        Ok(Self::build_config_view(config, creds, state))
    }

    pub fn save_config(&self, input: SyncConfigUpdateInput) -> CoreResult<SyncConfigView> {
        let storage = self.require_storage()?;
        let config = Self::normalize_config(input.config);

        let mut creds = Self::load_credentials(&storage)?;
        if let Some(pass) = input.encryption_passphrase {
            creds.encryption_passphrase = pass;
        }

        if config.scopes.include_host_secrets && creds.encryption_passphrase.trim().is_empty() {
            return Err(CoreError::InvalidInput(
                "An Encryption Passphrase is required when syncing SSH passwords, private keys, or passphrases."
                    .to_string(),
            ));
        }

        storage.write_plugin_json(CONFIG_FILE, &config, false)?;
        Self::save_credentials(&storage, &creds)?;

        self.get_config_view()
    }

    pub fn reset_local_state(&self) -> CoreResult<SyncConfigView> {
        let storage = self.require_storage()?;
        let prev_creds = Self::load_credentials(&storage)?;
        let mut fresh = SyncLocalState::default();
        if !prev_creds.access_token.trim().is_empty() {
            fresh.status.remote_account = prev_creds.account_login;
        }
        Self::save_local_state(&storage, &fresh)?;
        self.get_config_view()
    }

    async fn ensure_valid_access_token(
        &self,
        storage: &Storage,
        config: &GitHubSyncConfig,
        creds: &mut SyncCredentials,
    ) -> CoreResult<String> {
        if creds.access_token.trim().is_empty() {
            return Err(CoreError::AuthFailed(
                "Not signed in to GitHub. Please sign in with GitHub OAuth first.".to_string(),
            ));
        }

        let now_sec = Utc::now().timestamp();
        let needs_refresh = creds
            .token_expires_at
            .is_some_and(|exp| now_sec >= exp - 60);
        if needs_refresh {
            if let (Some(refresh_tok), (Some(client_id), _)) = (
                creds.refresh_token.as_deref().filter(|s| !s.trim().is_empty()),
                resolve_oauth_client_id(config),
            ) {
                let oauth = GitHubOAuthClient::new(&config.oauth_base_url)?;
                let refreshed = oauth.refresh_access_token(&client_id, refresh_tok).await?;
                creds.access_token = refreshed.access_token;
                if let Some(next_rt) = refreshed.refresh_token {
                    creds.refresh_token = Some(next_rt);
                }
                creds.token_expires_at = refreshed.expires_in.map(|secs| Utc::now().timestamp() + secs);
                if !refreshed.scope.trim().is_empty() {
                    creds.scopes = parse_oauth_scopes(&refreshed.scope);
                }
                Self::save_credentials(storage, creds)?;
            }
        }

        Ok(creds.access_token.clone())
    }

    pub async fn start_oauth_device_flow(
        &self,
        config_override: Option<GitHubSyncConfig>,
        open_browser: bool,
    ) -> CoreResult<OAuthDeviceFlowStart> {
        let storage = self.require_storage()?;
        let saved_config = Self::load_config(&storage)?;
        let config = Self::normalize_config(config_override.unwrap_or(saved_config));

        let (Some(client_id), _) = resolve_oauth_client_id(&config) else {
            return Err(CoreError::InvalidInput(
                "GitHub OAuth Client ID is not configured. Set LIGHTERM_GITHUB_CLIENT_ID or enter an OAuth App Client ID in Advanced Options."
                    .to_string(),
            ));
        };

        let scopes = match config.mode {
            SyncTargetMode::Gist => vec!["gist".to_string()],
            SyncTargetMode::Repo => vec!["gist".to_string(), "repo".to_string()],
        };
        let scope_str = scopes.join(" ");

        let oauth = GitHubOAuthClient::new(&config.oauth_base_url)?;
        let resp = oauth.request_device_code(&client_id, &scope_str).await?;

        let flow_id = generate_flow_id()?;
        let expires_at_ms = Utc::now().timestamp_millis() + (resp.expires_in as i64) * 1000;

        let browser_opened = if open_browser && resp.verification_uri.starts_with("https://") {
            open_https_url_in_browser(&resp.verification_uri).is_ok()
        } else {
            false
        };

        *self.pending_oauth.write() = Some(PendingOAuthSession {
            flow_id: flow_id.clone(),
            client_id,
            device_code: resp.device_code,
            oauth_base_url: config.oauth_base_url,
            api_base_url: config.api_base_url,
            mode: config.mode,
            gist_file_name: config.gist_file_name,
            expires_at_ms,
            interval: resp.interval,
        });

        Ok(OAuthDeviceFlowStart {
            flow_id,
            user_code: resp.user_code,
            verification_uri: resp.verification_uri,
            expires_in: resp.expires_in,
            interval: resp.interval,
            scopes,
            browser_opened,
        })
    }

    pub async fn poll_oauth_device_flow(&self, flow_id: &str) -> CoreResult<OAuthPollResult> {
        let storage = self.require_storage()?;
        let session = {
            let guard = self.pending_oauth.read();
            let Some(s) = guard.as_ref() else {
                return Ok(OAuthPollResult {
                    status: "expired".to_string(),
                    interval: None,
                    message: Some("No active GitHub OAuth authorization session.".to_string()),
                    view: None,
                    discovered_gists: Vec::new(),
                });
            };
            if s.flow_id != flow_id {
                return Ok(OAuthPollResult {
                    status: "expired".to_string(),
                    interval: None,
                    message: Some("OAuth authorization session was superseded or cancelled.".to_string()),
                    view: None,
                    discovered_gists: Vec::new(),
                });
            }
            s.clone()
        };

        if Utc::now().timestamp_millis() >= session.expires_at_ms {
            *self.pending_oauth.write() = None;
            return Ok(OAuthPollResult {
                status: "expired".to_string(),
                interval: None,
                message: Some("GitHub OAuth device code expired. Please try again.".to_string()),
                view: None,
                discovered_gists: Vec::new(),
            });
        }

        let oauth = GitHubOAuthClient::new(&session.oauth_base_url)?;
        match oauth
            .poll_device_token(&session.client_id, &session.device_code)
            .await?
        {
            DeviceTokenPollResponse::Pending => Ok(OAuthPollResult {
                status: "pending".to_string(),
                interval: Some(session.interval),
                message: None,
                view: None,
                discovered_gists: Vec::new(),
            }),
            DeviceTokenPollResponse::SlowDown(next_interval) => {
                let updated_interval = next_interval.unwrap_or(session.interval + 5).max(1);
                if let Some(active) = self.pending_oauth.write().as_mut() {
                    if active.flow_id == flow_id {
                        active.interval = updated_interval;
                    }
                }
                Ok(OAuthPollResult {
                    status: "slow_down".to_string(),
                    interval: Some(updated_interval),
                    message: None,
                    view: None,
                    discovered_gists: Vec::new(),
                })
            }
            DeviceTokenPollResponse::Expired => {
                *self.pending_oauth.write() = None;
                Ok(OAuthPollResult {
                    status: "expired".to_string(),
                    interval: None,
                    message: Some("GitHub OAuth device code expired. Please try again.".to_string()),
                    view: None,
                    discovered_gists: Vec::new(),
                })
            }
            DeviceTokenPollResponse::Denied => {
                *self.pending_oauth.write() = None;
                Ok(OAuthPollResult {
                    status: "denied".to_string(),
                    interval: None,
                    message: Some("GitHub authorization was cancelled by the user.".to_string()),
                    view: None,
                    discovered_gists: Vec::new(),
                })
            }
            DeviceTokenPollResponse::Authorized(tok) => {
                let api_client = GitHubClient::new(&session.api_base_url, &tok.access_token)?;
                let user = api_client.verify_user().await?;

                let mut creds = Self::load_credentials(&storage)?;
                creds.access_token = tok.access_token;
                creds.refresh_token = tok.refresh_token;
                creds.token_expires_at = tok
                    .expires_in
                    .map(|secs| Utc::now().timestamp() + secs);
                creds.scopes = if tok.scope.trim().is_empty() {
                    match session.mode {
                        SyncTargetMode::Gist => vec!["gist".to_string()],
                        SyncTargetMode::Repo => vec!["gist".to_string(), "repo".to_string()],
                    }
                } else {
                    parse_oauth_scopes(&tok.scope)
                };
                creds.account_login = Some(user.login.clone());
                creds.account_name = user.name.clone();
                creds.account_avatar_url = user.avatar_url.clone();
                Self::save_credentials(&storage, &creds)?;

                let mut state = Self::load_local_state(&storage)?;
                state.status.remote_account = Some(user.login.clone());
                state.status.last_error = None;
                Self::save_local_state(&storage, &state)?;

                *self.pending_oauth.write() = None;

                let mut discovered_gists = Vec::new();
                if session.mode == SyncTargetMode::Gist {
                    if let Ok(gists) = api_client.discover_sync_gists(&session.gist_file_name).await {
                        discovered_gists = gists;
                        let mut cfg = Self::load_config(&storage)?;
                        if cfg.gist_id.trim().is_empty() {
                            if let Some(first) = discovered_gists.first() {
                                cfg.gist_id = first.id.clone();
                                let _ = storage.write_plugin_json(CONFIG_FILE, &cfg, false);
                            }
                        }
                    }
                }

                let view = self.get_config_view()?;
                Ok(OAuthPollResult {
                    status: "authorized".to_string(),
                    interval: None,
                    message: Some(format!("Signed in as @{}.", user.login)),
                    view: Some(view),
                    discovered_gists,
                })
            }
        }
    }

    pub fn cancel_oauth_device_flow(&self, flow_id: &str) -> CoreResult<()> {
        let _storage = self.require_storage()?;
        let mut guard = self.pending_oauth.write();
        if guard.as_ref().is_some_and(|s| s.flow_id == flow_id) {
            *guard = None;
        }
        Ok(())
    }

    pub fn logout_oauth(&self) -> CoreResult<SyncConfigView> {
        let storage = self.require_storage()?;
        *self.pending_oauth.write() = None;

        let mut creds = Self::load_credentials(&storage)?;
        creds.access_token.clear();
        creds.refresh_token = None;
        creds.token_expires_at = None;
        creds.scopes.clear();
        creds.account_login = None;
        creds.account_name = None;
        creds.account_avatar_url = None;
        Self::save_credentials(&storage, &creds)?;

        let mut state = Self::load_local_state(&storage)?;
        state.status.remote_account = None;
        state.status.last_error = None;
        Self::save_local_state(&storage, &state)?;

        self.get_config_view()
    }

    pub fn open_verification_url(&self, url: &str) -> CoreResult<()> {
        let _storage = self.require_storage()?;
        open_https_url_in_browser(url)
    }

    pub async fn test_connection(
        &self,
        config_override: Option<GitHubSyncConfig>,
    ) -> CoreResult<SyncTestResult> {
        let storage = self.require_storage()?;
        let saved_config = Self::load_config(&storage)?;
        let config = Self::normalize_config(config_override.unwrap_or(saved_config));
        let mut creds = Self::load_credentials(&storage)?;
        let token = self
            .ensure_valid_access_token(&storage, &config, &mut creds)
            .await?;

        let client = GitHubClient::new(&config.api_base_url, &token)?;
        let user = client.verify_user().await?;

        match config.mode {
            SyncTargetMode::Gist => {
                let discovered = client.discover_sync_gists(&config.gist_file_name).await?;
                if !config.gist_id.trim().is_empty() {
                    if let Some(meta) = client.get_gist_meta(&config.gist_id).await? {
                        let msg = if meta.public {
                            format!(
                                "Authenticated as @{}. Warning: Gist {} is PUBLIC — use a Secret Gist or enable Encryption Passphrase.",
                                user.login, meta.id
                            )
                        } else {
                            format!(
                                "Authenticated as @{}. Connected to Secret Gist {}.",
                                user.login, meta.id
                            )
                        };
                        return Ok(SyncTestResult {
                            success: true,
                            username: Some(user.login),
                            target_exists: true,
                            target_url: Some(meta.html_url),
                            is_public_target: meta.public,
                            discovered_gists: discovered,
                            message: msg,
                        });
                    }
                    let msg = format!(
                        "Authenticated as @{}. Configured Gist ID '{}' was not found.",
                        user.login, config.gist_id
                    );
                    return Ok(SyncTestResult {
                        success: true,
                        username: Some(user.login),
                        target_exists: false,
                        target_url: None,
                        is_public_target: false,
                        discovered_gists: discovered,
                        message: msg,
                    });
                }

                let msg = if discovered.is_empty() {
                    format!(
                        "Authenticated as @{}. No existing Lighterm Gist found; a Secret Gist will be created on first Sync/Push.",
                        user.login
                    )
                } else {
                    format!(
                        "Authenticated as @{}. Found {} existing Lighterm Gist(s).",
                        user.login,
                        discovered.len()
                    )
                };
                Ok(SyncTestResult {
                    success: true,
                    username: Some(user.login),
                    target_exists: !discovered.is_empty(),
                    target_url: discovered.first().map(|g| g.html_url.clone()),
                    is_public_target: false,
                    discovered_gists: discovered,
                    message: msg,
                })
            }
            SyncTargetMode::Repo => {
                let owner = if config.repo_owner.trim().is_empty() {
                    user.login.clone()
                } else {
                    config.repo_owner.trim().to_string()
                };
                let repo_name = if config.repo_name.trim().is_empty() {
                    "lighterm-sync".to_string()
                } else {
                    config.repo_name.trim().to_string()
                };

                if let Some(info) = client.get_repo(&owner, &repo_name).await? {
                    let msg = if !info.private {
                        format!(
                            "Authenticated as @{}. Warning: Repository {}/{} is PUBLIC!",
                            user.login, info.owner, info.name
                        )
                    } else {
                        format!(
                            "Authenticated as @{}. Private repository {}/{} is ready.",
                            user.login, info.owner, info.name
                        )
                    };
                    Ok(SyncTestResult {
                        success: true,
                        username: Some(user.login),
                        target_exists: true,
                        target_url: Some(info.html_url),
                        is_public_target: !info.private,
                        discovered_gists: Vec::new(),
                        message: msg,
                    })
                } else {
                    let hint = if config.auto_create_target {
                        "It will be created as a private repository on first Push/Sync."
                    } else {
                        "Enable 'Auto-create private repository' or create it manually on GitHub."
                    };
                    Ok(SyncTestResult {
                        success: true,
                        username: Some(user.login),
                        target_exists: false,
                        target_url: None,
                        is_public_target: false,
                        discovered_gists: Vec::new(),
                        message: format!(
                            "Authenticated as @{}. Repository {}/{} does not exist yet. {}",
                            owner, owner, repo_name, hint
                        ),
                    })
                }
            }
        }
    }

    pub async fn discover_gists(
        &self,
        api_base_url: Option<String>,
        file_name: Option<String>,
    ) -> CoreResult<Vec<DiscoveredGist>> {
        let storage = self.require_storage()?;
        let config = Self::load_config(&storage)?;
        let mut creds = Self::load_credentials(&storage)?;
        let token = self
            .ensure_valid_access_token(&storage, &config, &mut creds)
            .await?;
        let base_url = api_base_url
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .unwrap_or(config.api_base_url);
        let fname = file_name
            .map(|f| f.trim().to_string())
            .filter(|f| !f.is_empty())
            .unwrap_or(config.gist_file_name);

        let client = GitHubClient::new(&base_url, &token)?;
        client.discover_sync_gists(&fname).await
    }

    pub async fn sync_now(&self) -> CoreResult<SyncOperationResult> {
        self.run_operation("sync").await
    }

    pub async fn push(&self) -> CoreResult<SyncOperationResult> {
        self.run_operation("push").await
    }

    pub async fn pull(&self) -> CoreResult<SyncOperationResult> {
        self.run_operation("pull").await
    }

    async fn run_operation(&self, action: &str) -> CoreResult<SyncOperationResult> {
        let storage = self.require_storage()?;
        let _op_guard = self.sync_lock.lock().await;

        let res = self.execute_operation(&storage, action).await;
        if let Err(err) = &res {
            if let Ok(mut state) = Self::load_local_state(&storage) {
                state.status.last_action = Some(action.to_string());
                state.status.last_status = Some("error".to_string());
                state.status.last_error = Some(err.to_string());
                let _ = Self::save_local_state(&storage, &state);
            }
        }
        res
    }

    async fn execute_operation(
        &self,
        storage: &Arc<Storage>,
        action: &str,
    ) -> CoreResult<SyncOperationResult> {
        let mut config = Self::load_config(storage)?;
        let mut creds = Self::load_credentials(storage)?;
        let mut state = Self::load_local_state(storage)?;
        let now_ms = Utc::now().timestamp_millis();

        if (action == "push" || action == "sync")
            && config.scopes.include_host_secrets
            && creds.encryption_passphrase.trim().is_empty()
        {
            return Err(CoreError::InvalidInput(
                "An Encryption Passphrase is required when syncing SSH passwords, private keys, or passphrases."
                    .to_string(),
            ));
        }

        let token = self
            .ensure_valid_access_token(storage, &config, &mut creds)
            .await?;
        let client = GitHubClient::new(&config.api_base_url, &token)?;
        let user = client.verify_user().await?;

        // Read local snapshot
        let local_hosts: Vec<HostConfig> = storage.list_hosts()?;
        let local_settings: AppSettings = storage.get_settings()?;
        let local_workspaces: Vec<SavedWorkspace> = storage.list_workspaces()?;
        let local_snippets: Vec<SyncedSnippet> = storage.read_plugin_json(SNIPPETS_FILE)?;
        let local_plugin_states: HashMap<String, bool> = storage.get_plugin_states()?;
        let local_plugin_configs: HashMap<String, serde_json::Value> =
            storage.get_all_plugin_configs()?;

        // Update local tombstones for items deleted since last sync
        let host_ids: HashSet<String> = local_hosts.iter().map(|h| h.id.clone()).collect();
        collect_local_deletions(
            &state.last_synced_host_ids,
            &host_ids,
            &mut state.local_tombstones.hosts,
            now_ms,
        );
        let ws_ids: HashSet<String> = local_workspaces.iter().map(|w| w.id.clone()).collect();
        collect_local_deletions(
            &state.last_synced_workspace_ids,
            &ws_ids,
            &mut state.local_tombstones.workspaces,
            now_ms,
        );
        let snip_ids: HashSet<String> = local_snippets.iter().map(|s| s.id.clone()).collect();
        collect_local_deletions(
            &state.last_synced_snippet_ids,
            &snip_ids,
            &mut state.local_tombstones.snippets,
            now_ms,
        );

        // Locate & fetch remote envelope (if present)
        let mut resolved_owner: Option<String> = None;
        let mut resolved_gist_id: Option<String> = None;
        let mut remote_file_sha: Option<String> = None;
        let mut remote_url: Option<String> = None;

        let remote_raw = match config.mode {
            SyncTargetMode::Gist => {
                if config.gist_id.trim().is_empty() {
                    let discovered = client.discover_sync_gists(&config.gist_file_name).await?;
                    if let Some(first) = discovered.first() {
                        config.gist_id = first.id.clone();
                        storage.write_plugin_json(CONFIG_FILE, &config, false)?;
                    }
                }

                if config.gist_id.trim().is_empty() {
                    None
                } else {
                    let cached_id = config.gist_id.clone();
                    let mut rf = client
                        .fetch_gist(&cached_id, &config.gist_file_name)
                        .await?;
                    if rf.is_none() {
                        let discovered = client.discover_sync_gists(&config.gist_file_name).await?;
                        if let Some(alt) = discovered.into_iter().find(|g| g.id != cached_id) {
                            config.gist_id = alt.id.clone();
                            storage.write_plugin_json(CONFIG_FILE, &config, false)?;
                            resolved_gist_id = Some(config.gist_id.clone());
                            rf = client
                                .fetch_gist(&config.gist_id, &config.gist_file_name)
                                .await?;
                        } else if action != "pull" && config.auto_create_target {
                            config.gist_id.clear();
                            storage.write_plugin_json(CONFIG_FILE, &config, false)?;
                            resolved_gist_id = None;
                        } else {
                            resolved_gist_id = Some(cached_id);
                        }
                    } else {
                        resolved_gist_id = Some(cached_id);
                    }
                    if let Some(ref file) = rf {
                        remote_url = file.html_url.clone();
                    }
                    rf
                }
            }
            SyncTargetMode::Repo => {
                let owner = if config.repo_owner.trim().is_empty() {
                    config.repo_owner = user.login.clone();
                    storage.write_plugin_json(CONFIG_FILE, &config, false)?;
                    user.login.clone()
                } else {
                    config.repo_owner.trim().to_string()
                };
                resolved_owner = Some(owner.clone());

                let repo_opt = client.get_repo(&owner, &config.repo_name).await?;
                if repo_opt.is_none() {
                    if action == "pull" || !config.auto_create_target {
                        return Err(CoreError::PluginError(format!(
                            "GitHub repository {}/{} was not found",
                            owner, config.repo_name
                        )));
                    }
                    let created = client.create_private_repo(&config.repo_name).await?;
                    if config.repo_branch.trim().is_empty() {
                        config.repo_branch = created.default_branch.clone();
                        storage.write_plugin_json(CONFIG_FILE, &config, false)?;
                    }
                    remote_url = Some(created.html_url);
                    None
                } else {
                    let repo_info = repo_opt.unwrap();
                    remote_url = Some(repo_info.html_url);
                    let rf = client
                        .fetch_repo_file(
                            &owner,
                            &config.repo_name,
                            &config.repo_branch,
                            &config.repo_file_path,
                        )
                        .await?;
                    if let Some(ref file) = rf {
                        remote_file_sha = file.sha.clone();
                        if file.html_url.is_some() {
                            remote_url = file.html_url.clone();
                        }
                    }
                    rf
                }
            }
        };

        let remote_envelope: Option<SyncEnvelope> = match remote_raw {
            Some(rf) if !rf.content.trim().is_empty() => {
                let env: SyncEnvelope = serde_json::from_str(&rf.content).map_err(|e| {
                    CoreError::PluginError(format!("Failed to parse remote sync envelope: {e}"))
                })?;
                if env.format != ENVELOPE_FORMAT {
                    return Err(CoreError::InvalidInput(format!(
                        "Unexpected remote sync format '{}'",
                        env.format
                    )));
                }
                Some(env)
            }
            _ => None,
        };

        let remote_decoded: Option<(SyncEnvelope, SyncPayload)> = match remote_envelope {
            Some(env) => {
                let payload = if env.encrypted {
                    let enc = env.encryption.as_ref().ok_or_else(|| {
                        CoreError::PluginError("Remote sync envelope missing encryption block".to_string())
                    })?;
                    decrypt_payload(enc, &creds.encryption_passphrase)?
                } else {
                    env.payload.clone().ok_or_else(|| {
                        CoreError::PluginError("Remote sync envelope missing payload".to_string())
                    })?
                };
                Some((env, payload))
            }
            None => None,
        };

        let is_first_sync = state.status.last_sync_at.is_none();

        let (
            final_hosts,
            final_settings,
            final_workspaces,
            final_snippets,
            final_plugin_states,
            final_plugin_configs,
            final_tombstones,
            apply_local,
            push_remote,
            remote_updated_at,
            remote_device,
        ) = match action {
            "pull" => {
                let (env, r_payload) = remote_decoded.as_ref().ok_or_else(|| {
                    CoreError::PluginError(
                        "No remote configuration data found on GitHub to pull.".to_string(),
                    )
                })?;

                let next_hosts = if config.scopes.hosts {
                    if let Some(ref r_hosts) = r_payload.hosts {
                        let local_map: HashMap<&str, &HostConfig> =
                            local_hosts.iter().map(|h| (h.id.as_str(), h)).collect();
                        if r_payload.hosts_include_secrets {
                            r_hosts.clone()
                        } else {
                            r_hosts
                                .iter()
                                .map(|h| {
                                    crate::merge::preserve_local_secrets(
                                        h,
                                        local_map.get(h.id.as_str()).copied(),
                                    )
                                })
                                .collect()
                        }
                    } else {
                        local_hosts.clone()
                    }
                } else {
                    local_hosts.clone()
                };

                let next_settings = if config.scopes.settings {
                    r_payload.settings.clone().unwrap_or_else(|| local_settings.clone())
                } else {
                    local_settings.clone()
                };

                let next_workspaces = if config.scopes.workspaces {
                    r_payload
                        .workspaces
                        .clone()
                        .unwrap_or_else(|| local_workspaces.clone())
                } else {
                    local_workspaces.clone()
                };

                let next_snippets = if config.scopes.snippets {
                    r_payload
                        .snippets
                        .clone()
                        .unwrap_or_else(|| local_snippets.clone())
                } else {
                    local_snippets.clone()
                };

                let (next_p_states, next_p_configs) = if config.scopes.plugins {
                    let mut p_states = local_plugin_states.clone();
                    if let Some(ref rs) = r_payload.plugin_states {
                        for (k, v) in rs {
                            if k != SYNC_PLUGIN_ID {
                                p_states.insert(k.clone(), *v);
                            }
                        }
                    }
                    let mut p_configs = filter_plugin_configs_for_sync(&local_plugin_configs, SYNC_PLUGIN_ID);
                    if let Some(ref rc) = r_payload.plugin_configs {
                        p_configs = filter_plugin_configs_for_sync(rc, SYNC_PLUGIN_ID);
                    }
                    if let Some(sync_cfg) = local_plugin_configs.get(SYNC_PLUGIN_ID) {
                        p_configs.insert(SYNC_PLUGIN_ID.to_string(), sync_cfg.clone());
                    }
                    (p_states, p_configs)
                } else {
                    (local_plugin_states.clone(), local_plugin_configs.clone())
                };

                let tombs = merge_tombstones(
                    &state.local_tombstones.hosts,
                    &r_payload.tombstones.hosts,
                    now_ms,
                );
                let ws_tombs = merge_tombstones(
                    &state.local_tombstones.workspaces,
                    &r_payload.tombstones.workspaces,
                    now_ms,
                );
                let snip_tombs = merge_tombstones(
                    &state.local_tombstones.snippets,
                    &r_payload.tombstones.snippets,
                    now_ms,
                );

                (
                    next_hosts,
                    next_settings,
                    next_workspaces,
                    next_snippets,
                    next_p_states,
                    next_p_configs,
                    SyncTombstones {
                        hosts: tombs,
                        workspaces: ws_tombs,
                        snippets: snip_tombs,
                    },
                    true,
                    false,
                    Some(env.updated_at),
                    Some(env.device_name.clone()),
                )
            }
            "push" => {
                let mut tombs = state.local_tombstones.clone();
                if let Some((_, ref r_payload)) = remote_decoded {
                    tombs.hosts = merge_tombstones(&tombs.hosts, &r_payload.tombstones.hosts, now_ms);
                    tombs.workspaces =
                        merge_tombstones(&tombs.workspaces, &r_payload.tombstones.workspaces, now_ms);
                    tombs.snippets =
                        merge_tombstones(&tombs.snippets, &r_payload.tombstones.snippets, now_ms);
                }

                (
                    local_hosts.clone(),
                    local_settings.clone(),
                    local_workspaces.clone(),
                    local_snippets.clone(),
                    local_plugin_states.clone(),
                    local_plugin_configs.clone(),
                    tombs,
                    false,
                    true,
                    Some(now_ms),
                    Some(config.device_name.clone()),
                )
            }
            _ => {
                // "sync" (smart 2-way merge)
                if let Some((ref env, ref r_payload)) = remote_decoded {
                    let mut tombs = SyncTombstones {
                        hosts: merge_tombstones(
                            &state.local_tombstones.hosts,
                            &r_payload.tombstones.hosts,
                            now_ms,
                        ),
                        workspaces: merge_tombstones(
                            &state.local_tombstones.workspaces,
                            &r_payload.tombstones.workspaces,
                            now_ms,
                        ),
                        snippets: merge_tombstones(
                            &state.local_tombstones.snippets,
                            &r_payload.tombstones.snippets,
                            now_ms,
                        ),
                    };

                    let next_hosts = if config.scopes.hosts {
                        if let Some(ref r_hosts) = r_payload.hosts {
                            merge_hosts(
                                &local_hosts,
                                r_hosts,
                                &mut tombs.hosts,
                                config.conflict_resolution,
                                r_payload.hosts_include_secrets,
                            )
                        } else {
                            local_hosts.clone()
                        }
                    } else {
                        local_hosts.clone()
                    };

                    let next_settings = if config.scopes.settings {
                        if let Some(ref r_settings) = r_payload.settings {
                            merge_settings(
                                &local_settings,
                                r_settings,
                                state.last_settings_hash.as_deref(),
                                config.conflict_resolution,
                                is_first_sync,
                            )?
                        } else {
                            local_settings.clone()
                        }
                    } else {
                        local_settings.clone()
                    };

                    let next_workspaces = if config.scopes.workspaces {
                        if let Some(ref r_ws) = r_payload.workspaces {
                            merge_entities(
                                &local_workspaces,
                                r_ws,
                                &mut tombs.workspaces,
                                config.conflict_resolution,
                            )
                        } else {
                            local_workspaces.clone()
                        }
                    } else {
                        local_workspaces.clone()
                    };

                    let next_snippets = if config.scopes.snippets {
                        if let Some(ref r_snip) = r_payload.snippets {
                            merge_snippets(
                                &local_snippets,
                                r_snip,
                                &mut tombs.snippets,
                                config.conflict_resolution,
                                is_first_sync,
                            )
                        } else {
                            local_snippets.clone()
                        }
                    } else {
                        local_snippets.clone()
                    };

                    let (next_p_states, next_p_configs) = if config.scopes.plugins {
                        let l_bundle = PluginBundle {
                            plugin_states: filter_plugin_states_for_sync(
                                &local_plugin_states,
                                SYNC_PLUGIN_ID,
                            ),
                            plugin_configs: filter_plugin_configs_for_sync(
                                &local_plugin_configs,
                                SYNC_PLUGIN_ID,
                            ),
                        };
                        let r_bundle = PluginBundle {
                            plugin_states: filter_plugin_states_for_sync(
                                r_payload.plugin_states.as_ref().unwrap_or(&local_plugin_states),
                                SYNC_PLUGIN_ID,
                            ),
                            plugin_configs: filter_plugin_configs_for_sync(
                                r_payload.plugin_configs.as_ref().unwrap_or(&local_plugin_configs),
                                SYNC_PLUGIN_ID,
                            ),
                        };
                        let merged_bundle = merge_singleton(
                            &l_bundle,
                            &r_bundle,
                            state.last_plugins_hash.as_deref(),
                            config.conflict_resolution,
                            is_first_sync,
                            None,
                        )?;
                        let mut full_states = merged_bundle.plugin_states;
                        if let Some(sync_enabled) = local_plugin_states.get(SYNC_PLUGIN_ID) {
                            full_states.insert(SYNC_PLUGIN_ID.to_string(), *sync_enabled);
                        }
                        let mut full_configs = merged_bundle.plugin_configs;
                        if let Some(sync_cfg) = local_plugin_configs.get(SYNC_PLUGIN_ID) {
                            full_configs.insert(SYNC_PLUGIN_ID.to_string(), sync_cfg.clone());
                        }
                        (full_states, full_configs)
                    } else {
                        (local_plugin_states.clone(), local_plugin_configs.clone())
                    };

                    (
                        next_hosts,
                        next_settings,
                        next_workspaces,
                        next_snippets,
                        next_p_states,
                        next_p_configs,
                        tombs,
                        true,
                        true,
                        Some(env.updated_at),
                        Some(env.device_name.clone()),
                    )
                } else {
                    (
                        local_hosts.clone(),
                        local_settings.clone(),
                        local_workspaces.clone(),
                        local_snippets.clone(),
                        local_plugin_states.clone(),
                        local_plugin_configs.clone(),
                        state.local_tombstones.clone(),
                        false,
                        true,
                        Some(now_ms),
                        Some(config.device_name.clone()),
                    )
                }
            }
        };

        // Check what changed locally
        let hosts_changed = sha256_hex(&local_hosts)? != sha256_hex(&final_hosts)?;
        let settings_changed = sha256_hex(&local_settings)? != sha256_hex(&final_settings)?;
        let workspaces_changed =
            sha256_hex(&local_workspaces)? != sha256_hex(&final_workspaces)?;
        let snippets_changed = sha256_hex(&local_snippets)? != sha256_hex(&final_snippets)?;
        let plugin_states_changed =
            sha256_hex(&local_plugin_states)? != sha256_hex(&final_plugin_states)?;
        let plugin_configs_changed =
            sha256_hex(&local_plugin_configs)? != sha256_hex(&final_plugin_configs)?;

        let mut applied_local = false;
        let mut invalidated_host_ids = Vec::new();
        let mut updated_plugin_states = HashMap::new();

        if apply_local {
            if config.scopes.hosts && hosts_changed {
                invalidated_host_ids = compute_invalidated_host_ids(&local_hosts, &final_hosts);
                storage.replace_hosts(&final_hosts)?;
                applied_local = true;
            }
            if config.scopes.settings && settings_changed {
                storage.save_settings(final_settings.clone())?;
                applied_local = true;
            }
            if config.scopes.workspaces && workspaces_changed {
                storage.replace_workspaces(&final_workspaces)?;
                applied_local = true;
            }
            if config.scopes.snippets && snippets_changed {
                storage.write_plugin_json(SNIPPETS_FILE, &final_snippets, false)?;
                applied_local = true;
            }
            if config.scopes.plugins {
                if plugin_states_changed {
                    storage.save_plugin_states(&final_plugin_states)?;
                    updated_plugin_states =
                        filter_plugin_states_for_sync(&final_plugin_states, SYNC_PLUGIN_ID);
                    applied_local = true;
                }
                if plugin_configs_changed {
                    storage.save_all_plugin_configs(&final_plugin_configs)?;
                    applied_local = true;
                }
            }
        }

        // Build outgoing remote payload (carrying forward un-synced remote scopes when present)
        let prev_remote_payload = remote_decoded.as_ref().map(|(_, p)| p);
        let outgoing_hosts = if config.scopes.hosts {
            Some(if config.scopes.include_host_secrets {
                final_hosts.clone()
            } else {
                final_hosts.iter().map(strip_host_secrets).collect()
            })
        } else {
            prev_remote_payload.and_then(|p| p.hosts.clone())
        };

        let outgoing_payload = SyncPayload {
            hosts: outgoing_hosts,
            hosts_include_secrets: if config.scopes.hosts {
                config.scopes.include_host_secrets
            } else {
                prev_remote_payload.is_some_and(|p| p.hosts_include_secrets)
            },
            settings: if config.scopes.settings {
                Some(final_settings.clone())
            } else {
                prev_remote_payload.and_then(|p| p.settings.clone())
            },
            workspaces: if config.scopes.workspaces {
                Some(final_workspaces.clone())
            } else {
                prev_remote_payload.and_then(|p| p.workspaces.clone())
            },
            snippets: if config.scopes.snippets {
                Some(final_snippets.clone())
            } else {
                prev_remote_payload.and_then(|p| p.snippets.clone())
            },
            plugin_states: if config.scopes.plugins {
                Some(filter_plugin_states_for_sync(
                    &final_plugin_states,
                    SYNC_PLUGIN_ID,
                ))
            } else {
                prev_remote_payload.and_then(|p| p.plugin_states.clone())
            },
            plugin_configs: if config.scopes.plugins {
                Some(filter_plugin_configs_for_sync(
                    &final_plugin_configs,
                    SYNC_PLUGIN_ID,
                ))
            } else {
                prev_remote_payload.and_then(|p| p.plugin_configs.clone())
            },
            tombstones: final_tombstones.clone(),
        };

        let will_encrypt = !creds.encryption_passphrase.trim().is_empty();
        let should_skip_upload = if action == "sync" {
            if let Some((ref r_env, ref r_payload)) = remote_decoded {
                r_env.encrypted == will_encrypt
                    && sha256_hex(r_payload)? == sha256_hex(&outgoing_payload)?
            } else {
                false
            }
        } else {
            false
        };

        let mut pushed_remote = false;
        let mut final_remote_updated_at = remote_updated_at;
        let mut final_remote_device = remote_device;

        if push_remote && !should_skip_upload {
            let envelope = if will_encrypt {
                SyncEnvelope {
                    format: ENVELOPE_FORMAT.to_string(),
                    version: ENVELOPE_VERSION,
                    encrypted: true,
                    updated_at: now_ms,
                    device_name: config.device_name.clone(),
                    app_version: env!("CARGO_PKG_VERSION").to_string(),
                    payload: None,
                    encryption: Some(encrypt_payload(
                        &outgoing_payload,
                        &creds.encryption_passphrase,
                    )?),
                }
            } else {
                SyncEnvelope {
                    format: ENVELOPE_FORMAT.to_string(),
                    version: ENVELOPE_VERSION,
                    encrypted: false,
                    updated_at: now_ms,
                    device_name: config.device_name.clone(),
                    app_version: env!("CARGO_PKG_VERSION").to_string(),
                    payload: Some(outgoing_payload.clone()),
                    encryption: None,
                }
            };

            let json_content = serde_json::to_string_pretty(&envelope).map_err(|e| {
                CoreError::PluginError(format!("Failed to serialize sync envelope: {e}"))
            })?;

            match config.mode {
                SyncTargetMode::Gist => {
                    if config.gist_id.trim().is_empty() {
                        if !config.auto_create_target {
                            return Err(CoreError::InvalidInput(
                                "Gist ID is empty and auto-creation is disabled".to_string(),
                            ));
                        }
                        let created = client
                            .create_gist(&config.gist_file_name, &json_content)
                            .await?;
                        if let Some(new_id) = created.id {
                            config.gist_id = new_id.clone();
                            resolved_gist_id = Some(new_id);
                            storage.write_plugin_json(CONFIG_FILE, &config, false)?;
                        }
                        if created.html_url.is_some() {
                            remote_url = created.html_url;
                        }
                    } else {
                        let updated = client
                            .update_gist(&config.gist_id, &config.gist_file_name, &json_content)
                            .await?;
                        resolved_gist_id = Some(config.gist_id.clone());
                        if updated.html_url.is_some() {
                            remote_url = updated.html_url;
                        }
                    }
                }
                SyncTargetMode::Repo => {
                    let owner = resolved_owner
                        .clone()
                        .unwrap_or_else(|| user.login.clone());
                    let msg = format!(
                        "sync: update Lighterm config from {}",
                        config.device_name
                    );
                    let updated = client
                        .put_repo_file(
                            &owner,
                            &config.repo_name,
                            &config.repo_branch,
                            &config.repo_file_path,
                            &json_content,
                            remote_file_sha.as_deref(),
                            &msg,
                        )
                        .await?;
                    if updated.html_url.is_some() {
                        remote_url = updated.html_url;
                    }
                }
            }

            pushed_remote = true;
            final_remote_updated_at = Some(now_ms);
            final_remote_device = Some(config.device_name.clone());
        }

        let summary = match (action, applied_local, pushed_remote) {
            ("push", _, true) => format!(
                "Pushed {} hosts, {} workspaces, {} snippets to GitHub",
                final_hosts.len(),
                final_workspaces.len(),
                final_snippets.len()
            ),
            ("pull", true, _) => format!(
                "Pulled {} hosts, {} workspaces, {} snippets from GitHub",
                final_hosts.len(),
                final_workspaces.len(),
                final_snippets.len()
            ),
            ("pull", false, _) => "Local configuration is already up to date with GitHub".to_string(),
            (_, true, true) => format!(
                "Synced (updated local & GitHub): {} hosts, {} workspaces, {} snippets",
                final_hosts.len(),
                final_workspaces.len(),
                final_snippets.len()
            ),
            (_, true, false) => format!(
                "Synced from GitHub: {} hosts, {} workspaces, {} snippets",
                final_hosts.len(),
                final_workspaces.len(),
                final_snippets.len()
            ),
            (_, false, true) => format!(
                "Synced to GitHub: {} hosts, {} workspaces, {} snippets",
                final_hosts.len(),
                final_workspaces.len(),
                final_snippets.len()
            ),
            (_, false, false) => "Everything is already in sync".to_string(),
        };

        let effective_encrypted = if pushed_remote {
            will_encrypt
        } else {
            remote_decoded.as_ref().is_some_and(|(e, _)| e.encrypted)
        };

        let status = SyncStatusState {
            last_sync_at: Some(now_ms),
            last_action: Some(action.to_string()),
            last_status: Some("ok".to_string()),
            last_message: Some(summary.clone()),
            last_error: None,
            last_remote_updated_at: final_remote_updated_at,
            last_remote_device: final_remote_device,
            remote_account: Some(user.login),
            remote_url: remote_url.clone(),
            remote_encrypted: Some(effective_encrypted),
        };

        let plugin_bundle = PluginBundle {
            plugin_states: filter_plugin_states_for_sync(&final_plugin_states, SYNC_PLUGIN_ID),
            plugin_configs: filter_plugin_configs_for_sync(&final_plugin_configs, SYNC_PLUGIN_ID),
        };

        let next_state = SyncLocalState {
            status: status.clone(),
            last_synced_host_ids: final_hosts.iter().map(|h| h.id.clone()).collect(),
            last_synced_workspace_ids: final_workspaces.iter().map(|w| w.id.clone()).collect(),
            last_synced_snippet_ids: final_snippets.iter().map(|s| s.id.clone()).collect(),
            last_settings_hash: Some(sha256_hex(&final_settings)?),
            last_plugins_hash: Some(sha256_hex(&plugin_bundle)?),
            local_tombstones: final_tombstones,
        };
        Self::save_local_state(storage, &next_state)?;

        Ok(SyncOperationResult {
            action: action.to_string(),
            applied_local,
            pushed_remote,
            encrypted: effective_encrypted,
            remote_url,
            gist_id: resolved_gist_id,
            repo_owner: resolved_owner,
            remote_updated_at: final_remote_updated_at,
            summary,
            counts: SyncCounts {
                hosts: final_hosts.len(),
                workspaces: final_workspaces.len(),
                snippets: final_snippets.len(),
                settings_updated: apply_local && settings_changed,
                plugins_updated: apply_local && (plugin_states_changed || plugin_configs_changed),
            },
            status,
            invalidated_host_ids,
            updated_plugin_states,
        })
    }
}

impl CorePlugin for SyncPlugin {
    fn id(&self) -> &'static str {
        SYNC_PLUGIN_ID
    }

    fn name(&self) -> &'static str {
        "GitHub Config Sync"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "Synchronize SSH hosts, settings, workspaces, snippets, and plugin configs across devices via GitHub"
    }

    fn always_on(&self) -> bool {
        false
    }

    fn on_activate(&self, ctx: &CoreContext) -> CoreResult<()> {
        *self.storage.write() = Some(Arc::clone(&ctx.storage));
        Ok(())
    }

    fn on_deactivate(&self) -> CoreResult<()> {
        *self.storage.write() = None;
        *self.pending_oauth.write() = None;
        Ok(())
    }

    fn as_any_arc(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    use lighterm_core::models::{
        AuthMethod, HostConfig, QuickShellLayoutPreset, SavedWorkspace,
    };
    use lighterm_core::LightermCore;
    use parking_lot::Mutex;
    use serde_json::{json, Value};
    use tempfile::tempdir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    #[derive(Clone)]
    enum MockDeviceAction {
        PendingThenSlowDownThenAuthorize {
            polls: usize,
            token: String,
            scope: String,
            refresh_token: Option<String>,
            expires_in: Option<i64>,
        },
        Deny,
        Expire,
    }

    #[derive(Default)]
    struct MockGitHubState {
        expected_client_id: String,
        username: String,
        valid_tokens: HashSet<String>,
        device_flows: HashMap<String, MockDeviceAction>,
        next_device_num: usize,
        gists: HashMap<String, MockGist>,
        next_gist_num: usize,
        repos: HashMap<String, MockRepo>,
        patch_count: usize,
        put_count: usize,
        refresh_count: usize,
        next_device_mode: Option<&'static str>, // None => default pending->slow_down->authorize, Some("deny") | Some("expire")
    }

    #[derive(Clone)]
    struct MockGist {
        id: String,
        description: String,
        public: bool,
        files: HashMap<String, String>,
        updated_at: String,
    }

    #[derive(Clone)]
    struct MockRepo {
        owner: String,
        name: String,
        private: bool,
        default_branch: String,
        files: HashMap<String, (String, String)>,
    }

    async fn spawn_mock_github(state: Arc<Mutex<MockGitHubState>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut temp = [0u8; 4096];
                    let header_end;
                    loop {
                        let n = match socket.read(&mut temp).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => n,
                        };
                        buf.extend_from_slice(&temp[..n]);
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            header_end = pos + 4;
                            break;
                        }
                    }

                    let header_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
                    let mut lines = header_str.lines();
                    let request_line = lines.next().unwrap_or("");
                    let mut parts = request_line.split_whitespace();
                    let method = parts.next().unwrap_or("GET");
                    let full_path = parts.next().unwrap_or("/");
                    let path = full_path.split('?').next().unwrap_or("/");

                    let mut content_len = 0usize;
                    let mut auth_header = String::new();
                    for line in lines {
                        if let Some((k, v)) = line.split_once(':') {
                            if k.eq_ignore_ascii_case("content-length") {
                                content_len = v.trim().parse().unwrap_or(0);
                            } else if k.eq_ignore_ascii_case("authorization") {
                                auth_header = v.trim().to_string();
                            }
                        }
                    }

                    while buf.len() < header_end + content_len {
                        let n = match socket.read(&mut temp).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => n,
                        };
                        buf.extend_from_slice(&temp[..n]);
                    }
                    let body_bytes = &buf[header_end..header_end + content_len];
                    let body_str = String::from_utf8_lossy(body_bytes);

                    let (status, resp_json) =
                        handle_mock_request(&state, method, path, &auth_header, &body_str);

                    let resp_body = resp_json.to_string();
                    let raw_resp = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        resp_body.len(),
                        resp_body
                    );
                    let _ = socket.write_all(raw_resp.as_bytes()).await;
                });
            }
        });

        format!("http://{addr}")
    }

    fn parse_form(body: &str) -> HashMap<String, String> {
        url::form_urlencoded::parse(body.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }

    fn handle_mock_request(
        state: &Arc<Mutex<MockGitHubState>>,
        method: &str,
        path: &str,
        auth_header: &str,
        body: &str,
    ) -> (u16, Value) {
        let mut st = state.lock();

        // Unauthenticated OAuth Device Flow endpoints
        if method == "POST" && path == "/login/device/code" {
            if !auth_header.is_empty() {
                return (400, json!({ "error": "unexpected_auth_header" }));
            }
            let form = parse_form(body);
            let client_id = form.get("client_id").cloned().unwrap_or_default();
            if client_id != st.expected_client_id {
                return (
                    400,
                    json!({ "error": "incorrect_client_credentials", "error_description": "Invalid client_id" }),
                );
            }
            let scope = form.get("scope").cloned().unwrap_or_else(|| "gist".to_string());
            st.next_device_num += 1;
            let device_code = format!("dev_code_{}", st.next_device_num);
            let user_code = format!("CODE-{:04}", st.next_device_num);
            let token = format!("gho_oauth_token_{}", st.next_device_num);

            let action = match st.next_device_mode {
                Some("deny") => MockDeviceAction::Deny,
                Some("expire") => MockDeviceAction::Expire,
                _ => MockDeviceAction::PendingThenSlowDownThenAuthorize {
                    polls: 0,
                    token,
                    scope,
                    refresh_token: Some(format!("ghr_refresh_{}", st.next_device_num)),
                    expires_in: Some(3600),
                },
            };
            st.device_flows.insert(device_code.clone(), action);

            return (
                200,
                json!({
                    "device_code": device_code,
                    "user_code": user_code,
                    "verification_uri": "https://github.com/login/device",
                    "expires_in": 900,
                    "interval": 1
                }),
            );
        }

        if method == "POST" && path == "/login/oauth/access_token" {
            let form = parse_form(body);
            let client_id = form.get("client_id").cloned().unwrap_or_default();
            if client_id != st.expected_client_id {
                return (
                    400,
                    json!({ "error": "incorrect_client_credentials", "error_description": "Invalid client_id" }),
                );
            }
            let grant_type = form.get("grant_type").cloned().unwrap_or_default();
            if grant_type == "refresh_token" {
                st.refresh_count += 1;
                let refreshed = format!("gho_refreshed_{}", st.refresh_count);
                st.valid_tokens.insert(refreshed.clone());
                return (
                    200,
                    json!({
                        "access_token": refreshed,
                        "token_type": "bearer",
                        "scope": "gist",
                        "refresh_token": format!("ghr_refresh_next_{}", st.refresh_count),
                        "expires_in": 3600
                    }),
                );
            }

            let device_code = form.get("device_code").cloned().unwrap_or_default();
            let Some(flow) = st.device_flows.get_mut(&device_code) else {
                return (200, json!({ "error": "expired_token" }));
            };

            match flow {
                MockDeviceAction::Deny => return (200, json!({ "error": "access_denied" })),
                MockDeviceAction::Expire => return (200, json!({ "error": "expired_token" })),
                MockDeviceAction::PendingThenSlowDownThenAuthorize {
                    polls,
                    token,
                    scope,
                    refresh_token,
                    expires_in,
                } => {
                    *polls += 1;
                    if *polls == 1 {
                        return (200, json!({ "error": "authorization_pending" }));
                    }
                    if *polls == 2 {
                        return (200, json!({ "error": "slow_down", "interval": 2 }));
                    }
                    let tok = token.clone();
                    let sc = scope.clone();
                    let rt = refresh_token.clone();
                    let exp = *expires_in;
                    st.valid_tokens.insert(tok.clone());
                    return (
                        200,
                        json!({
                            "access_token": tok,
                            "token_type": "bearer",
                            "scope": sc,
                            "refresh_token": rt,
                            "expires_in": exp
                        }),
                    );
                }
            }
        }

        // Authenticated REST API endpoints
        let bearer_token = auth_header.strip_prefix("Bearer ").unwrap_or("");
        if bearer_token.is_empty() || !st.valid_tokens.contains(bearer_token) {
            return (401, json!({ "message": "Bad credentials" }));
        }

        if method == "GET" && path == "/user" {
            return (
                200,
                json!({
                    "login": st.username,
                    "name": "Octo Cat",
                    "avatar_url": "https://avatars.githubusercontent.com/u/583231"
                }),
            );
        }

        if method == "GET" && path == "/gists" {
            let list: Vec<Value> = st
                .gists
                .values()
                .map(|g| {
                    let files_map: serde_json::Map<String, Value> = g
                        .files
                        .iter()
                        .map(|(k, v)| (k.clone(), json!({ "content": v, "truncated": false })))
                        .collect();
                    json!({
                        "id": g.id,
                        "description": g.description,
                        "public": g.public,
                        "html_url": format!("https://gist.github.com/{}", g.id),
                        "updated_at": g.updated_at,
                        "files": files_map,
                        "owner": { "login": st.username }
                    })
                })
                .collect();
            return (200, Value::Array(list));
        }

        if method == "POST" && path == "/gists" {
            let parsed: Value = serde_json::from_str(body).unwrap_or_default();
            st.next_gist_num += 1;
            let id = format!("gist_{}", st.next_gist_num);
            let mut files = HashMap::new();
            if let Some(obj) = parsed["files"].as_object() {
                for (fname, fval) in obj {
                    files.insert(
                        fname.clone(),
                        fval["content"].as_str().unwrap_or_default().to_string(),
                    );
                }
            }
            let g = MockGist {
                id: id.clone(),
                description: parsed["description"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                public: parsed["public"].as_bool().unwrap_or(false),
                files: files.clone(),
                updated_at: "2026-11-25T15:00:00Z".to_string(),
            };
            st.gists.insert(id.clone(), g);
            let files_map: serde_json::Map<String, Value> = files
                .into_iter()
                .map(|(k, v)| (k, json!({ "content": v, "truncated": false })))
                .collect();
            return (
                201,
                json!({
                    "id": id,
                    "description": "Lighterm Config Sync",
                    "public": false,
                    "html_url": format!("https://gist.github.com/{id}"),
                    "updated_at": "2026-11-25T15:00:00Z",
                    "files": files_map
                }),
            );
        }

        if let Some(gist_id) = path.strip_prefix("/gists/") {
            if method == "GET" {
                let Some(g) = st.gists.get(gist_id) else {
                    return (404, json!({ "message": "Not Found" }));
                };
                let files_map: serde_json::Map<String, Value> = g
                    .files
                    .iter()
                    .map(|(k, v)| (k.clone(), json!({ "content": v, "truncated": false })))
                    .collect();
                return (
                    200,
                    json!({
                        "id": g.id,
                        "description": g.description,
                        "public": g.public,
                        "html_url": format!("https://gist.github.com/{}", g.id),
                        "updated_at": g.updated_at,
                        "files": files_map,
                        "owner": { "login": st.username }
                    }),
                );
            }
            if method == "PATCH" {
                st.patch_count += 1;
                let parsed: Value = serde_json::from_str(body).unwrap_or_default();
                let Some(g) = st.gists.get_mut(gist_id) else {
                    return (404, json!({ "message": "Not Found" }));
                };
                if let Some(obj) = parsed["files"].as_object() {
                    for (fname, fval) in obj {
                        g.files.insert(
                            fname.clone(),
                            fval["content"].as_str().unwrap_or_default().to_string(),
                        );
                    }
                }
                let files_map: serde_json::Map<String, Value> = g
                    .files
                    .iter()
                    .map(|(k, v)| (k.clone(), json!({ "content": v, "truncated": false })))
                    .collect();
                return (
                    200,
                    json!({
                        "id": g.id,
                        "description": g.description,
                        "public": g.public,
                        "html_url": format!("https://gist.github.com/{}", g.id),
                        "updated_at": g.updated_at,
                        "files": files_map
                    }),
                );
            }
        }

        if method == "POST" && path == "/user/repos" {
            let parsed: Value = serde_json::from_str(body).unwrap_or_default();
            let name = parsed["name"].as_str().unwrap_or("lighterm-sync").to_string();
            let owner = st.username.clone();
            let key = format!("{owner}/{name}");
            let repo = MockRepo {
                owner: owner.clone(),
                name: name.clone(),
                private: parsed["private"].as_bool().unwrap_or(true),
                default_branch: "main".to_string(),
                files: HashMap::new(),
            };
            st.repos.insert(key, repo.clone());
            return (
                201,
                json!({
                    "name": repo.name,
                    "private": repo.private,
                    "default_branch": repo.default_branch,
                    "html_url": format!("https://github.com/{owner}/{name}"),
                    "owner": { "login": owner }
                }),
            );
        }

        if let Some(rest) = path.strip_prefix("/repos/") {
            let segs: Vec<&str> = rest.split('/').collect();
            if segs.len() == 2 && method == "GET" {
                let key = format!("{}/{}", segs[0], segs[1]);
                let Some(repo) = st.repos.get(&key) else {
                    return (404, json!({ "message": "Not Found" }));
                };
                return (
                    200,
                    json!({
                        "name": repo.name,
                        "private": repo.private,
                        "default_branch": repo.default_branch,
                        "html_url": format!("https://github.com/{}/{}", repo.owner, repo.name),
                        "owner": { "login": repo.owner }
                    }),
                );
            }
            if segs.len() >= 4 && segs[2] == "contents" {
                let key = format!("{}/{}", segs[0], segs[1]);
                let file_path = segs[3..].join("/");
                if method == "GET" {
                    let Some(repo) = st.repos.get(&key) else {
                        return (404, json!({ "message": "Not Found" }));
                    };
                    let Some((sha, content)) = repo.files.get(&file_path) else {
                        return (404, json!({ "message": "Not Found" }));
                    };
                    let b64 = BASE64.encode(content.as_bytes());
                    let wrapped = b64
                        .as_bytes()
                        .chunks(40)
                        .map(|c| std::str::from_utf8(c).unwrap())
                        .collect::<Vec<_>>()
                        .join("\n");
                    return (
                        200,
                        json!({
                            "sha": sha,
                            "content": wrapped,
                            "encoding": "base64",
                            "html_url": format!("https://github.com/{}/blob/main/{}", key, file_path)
                        }),
                    );
                }
                if method == "PUT" {
                    st.put_count += 1;
                    let next_sha = format!("sha_{}", st.put_count);
                    let parsed: Value = serde_json::from_str(body).unwrap_or_default();
                    let Some(repo) = st.repos.get_mut(&key) else {
                        return (404, json!({ "message": "Not Found" }));
                    };
                    let expected_sha = parsed["sha"].as_str();
                    if let Some((cur_sha, _)) = repo.files.get(&file_path) {
                        if expected_sha != Some(cur_sha.as_str()) {
                            return (409, json!({ "message": "SHA mismatch" }));
                        }
                    }
                    let b64 = parsed["content"].as_str().unwrap_or_default();
                    let bytes = BASE64.decode(b64).unwrap_or_default();
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    repo.files.insert(file_path.clone(), (next_sha, text));
                    return (
                        200,
                        json!({
                            "content": {
                                "html_url": format!("https://github.com/{}/blob/main/{}", key, file_path)
                            }
                        }),
                    );
                }
            }
        }

        (404, json!({ "message": "Unhandled mock route" }))
    }

    async fn complete_oauth_login(plugin: &SyncPlugin) -> OAuthPollResult {
        let start = plugin.start_oauth_device_flow(None, false).await.unwrap();
        assert!(!start.browser_opened);
        assert!(!start.user_code.is_empty());

        let r1 = plugin.poll_oauth_device_flow(&start.flow_id).await.unwrap();
        assert_eq!(r1.status, "pending");

        let r2 = plugin.poll_oauth_device_flow(&start.flow_id).await.unwrap();
        assert_eq!(r2.status, "slow_down");
        assert_eq!(r2.interval, Some(2));

        let r3 = plugin.poll_oauth_device_flow(&start.flow_id).await.unwrap();
        assert_eq!(r3.status, "authorized");
        r3
    }

    fn make_host(id: &str, name: &str, password: Option<&str>, updated_at: i64) -> HostConfig {
        HostConfig {
            id: id.to_string(),
            name: name.to_string(),
            group: "Production".to_string(),
            host: "10.0.0.10".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth: AuthMethod::Password {
                password: password.map(|s| s.to_string()),
            },
            default_path: Some("/srv/app".to_string()),
            startup_command: None,
            color: Some("#7aa2f7".to_string()),
            updated_at,
        }
    }

    #[test]
    fn crypto_roundtrip_wrong_passphrase_and_tampering() {
        let payload = SyncPayload {
            hosts: Some(vec![make_host("h1", "Prod", Some("topsecret"), 1000)]),
            hosts_include_secrets: true,
            ..Default::default()
        };

        let enc = encrypt_payload(&payload, "correct-horse-battery").unwrap();
        let dec = decrypt_payload(&enc, "correct-horse-battery").unwrap();
        assert_eq!(dec.hosts.as_ref().unwrap().len(), 1);

        assert!(decrypt_payload(&enc, "wrong-passphrase").is_err());
        assert!(decrypt_payload(&enc, "").is_err());

        let mut tampered = enc.clone();
        let mut raw = BASE64.decode(&tampered.ciphertext).unwrap();
        raw[0] ^= 0xff;
        tampered.ciphertext = BASE64.encode(raw);
        assert!(decrypt_payload(&tampered, "correct-horse-battery").is_err());
    }

    #[tokio::test]
    async fn disabled_plugin_rejects_operations() {
        let dir = tempdir().unwrap();
        let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();
        let plugin = Arc::new(SyncPlugin::new());
        core.register_plugin(plugin.clone()).unwrap();

        let ctx = core.context();
        core.plugins
            .set_enabled(SYNC_PLUGIN_ID, false, &ctx)
            .unwrap();

        assert!(matches!(
            plugin.get_config_view(),
            Err(CoreError::PluginDisabled(_))
        ));
        assert!(matches!(
            plugin.sync_now().await,
            Err(CoreError::PluginDisabled(_))
        ));
        assert!(matches!(
            plugin.start_oauth_device_flow(None, false).await,
            Err(CoreError::PluginDisabled(_))
        ));
    }

    #[tokio::test]
    async fn oauth_device_flow_edges_refresh_and_logout() {
        let mock_state = Arc::new(Mutex::new(MockGitHubState {
            expected_client_id: "Ov23liLightermTestId".to_string(),
            username: "oauth-user".to_string(),
            ..Default::default()
        }));
        let base_url = spawn_mock_github(Arc::clone(&mock_state)).await;

        let dir = tempdir().unwrap();
        let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();
        let sync = Arc::new(SyncPlugin::new());
        core.register_plugin(sync.clone()).unwrap();

        // Built-in default client_id is active out of the box
        let default_view = sync.get_config_view().unwrap();
        assert!(default_view.oauth_client_configured);
        if std::env::var("LIGHTERM_GITHUB_CLIENT_ID")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .is_none()
            && BUILTIN_CLIENT_ID.filter(|v| !v.trim().is_empty()).is_none()
        {
            assert_eq!(
                resolve_oauth_client_id(&GitHubSyncConfig::default()),
                (Some(DEFAULT_GITHUB_CLIENT_ID.to_string()), "builtin")
            );
            assert_eq!(default_view.oauth_client_id_source, "builtin");
        }

        // Mock server rejects non-matching client_id cleanly without hitting real github.com
        let mut cfg = GitHubSyncConfig::default();
        cfg.api_base_url = base_url.clone();
        cfg.oauth_base_url = base_url.clone();
        sync.save_config(SyncConfigUpdateInput {
            config: cfg.clone(),
            encryption_passphrase: None,
        })
        .unwrap();
        assert!(sync.start_oauth_device_flow(None, false).await.is_err());

        cfg.oauth_client_id = "Ov23liLightermTestId".to_string();
        sync.save_config(SyncConfigUpdateInput {
            config: cfg.clone(),
            encryption_passphrase: None,
        })
        .unwrap();

        // Denied authorization returns status="denied"
        mock_state.lock().next_device_mode = Some("deny");
        let denied_start = sync.start_oauth_device_flow(None, false).await.unwrap();
        let denied_poll = sync
            .poll_oauth_device_flow(&denied_start.flow_id)
            .await
            .unwrap();
        assert_eq!(denied_poll.status, "denied");
        assert!(!sync.get_config_view().unwrap().is_authenticated);

        // Expired authorization returns status="expired"
        mock_state.lock().next_device_mode = Some("expire");
        let exp_start = sync.start_oauth_device_flow(None, false).await.unwrap();
        let exp_poll = sync
            .poll_oauth_device_flow(&exp_start.flow_id)
            .await
            .unwrap();
        assert_eq!(exp_poll.status, "expired");

        // Normal Device Flow completes & persists OAuth credentials
        mock_state.lock().next_device_mode = None;
        let auth_res = complete_oauth_login(&sync).await;
        let view = auth_res.view.unwrap();
        assert!(view.is_authenticated);
        assert_eq!(view.account.unwrap().login, "oauth-user");
        assert_eq!(view.oauth_scopes, vec!["gist".to_string()]);
        assert_eq!(view.oauth_client_id_source, "custom");

        // Simulate expired access_token -> refresh_token automatically refreshes
        {
            let storage = sync.require_storage().unwrap();
            let mut creds = SyncPlugin::load_credentials(&storage).unwrap();
            creds.token_expires_at = Some(Utc::now().timestamp() - 120);
            SyncPlugin::save_credentials(&storage, &creds).unwrap();
        }
        let test_res = sync.test_connection(None).await.unwrap();
        assert!(test_res.success);
        assert_eq!(mock_state.lock().refresh_count, 1);

        // Logout clears OAuth credentials
        let logged_out = sync.logout_oauth().await_less_view(&sync);
        assert!(!logged_out.is_authenticated);
        assert!(logged_out.account.is_none());
        assert!(matches!(
            sync.test_connection(None).await,
            Err(CoreError::AuthFailed(_))
        ));
    }

    trait SyncLogoutTestExt {
        fn await_less_view(self, sync: &SyncPlugin) -> SyncConfigView;
    }

    impl SyncLogoutTestExt for CoreResult<SyncConfigView> {
        fn await_less_view(self, _sync: &SyncPlugin) -> SyncConfigView {
            self.unwrap()
        }
    }

    #[tokio::test]
    async fn cross_device_oauth_gist_sync_security_merge_and_tombstones() {
        let mock_state = Arc::new(Mutex::new(MockGitHubState {
            expected_client_id: "Ov23liLightermTestId".to_string(),
            username: "octocat".to_string(),
            ..Default::default()
        }));
        let base_url = spawn_mock_github(Arc::clone(&mock_state)).await;

        // Device A setup & OAuth login
        let dir_a = tempdir().unwrap();
        let core_a = LightermCore::with_data_dir(dir_a.path().to_path_buf()).unwrap();
        let sync_a = Arc::new(SyncPlugin::new());
        core_a.register_plugin(sync_a.clone()).unwrap();

        let mut bad_cfg = GitHubSyncConfig::default();
        bad_cfg.api_base_url = base_url.clone();
        bad_cfg.oauth_base_url = base_url.clone();
        bad_cfg.oauth_client_id = "Ov23liLightermTestId".to_string();
        bad_cfg.scopes.include_host_secrets = true;
        assert!(sync_a
            .save_config(SyncConfigUpdateInput {
                config: bad_cfg,
                encryption_passphrase: None,
            })
            .is_err());

        let mut cfg_a = GitHubSyncConfig::default();
        cfg_a.api_base_url = base_url.clone();
        cfg_a.oauth_base_url = base_url.clone();
        cfg_a.oauth_client_id = "Ov23liLightermTestId".to_string();
        cfg_a.device_name = "Workstation-A".to_string();
        cfg_a.scopes.include_host_secrets = false;
        sync_a
            .save_config(SyncConfigUpdateInput {
                config: cfg_a,
                encryption_passphrase: None,
            })
            .unwrap();

        let auth_a = complete_oauth_login(&sync_a).await;
        assert!(auth_a.view.unwrap().is_authenticated);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::metadata(dir_a.path().join(CREDENTIALS_FILE)).unwrap();
            assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        }

        let host_a = core_a
            .storage
            .save_host(make_host("host-1", "Prod Web", Some("local-only-pw"), 100))
            .unwrap();
        let mut settings_a = core_a.storage.get_settings().unwrap();
        settings_a.theme_id = "dracula".to_string();
        core_a.storage.save_settings(settings_a).unwrap();
        core_a
            .storage
            .save_workspace(SavedWorkspace {
                id: "ws-1".to_string(),
                name: "Prod".to_string(),
                slots: vec![],
                dock_root: None,
                floating: vec![],
                active_slot_id: None,
                maximized_slot_id: None,
                layout_preset: Some(QuickShellLayoutPreset::Vsp),
                created_at: 100,
                updated_at: 100,
            })
            .unwrap();
        core_a
            .storage
            .write_plugin_json(
                SNIPPETS_FILE,
                &vec![SyncedSnippet {
                    id: "snip-1".to_string(),
                    title: "Uptime".to_string(),
                    command: "uptime".to_string(),
                    category: "System".to_string(),
                    description: None,
                    auto_execute: true,
                    updated_at: 100,
                    extra: HashMap::new(),
                }],
                false,
            )
            .unwrap();

        let push_res = sync_a.sync_now().await.unwrap();
        assert!(push_res.pushed_remote);
        assert_eq!(push_res.gist_id.as_deref(), Some("gist_1"));

        {
            let st = mock_state.lock();
            let raw_gist = &st.gists["gist_1"].files["lighterm-sync.json"];
            assert!(!raw_gist.contains("local-only-pw"));
        }

        // Device B setup & OAuth login (auto-discovers gist_1)
        let dir_b = tempdir().unwrap();
        let core_b = LightermCore::with_data_dir(dir_b.path().to_path_buf()).unwrap();
        let sync_b = Arc::new(SyncPlugin::new());
        core_b.register_plugin(sync_b.clone()).unwrap();

        let mut cfg_b = GitHubSyncConfig::default();
        cfg_b.api_base_url = base_url.clone();
        cfg_b.oauth_base_url = base_url.clone();
        cfg_b.oauth_client_id = "Ov23liLightermTestId".to_string();
        cfg_b.device_name = "Laptop-B".to_string();
        sync_b
            .save_config(SyncConfigUpdateInput {
                config: cfg_b,
                encryption_passphrase: None,
            })
            .unwrap();

        let auth_b = complete_oauth_login(&sync_b).await;
        assert_eq!(auth_b.discovered_gists.len(), 1);
        assert_eq!(auth_b.view.unwrap().config.gist_id, "gist_1");

        let sync_b_res = sync_b.sync_now().await.unwrap();
        assert!(sync_b_res.applied_local);
        assert!(!sync_b_res.pushed_remote);
        assert_eq!(sync_b_res.counts.hosts, 1);
        assert_eq!(core_b.storage.list_hosts().unwrap()[0].name, "Prod Web");
        assert_eq!(core_b.storage.get_settings().unwrap().theme_id, "dracula");
        assert_eq!(core_b.storage.list_workspaces().unwrap().len(), 1);
        let b_snips: Vec<SyncedSnippet> = core_b.storage.read_plugin_json(SNIPPETS_FILE).unwrap();
        assert_eq!(b_snips.len(), 1);

        // Device B adds a second host; Device A deletes host-1 -> deletion propagates to B
        core_b
            .storage
            .save_host(make_host("host-2", "Staging DB", None, 500))
            .unwrap();
        sync_b.sync_now().await.unwrap();

        core_a.storage.delete_host(&host_a.id).unwrap();
        let res_a2 = sync_a.sync_now().await.unwrap();
        assert!(res_a2.applied_local);
        assert!(res_a2.pushed_remote);
        assert_eq!(core_a.storage.list_hosts().unwrap().len(), 1);

        let res_b2 = sync_b.sync_now().await.unwrap();
        assert!(res_b2.applied_local);
        let b_hosts = core_b.storage.list_hosts().unwrap();
        assert_eq!(b_hosts.len(), 1);
        assert_eq!(b_hosts[0].id, "host-2");

        let patches_before = mock_state.lock().patch_count;
        let noop_res = sync_b.sync_now().await.unwrap();
        assert!(!noop_res.pushed_remote);
        assert!(!noop_res.applied_local);
        assert_eq!(mock_state.lock().patch_count, patches_before);

        // Self-healing: if cached gist_1 is deleted on GitHub, sync_now() creates a fresh managed secret gist
        mock_state.lock().gists.remove("gist_1");
        let healed_res = sync_b.sync_now().await.unwrap();
        assert!(healed_res.pushed_remote);
        assert_eq!(healed_res.gist_id.as_deref(), Some("gist_2"));
        assert_eq!(sync_b.get_config_view().unwrap().config.gist_id, "gist_2");
        assert!(mock_state.lock().gists["gist_2"]
            .description
            .contains("[lighterm-managed-sync-v1]"));
    }

    #[tokio::test]
    async fn encrypted_oauth_repo_sync_and_error_cases() {
        let mock_state = Arc::new(Mutex::new(MockGitHubState {
            expected_client_id: "Ov23liLightermTestId".to_string(),
            username: "alice".to_string(),
            ..Default::default()
        }));
        let base_url = spawn_mock_github(Arc::clone(&mock_state)).await;

        let dir_a = tempdir().unwrap();
        let core_a = LightermCore::with_data_dir(dir_a.path().to_path_buf()).unwrap();
        let sync_a = Arc::new(SyncPlugin::new());
        core_a.register_plugin(sync_a.clone()).unwrap();

        let mut cfg_a = GitHubSyncConfig::default();
        cfg_a.mode = SyncTargetMode::Repo;
        cfg_a.api_base_url = base_url.clone();
        cfg_a.oauth_base_url = base_url.clone();
        cfg_a.oauth_client_id = "Ov23liLightermTestId".to_string();
        cfg_a.repo_name = "my-lighterm-cfg".to_string();
        cfg_a.auto_create_target = true;
        cfg_a.scopes.include_host_secrets = true;
        sync_a
            .save_config(SyncConfigUpdateInput {
                config: cfg_a,
                encryption_passphrase: Some("vault-pass-42".to_string()),
            })
            .unwrap();

        let auth_a = complete_oauth_login(&sync_a).await;
        assert_eq!(
            auth_a.view.unwrap().oauth_scopes,
            vec!["gist".to_string(), "repo".to_string()]
        );

        core_a
            .storage
            .save_host(make_host("h-sec", "Secret Server", Some("ssh-pass-xyz"), 100))
            .unwrap();

        let push_res = sync_a.push().await.unwrap();
        assert!(push_res.pushed_remote);
        assert!(push_res.encrypted);
        assert_eq!(push_res.repo_owner.as_deref(), Some("alice"));

        {
            let st = mock_state.lock();
            let repo = &st.repos["alice/my-lighterm-cfg"];
            assert!(repo.private);
            let (_, content) = &repo.files["lighterm-sync.json"];
            assert!(!content.contains("Secret Server"));
            assert!(!content.contains("ssh-pass-xyz"));
        }

        let dir_b = tempdir().unwrap();
        let core_b = LightermCore::with_data_dir(dir_b.path().to_path_buf()).unwrap();
        let sync_b = Arc::new(SyncPlugin::new());
        core_b.register_plugin(sync_b.clone()).unwrap();

        let mut cfg_b = GitHubSyncConfig::default();
        cfg_b.mode = SyncTargetMode::Repo;
        cfg_b.api_base_url = base_url.clone();
        cfg_b.oauth_base_url = base_url.clone();
        cfg_b.oauth_client_id = "Ov23liLightermTestId".to_string();
        cfg_b.repo_owner = "alice".to_string();
        cfg_b.repo_name = "my-lighterm-cfg".to_string();
        sync_b
            .save_config(SyncConfigUpdateInput {
                config: cfg_b.clone(),
                encryption_passphrase: None,
            })
            .unwrap();

        complete_oauth_login(&sync_b).await;

        assert!(matches!(
            sync_b.pull().await,
            Err(CoreError::AuthFailed(_))
        ));

        sync_b
            .save_config(SyncConfigUpdateInput {
                config: cfg_b,
                encryption_passphrase: Some("vault-pass-42".to_string()),
            })
            .unwrap();
        let pull_res = sync_b.pull().await.unwrap();
        assert!(pull_res.applied_local);
        assert!(pull_res.encrypted);
        let restored = core_b.storage.list_hosts().unwrap();
        assert_eq!(restored.len(), 1);
        match &restored[0].auth {
            AuthMethod::Password { password } => {
                assert_eq!(password.as_deref(), Some("ssh-pass-xyz"));
            }
            _ => panic!("expected password auth"),
        }
    }
}
