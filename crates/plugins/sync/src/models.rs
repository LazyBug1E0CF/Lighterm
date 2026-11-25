use std::collections::HashMap;

use lighterm_core::models::{AppSettings, HostConfig, SavedWorkspace};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncTargetMode {
    Gist,
    Repo,
}

impl Default for SyncTargetMode {
    fn default() -> Self {
        Self::Gist
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictResolution {
    Newest,
    Local,
    Remote,
}

impl Default for ConflictResolution {
    fn default() -> Self {
        Self::Newest
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScopes {
    #[serde(default = "default_true")]
    pub hosts: bool,
    #[serde(default = "default_true")]
    pub settings: bool,
    #[serde(default = "default_true")]
    pub workspaces: bool,
    #[serde(default = "default_true")]
    pub snippets: bool,
    #[serde(default = "default_true")]
    pub plugins: bool,
    #[serde(default)]
    pub include_host_secrets: bool,
}

impl Default for SyncScopes {
    fn default() -> Self {
        Self {
            hosts: true,
            settings: true,
            workspaces: true,
            snippets: true,
            plugins: true,
            include_host_secrets: false,
        }
    }
}

fn default_api_base_url() -> String {
    "https://api.github.com".to_string()
}

fn default_oauth_base_url() -> String {
    "https://github.com".to_string()
}

fn default_gist_file_name() -> String {
    "lighterm-sync.json".to_string()
}

fn default_repo_name() -> String {
    "lighterm-sync".to_string()
}

fn default_repo_branch() -> String {
    "main".to_string()
}

fn default_repo_file_path() -> String {
    "lighterm-sync.json".to_string()
}

pub fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Lighterm Device".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubSyncConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub mode: SyncTargetMode,
    #[serde(default = "default_api_base_url")]
    pub api_base_url: String,
    #[serde(default = "default_oauth_base_url")]
    pub oauth_base_url: String,
    #[serde(default)]
    pub oauth_client_id: String,
    #[serde(default)]
    pub gist_id: String,
    #[serde(default = "default_gist_file_name")]
    pub gist_file_name: String,
    #[serde(default)]
    pub repo_owner: String,
    #[serde(default = "default_repo_name")]
    pub repo_name: String,
    #[serde(default = "default_repo_branch")]
    pub repo_branch: String,
    #[serde(default = "default_repo_file_path")]
    pub repo_file_path: String,
    #[serde(default = "default_true")]
    pub auto_create_target: bool,
    #[serde(default)]
    pub auto_sync_on_startup: bool,
    #[serde(default)]
    pub auto_sync_on_change: bool,
    #[serde(default = "default_device_name")]
    pub device_name: String,
    #[serde(default)]
    pub conflict_resolution: ConflictResolution,
    #[serde(default)]
    pub scopes: SyncScopes,
}

impl Default for GitHubSyncConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: SyncTargetMode::Gist,
            api_base_url: default_api_base_url(),
            oauth_base_url: default_oauth_base_url(),
            oauth_client_id: String::new(),
            gist_id: String::new(),
            gist_file_name: default_gist_file_name(),
            repo_owner: String::new(),
            repo_name: default_repo_name(),
            repo_branch: default_repo_branch(),
            repo_file_path: default_repo_file_path(),
            auto_create_target: true,
            auto_sync_on_startup: false,
            auto_sync_on_change: false,
            device_name: default_device_name(),
            conflict_resolution: ConflictResolution::Newest,
            scopes: SyncScopes::default(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCredentials {
    #[serde(default, alias = "token")]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub token_expires_at: Option<i64>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub account_login: Option<String>,
    #[serde(default)]
    pub account_name: Option<String>,
    #[serde(default)]
    pub account_avatar_url: Option<String>,
    #[serde(default)]
    pub encryption_passphrase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigUpdateInput {
    pub config: GitHubSyncConfig,
    /// `None` preserves existing passphrase; `Some("")` clears it; `Some(nonempty)` replaces it.
    pub encryption_passphrase: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusState {
    pub last_sync_at: Option<i64>,
    pub last_action: Option<String>,
    pub last_status: Option<String>,
    pub last_message: Option<String>,
    pub last_error: Option<String>,
    pub last_remote_updated_at: Option<i64>,
    pub last_remote_device: Option<String>,
    pub remote_account: Option<String>,
    pub remote_url: Option<String>,
    pub remote_encrypted: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAccountInfo {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigView {
    pub config: GitHubSyncConfig,
    pub is_authenticated: bool,
    pub account: Option<SyncAccountInfo>,
    pub oauth_scopes: Vec<String>,
    pub oauth_client_configured: bool,
    pub oauth_client_id_source: String,
    pub has_passphrase: bool,
    pub status: SyncStatusState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthDeviceFlowStart {
    pub flow_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
    pub scopes: Vec<String>,
    pub browser_opened: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthPollResult {
    pub status: String,
    pub interval: Option<u64>,
    pub message: Option<String>,
    pub view: Option<SyncConfigView>,
    pub discovered_gists: Vec<DiscoveredGist>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTombstones {
    #[serde(default)]
    pub hosts: HashMap<String, i64>,
    #[serde(default)]
    pub workspaces: HashMap<String, i64>,
    #[serde(default)]
    pub snippets: HashMap<String, i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncLocalState {
    #[serde(default)]
    pub status: SyncStatusState,
    #[serde(default)]
    pub last_synced_host_ids: Vec<String>,
    #[serde(default)]
    pub last_synced_workspace_ids: Vec<String>,
    #[serde(default)]
    pub last_synced_snippet_ids: Vec<String>,
    #[serde(default)]
    pub last_settings_hash: Option<String>,
    #[serde(default)]
    pub last_plugins_hash: Option<String>,
    #[serde(default)]
    pub local_tombstones: SyncTombstones,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncedSnippet {
    pub id: String,
    pub title: String,
    pub command: String,
    pub category: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub auto_execute: bool,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hosts: Option<Vec<HostConfig>>,
    #[serde(default)]
    pub hosts_include_secrets: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<AppSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspaces: Option<Vec<SavedWorkspace>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippets: Option<Vec<SyncedSnippet>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_states: Option<HashMap<String, bool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_configs: Option<HashMap<String, serde_json::Value>>,
    #[serde(default)]
    pub tombstones: SyncTombstones,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedPayload {
    pub kdf: String,
    pub iterations: u32,
    pub cipher: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEnvelope {
    pub format: String,
    pub version: u32,
    pub encrypted: bool,
    pub updated_at: i64,
    pub device_name: String,
    pub app_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<SyncPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption: Option<EncryptedPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredGist {
    pub id: String,
    pub description: String,
    pub file_name: String,
    pub public: bool,
    pub updated_at: String,
    pub html_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTestResult {
    pub success: bool,
    pub username: Option<String>,
    pub target_exists: bool,
    pub target_url: Option<String>,
    pub is_public_target: bool,
    pub discovered_gists: Vec<DiscoveredGist>,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCounts {
    pub hosts: usize,
    pub workspaces: usize,
    pub snippets: usize,
    pub settings_updated: bool,
    pub plugins_updated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOperationResult {
    pub action: String,
    pub applied_local: bool,
    pub pushed_remote: bool,
    pub encrypted: bool,
    pub remote_url: Option<String>,
    pub gist_id: Option<String>,
    pub repo_owner: Option<String>,
    pub remote_updated_at: Option<i64>,
    pub summary: String,
    pub counts: SyncCounts,
    pub status: SyncStatusState,
    pub invalidated_host_ids: Vec<String>,
    pub updated_plugin_states: HashMap<String, bool>,
}
