use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use chrono::Utc;
use parking_lot::Mutex;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use reqwest::Client;
use ring::digest::{Context as DigestContext, SHA256};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use url::Url;

use crate::error::{CoreError, CoreResult};
use crate::events::CoreEventSink;
use crate::storage::Storage;

pub const DEFAULT_UPDATE_REPO: &str = "LazyBug1E0CF/Lighterm";
pub const DEFAULT_GITHUB_API_BASE: &str = "https://api.github.com";
pub const SELF_UPDATE_RESTART_EXIT_CODE: i32 = 42;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateTarget {
    Desktop,
    WebBundle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedWebUpdate {
    pub version: String,
    pub release_dir: String,
    pub binary_path: String,
    pub static_dir: String,
}

static RUSTLS_INIT: Once = Once::new();

fn ensure_rustls_provider() {
    RUSTLS_INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetInfo {
    pub name: String,
    pub download_url: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNoteEntry {
    pub tag_name: String,
    pub version: String,
    pub name: String,
    pub body: String,
    pub html_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    pub is_latest: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub latest_tag: String,
    pub release_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    pub has_update: bool,
    pub is_skipped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped_version: Option<String>,
    pub auto_check: bool,
    pub checked_at: i64,
    pub releases: Vec<ReleaseNoteEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<UpdateAssetInfo>,
    pub can_auto_download: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadProgress {
    pub download_id: String,
    pub version: String,
    pub asset_name: String,
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bytes_per_sec: u64,
    pub progress_percent: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    pub sha256_verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedUpdate {
    pub download_id: String,
    pub version: String,
    pub asset_name: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub sha256_verified: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GitHubReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubReleaseAsset>,
}

/// Parses a release tag or version string (e.g. `v0.3.1` or `0.3`) into a stable SemVer.
/// Prereleases are rejected so auto-update checks only target stable releases.
pub fn parse_semver_tag(raw: &str) -> Option<semver::Version> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let stripped = trimmed.strip_prefix('v').or_else(|| trimmed.strip_prefix('V')).unwrap_or(trimmed);
    let normalized = if stripped.split('.').count() == 2 && !stripped.contains('-') && !stripped.contains('+') {
        format!("{stripped}.0")
    } else {
        stripped.to_string()
    };
    let parsed = semver::Version::parse(&normalized).ok()?;
    if !parsed.pre.is_empty() {
        return None;
    }
    Some(parsed)
}

fn is_auxiliary_asset(name_lower: &str) -> bool {
    name_lower.ends_with(".sha256")
        || name_lower.ends_with(".sha256sum")
        || name_lower.ends_with(".sig")
        || name_lower.ends_with(".asc")
        || name_lower.ends_with(".blockmap")
}

fn matches_arch_token(name_lower: &str, arch: &str) -> bool {
    match arch {
        "x86_64" | "amd64" => {
            name_lower.contains("x64")
                || name_lower.contains("x86_64")
                || name_lower.contains("amd64")
                || name_lower.contains("win64")
        }
        "aarch64" | "arm64" => name_lower.contains("arm64") || name_lower.contains("aarch64"),
        "x86" | "i686" => {
            (name_lower.contains("x86") && !name_lower.contains("x86_64"))
                || name_lower.contains("i686")
                || name_lower.contains("win32")
        }
        _ => false,
    }
}

fn has_opposing_arch_token(name_lower: &str, arch: &str) -> bool {
    match arch {
        "x86_64" | "amd64" => matches_arch_token(name_lower, "aarch64"),
        "aarch64" | "arm64" => matches_arch_token(name_lower, "x86_64"),
        _ => false,
    }
}

fn find_sha256_url(assets: &[GitHubReleaseAsset], target_name: &str) -> Option<String> {
    let expected = format!("{}.sha256", target_name.to_ascii_lowercase());
    assets
        .iter()
        .find(|a| a.name.to_ascii_lowercase() == expected)
        .map(|a| a.browser_download_url.clone())
}

/// Selects the most appropriate release installer asset for the given OS and CPU architecture.
pub fn select_platform_asset(
    assets: &[GitHubReleaseAsset],
    os: &str,
    arch: &str,
) -> Option<UpdateAssetInfo> {
    let candidates: Vec<&GitHubReleaseAsset> = assets
        .iter()
        .filter(|a| !is_auxiliary_asset(&a.name.to_ascii_lowercase()))
        .collect();

    let pick_by = |predicate: &dyn Fn(&str) -> bool| -> Option<&GitHubReleaseAsset> {
        candidates
            .iter()
            .copied()
            .find(|a| predicate(&a.name.to_ascii_lowercase()))
    };

    let chosen = match os {
        "windows" => pick_by(&|n| {
            n.contains("lighterm-setup") && n.ends_with(".exe") && matches_arch_token(n, arch)
        })
        .or_else(|| pick_by(&|n| n.ends_with(".exe") && matches_arch_token(n, arch)))
        .or_else(|| pick_by(&|n| n.ends_with(".msi") && matches_arch_token(n, arch)))
        .or_else(|| {
            pick_by(&|n| {
                n.contains("lighterm-setup")
                    && n.ends_with(".exe")
                    && !has_opposing_arch_token(n, arch)
            })
        })
        .or_else(|| {
            pick_by(&|n| {
                (n.ends_with(".exe") || n.ends_with(".msi")) && !has_opposing_arch_token(n, arch)
            })
        }),
        "macos" => pick_by(&|n| n.ends_with(".dmg") && matches_arch_token(n, arch))
            .or_else(|| pick_by(&|n| n.ends_with(".pkg") && matches_arch_token(n, arch)))
            .or_else(|| {
                pick_by(&|n| {
                    (n.ends_with(".app.tar.gz") || n.ends_with(".tar.gz") || n.ends_with(".zip"))
                        && matches_arch_token(n, arch)
                })
            })
            .or_else(|| {
                pick_by(&|n| n.ends_with(".dmg") && (n.contains("universal") || !has_opposing_arch_token(n, arch)))
            })
            .or_else(|| pick_by(&|n| n.ends_with(".pkg") && !has_opposing_arch_token(n, arch))),
        "linux" => pick_by(&|n| {
            !n.contains("lighterm-web")
                && n.ends_with(".appimage")
                && matches_arch_token(n, arch)
        })
        .or_else(|| {
            pick_by(&|n| {
                !n.contains("lighterm-web") && n.ends_with(".deb") && matches_arch_token(n, arch)
            })
        })
        .or_else(|| {
            pick_by(&|n| {
                !n.contains("lighterm-web") && n.ends_with(".rpm") && matches_arch_token(n, arch)
            })
        })
        .or_else(|| {
            pick_by(&|n| {
                !n.contains("lighterm-web")
                    && n.ends_with(".tar.gz")
                    && matches_arch_token(n, arch)
            })
        })
        .or_else(|| {
            pick_by(&|n| {
                !n.contains("lighterm-web")
                    && (n.ends_with(".appimage") || n.ends_with(".deb"))
                    && !has_opposing_arch_token(n, arch)
            })
        }),
        _ => None,
    }?;

    Some(UpdateAssetInfo {
        name: chosen.name.clone(),
        download_url: chosen.browser_download_url.clone(),
        size: chosen.size,
        content_type: chosen.content_type.clone(),
        sha256_url: find_sha256_url(assets, &chosen.name),
    })
}

/// Selects the self-update web bundle tarball (e.g. `lighterm-web-<ver>-linux-amd64.tar.gz`)
/// for the given OS and CPU architecture.
pub fn select_web_bundle_asset(
    assets: &[GitHubReleaseAsset],
    os: &str,
    arch: &str,
) -> Option<UpdateAssetInfo> {
    let os_token = format!("-{}-", os.to_ascii_lowercase());
    let chosen = assets
        .iter()
        .filter(|a| !is_auxiliary_asset(&a.name.to_ascii_lowercase()))
        .find(|a| {
            let lower = a.name.to_ascii_lowercase();
            lower.contains("lighterm-web")
                && lower.contains(&os_token)
                && matches_arch_token(&lower, arch)
                && lower.ends_with(".tar.gz")
        })?;

    Some(UpdateAssetInfo {
        name: chosen.name.clone(),
        download_url: chosen.browser_download_url.clone(),
        size: chosen.size,
        content_type: chosen.content_type.clone(),
        sha256_url: find_sha256_url(assets, &chosen.name),
    })
}

fn is_hex_sha256(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Extracts a 64-character SHA-256 hex digest from `.sha256` file contents.
/// Supports `<hex>  <filename>`, `<hex> *<filename>`, or a bare `<hex>` string.
pub fn parse_sha256_checksum(text: &str, expected_filename: &str) -> Option<String> {
    let expected_lower = Path::new(expected_filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(expected_filename)
        .to_ascii_lowercase();

    let mut single_bare_hash: Option<String> = None;
    let non_empty_lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();

    for line in &non_empty_lines {
        let mut parts = line.splitn(2, char::is_whitespace);
        let hash_candidate = parts.next()?.trim();
        if !is_hex_sha256(hash_candidate) {
            continue;
        }
        if let Some(rest) = parts.next() {
            let file_token = rest.trim().trim_start_matches('*');
            let file_base = Path::new(file_token)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(file_token)
                .to_ascii_lowercase();
            if file_base == expected_lower {
                return Some(hash_candidate.to_ascii_lowercase());
            }
        } else if non_empty_lines.len() == 1 {
            single_bare_hash = Some(hash_candidate.to_ascii_lowercase());
        }
    }

    if single_bare_hash.is_some() {
        return single_bare_hash;
    }

    if non_empty_lines.len() == 1 {
        let first_token = non_empty_lines[0].split_whitespace().next()?;
        if is_hex_sha256(first_token) {
            return Some(first_token.to_ascii_lowercase());
        }
    }

    None
}

pub fn sanitize_filename(name: &str) -> CoreResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
        || trimmed.chars().any(char::is_control)
    {
        return Err(CoreError::InvalidInput(format!(
            "Invalid asset filename '{name}'"
        )));
    }
    Ok(trimmed.to_string())
}

fn is_localhost_url(raw: &str) -> bool {
    Url::parse(raw).ok().is_some_and(|u| {
        u.host_str()
            .is_some_and(|h| h.eq_ignore_ascii_case("localhost") || h == "127.0.0.1" || h == "::1")
    })
}

pub fn validate_download_url(raw: &str, allow_localhost_http: bool) -> CoreResult<Url> {
    let parsed = Url::parse(raw.trim())
        .map_err(|e| CoreError::InvalidInput(format!("Invalid update URL '{raw}': {e}")))?;
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if allow_localhost_http && is_localhost_url(parsed.as_str()) => Ok(parsed),
        _ => Err(CoreError::InvalidInput(
            "Update download URL must use https://".to_string(),
        )),
    }
}

pub fn open_external_https_url(raw_url: &str) -> CoreResult<()> {
    let parsed = Url::parse(raw_url.trim())
        .map_err(|e| CoreError::InvalidInput(format!("Invalid release URL: {e}")))?;
    if parsed.scheme() != "https" {
        return Err(CoreError::InvalidInput(
            "Only https:// release URLs can be opened in the browser".to_string(),
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

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

struct DownloadRegistrationGuard<'a> {
    map: &'a Mutex<HashMap<String, Arc<AtomicBool>>>,
    id: String,
}

impl Drop for DownloadRegistrationGuard<'_> {
    fn drop(&mut self) {
        self.map.lock().remove(&self.id);
    }
}

pub struct UpdateManager {
    storage: Arc<Storage>,
    api_base_url: String,
    repo: String,
    allow_localhost_http: bool,
    active_downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl UpdateManager {
    pub fn new(storage: Arc<Storage>) -> Self {
        let api_base_url = std::env::var("LIGHTERM_UPDATE_API_BASE")
            .ok()
            .map(|v| v.trim().trim_end_matches('/').to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_GITHUB_API_BASE.to_string());
        let repo = std::env::var("LIGHTERM_UPDATE_REPO")
            .ok()
            .map(|v| v.trim().trim_matches('/').to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_UPDATE_REPO.to_string());
        Self::with_config(storage, api_base_url, repo)
    }

    pub fn with_config(storage: Arc<Storage>, api_base_url: String, repo: String) -> Self {
        let trimmed_base = api_base_url.trim().trim_end_matches('/').to_string();
        let allow_localhost_http = is_localhost_url(&trimmed_base);
        Self {
            storage,
            api_base_url: trimmed_base,
            repo: repo.trim().trim_matches('/').to_string(),
            allow_localhost_http,
            active_downloads: Mutex::new(HashMap::new()),
        }
    }

    fn build_client(&self, current_version: &str, timeout: Duration) -> CoreResult<Client> {
        ensure_rustls_provider();
        let mut headers = HeaderMap::new();
        let ua = format!("Lighterm-Updater/{current_version}");
        headers.insert(
            USER_AGENT,
            HeaderValue::from_str(&ua)
                .unwrap_or_else(|_| HeaderValue::from_static("Lighterm-Updater")),
        );
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github+json"),
        );

        let mut builder = Client::builder()
            .default_headers(headers)
            .timeout(timeout);
        if self.allow_localhost_http {
            builder = builder.no_proxy();
        }
        builder
            .build()
            .map_err(|e| CoreError::PluginError(format!("Failed creating HTTP client: {e}")))
    }

    pub async fn check_for_updates(
        &self,
        current_version: &str,
        can_auto_download_platform: bool,
    ) -> CoreResult<UpdateCheckResult> {
        self.check_for_updates_with_target(
            current_version,
            UpdateTarget::Desktop,
            can_auto_download_platform,
        )
        .await
    }

    pub async fn check_for_updates_with_target(
        &self,
        current_version: &str,
        target: UpdateTarget,
        can_auto_download_platform: bool,
    ) -> CoreResult<UpdateCheckResult> {
        let current_ver = parse_semver_tag(current_version).ok_or_else(|| {
            CoreError::InvalidInput(format!("Invalid current version '{current_version}'"))
        })?;
        let client = self.build_client(&current_ver.to_string(), Duration::from_secs(15))?;

        let mut newer_by_ver: BTreeMap<semver::Version, GitHubRelease> = BTreeMap::new();

        for page in 1..=3u32 {
            let url = format!(
                "{}/repos/{}/releases?per_page=100&page={page}",
                self.api_base_url, self.repo
            );
            let resp = client.get(&url).send().await.map_err(|e| {
                CoreError::PluginError(format!("Failed checking GitHub releases: {e}"))
            })?;
            let status = resp.status();
            if !status.is_success() {
                let body_snippet = resp.text().await.unwrap_or_default();
                let summary = body_snippet.lines().next().unwrap_or("").trim();
                return Err(CoreError::PluginError(format!(
                    "GitHub Releases API returned HTTP {}{}",
                    status.as_u16(),
                    if summary.is_empty() {
                        String::new()
                    } else {
                        format!(": {summary}")
                    }
                )));
            }

            let page_items: Vec<GitHubRelease> = resp.json().await.map_err(|e| {
                CoreError::PluginError(format!("Failed parsing GitHub releases response: {e}"))
            })?;
            let count = page_items.len();
            let mut reached_current_or_older = false;

            for rel in page_items {
                if rel.draft || rel.prerelease {
                    continue;
                }
                let Some(ver) = parse_semver_tag(&rel.tag_name) else {
                    continue;
                };
                if ver > current_ver {
                    newer_by_ver.entry(ver).or_insert(rel);
                } else {
                    reached_current_or_older = true;
                }
            }

            if count < 100 || reached_current_or_older {
                break;
            }
        }

        let now_ms = Utc::now().timestamp_millis();
        let mut prefs = self.storage.get_update_preferences().unwrap_or_default();
        prefs.last_checked_at = Some(now_ms);
        let _ = self.storage.save_update_preferences(prefs.clone());

        if let Some((latest_ver, latest_rel)) = newer_by_ver.iter().next_back() {
            let latest_ver_str = latest_ver.to_string();
            let latest_tag = latest_rel.tag_name.clone();
            let release_url = latest_rel.html_url.clone();
            let published_at = latest_rel.published_at.clone();
            let asset = match target {
                UpdateTarget::Desktop => {
                    select_platform_asset(&latest_rel.assets, std::env::consts::OS, std::env::consts::ARCH)
                }
                UpdateTarget::WebBundle => select_web_bundle_asset(
                    &latest_rel.assets,
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                ),
            };
            let can_auto_download = can_auto_download_platform && asset.is_some();

            let is_skipped = prefs
                .skipped_version
                .as_deref()
                .and_then(parse_semver_tag)
                .is_some_and(|skipped| skipped >= *latest_ver);

            let releases: Vec<ReleaseNoteEntry> = newer_by_ver
                .iter()
                .rev()
                .enumerate()
                .map(|(idx, (ver, rel))| ReleaseNoteEntry {
                    tag_name: rel.tag_name.clone(),
                    version: ver.to_string(),
                    name: rel
                        .name
                        .clone()
                        .filter(|n| !n.trim().is_empty())
                        .unwrap_or_else(|| rel.tag_name.clone()),
                    body: rel.body.clone().unwrap_or_default(),
                    html_url: rel.html_url.clone(),
                    published_at: rel.published_at.clone(),
                    is_latest: idx == 0,
                })
                .collect();

            Ok(UpdateCheckResult {
                current_version: current_ver.to_string(),
                latest_version: latest_ver_str,
                latest_tag,
                release_url,
                published_at,
                has_update: true,
                is_skipped,
                skipped_version: prefs.skipped_version,
                auto_check: prefs.auto_check,
                checked_at: now_ms,
                releases,
                asset,
                can_auto_download,
            })
        } else {
            Ok(UpdateCheckResult {
                current_version: current_ver.to_string(),
                latest_version: current_ver.to_string(),
                latest_tag: format!("v{current_ver}"),
                release_url: format!("https://github.com/{}/releases", self.repo),
                published_at: None,
                has_update: false,
                is_skipped: false,
                skipped_version: prefs.skipped_version,
                auto_check: prefs.auto_check,
                checked_at: now_ms,
                releases: Vec::new(),
                asset: None,
                can_auto_download: false,
            })
        }
    }

    pub async fn download_update(
        &self,
        download_id: String,
        version: String,
        asset: UpdateAssetInfo,
        sink: Arc<dyn CoreEventSink>,
    ) -> CoreResult<DownloadedUpdate> {
        let safe_version = sanitize_filename(version.trim_start_matches(['v', 'V']))?;
        let safe_name = sanitize_filename(&asset.name)?;
        let parsed_url = validate_download_url(&asset.download_url, self.allow_localhost_http)?;
        let parsed_sha_url = match asset.sha256_url.as_deref() {
            Some(raw) if !raw.trim().is_empty() => {
                Some(validate_download_url(raw, self.allow_localhost_http)?)
            }
            _ => None,
        };

        let cancel_flag = Arc::new(AtomicBool::new(false));
        {
            let mut active = self.active_downloads.lock();
            active.insert(download_id.clone(), Arc::clone(&cancel_flag));
        }
        let _guard = DownloadRegistrationGuard {
            map: &self.active_downloads,
            id: download_id.clone(),
        };

        let updates_dir = self.storage.data_dir().join("updates").join(&safe_version);
        tokio::fs::create_dir_all(&updates_dir).await.map_err(|e| {
            CoreError::StorageError(format!(
                "Failed creating updates directory '{}': {e}",
                updates_dir.display()
            ))
        })?;

        let target_path = updates_dir.join(&safe_name);
        let part_path = updates_dir.join(format!("{safe_name}.part"));

        let emit_progress = |payload: UpdateDownloadProgress| {
            if let Ok(val) = serde_json::to_value(payload) {
                sink.on_plugin_event("updater:progress", val);
            }
        };

        let client = self.build_client(&safe_version, Duration::from_secs(300))?;
        let mut resp = client.get(parsed_url).send().await.map_err(|e| {
            let msg = format!("Failed downloading update asset: {e}");
            emit_progress(UpdateDownloadProgress {
                download_id: download_id.clone(),
                version: safe_version.clone(),
                asset_name: safe_name.clone(),
                stage: "error".to_string(),
                downloaded_bytes: 0,
                total_bytes: asset.size,
                speed_bytes_per_sec: 0,
                progress_percent: 0,
                file_path: None,
                sha256_verified: false,
                error: Some(msg.clone()),
            });
            CoreError::PluginError(msg)
        })?;

        if !resp.status().is_success() {
            let msg = format!("Update download failed with HTTP {}", resp.status().as_u16());
            emit_progress(UpdateDownloadProgress {
                download_id: download_id.clone(),
                version: safe_version.clone(),
                asset_name: safe_name.clone(),
                stage: "error".to_string(),
                downloaded_bytes: 0,
                total_bytes: asset.size,
                speed_bytes_per_sec: 0,
                progress_percent: 0,
                file_path: None,
                sha256_verified: false,
                error: Some(msg.clone()),
            });
            return Err(CoreError::PluginError(msg));
        }

        let total_bytes = resp
            .content_length()
            .filter(|&len| len > 0)
            .unwrap_or(asset.size);

        let mut file = tokio::fs::File::create(&part_path).await.map_err(|e| {
            CoreError::StorageError(format!(
                "Failed creating temp update file '{}': {e}",
                part_path.display()
            ))
        })?;

        let mut digest_ctx = DigestContext::new(&SHA256);
        let mut downloaded_bytes: u64 = 0;
        let started = Instant::now();
        let mut last_emit = Instant::now() - Duration::from_millis(200);

        emit_progress(UpdateDownloadProgress {
            download_id: download_id.clone(),
            version: safe_version.clone(),
            asset_name: safe_name.clone(),
            stage: "downloading".to_string(),
            downloaded_bytes: 0,
            total_bytes,
            speed_bytes_per_sec: 0,
            progress_percent: 0,
            file_path: None,
            sha256_verified: false,
            error: None,
        });

        loop {
            if cancel_flag.load(Ordering::SeqCst) {
                drop(file);
                let _ = tokio::fs::remove_file(&part_path).await;
                emit_progress(UpdateDownloadProgress {
                    download_id: download_id.clone(),
                    version: safe_version.clone(),
                    asset_name: safe_name.clone(),
                    stage: "cancelled".to_string(),
                    downloaded_bytes,
                    total_bytes,
                    speed_bytes_per_sec: 0,
                    progress_percent: 0,
                    file_path: None,
                    sha256_verified: false,
                    error: None,
                });
                return Err(CoreError::PluginError("Update download cancelled".to_string()));
            }

            let chunk_opt = resp.chunk().await.map_err(|e| {
                let msg = format!("Network error while downloading update: {e}");
                emit_progress(UpdateDownloadProgress {
                    download_id: download_id.clone(),
                    version: safe_version.clone(),
                    asset_name: safe_name.clone(),
                    stage: "error".to_string(),
                    downloaded_bytes,
                    total_bytes,
                    speed_bytes_per_sec: 0,
                    progress_percent: 0,
                    file_path: None,
                    sha256_verified: false,
                    error: Some(msg.clone()),
                });
                CoreError::PluginError(msg)
            })?;

            let Some(chunk) = chunk_opt else {
                break;
            };

            if cancel_flag.load(Ordering::SeqCst) {
                drop(file);
                let _ = tokio::fs::remove_file(&part_path).await;
                emit_progress(UpdateDownloadProgress {
                    download_id: download_id.clone(),
                    version: safe_version.clone(),
                    asset_name: safe_name.clone(),
                    stage: "cancelled".to_string(),
                    downloaded_bytes,
                    total_bytes,
                    speed_bytes_per_sec: 0,
                    progress_percent: 0,
                    file_path: None,
                    sha256_verified: false,
                    error: None,
                });
                return Err(CoreError::PluginError("Update download cancelled".to_string()));
            }

            if let Err(e) = file.write_all(&chunk).await {
                drop(file);
                let _ = tokio::fs::remove_file(&part_path).await;
                let msg = format!("Failed writing update file: {e}");
                emit_progress(UpdateDownloadProgress {
                    download_id: download_id.clone(),
                    version: safe_version.clone(),
                    asset_name: safe_name.clone(),
                    stage: "error".to_string(),
                    downloaded_bytes,
                    total_bytes,
                    speed_bytes_per_sec: 0,
                    progress_percent: 0,
                    file_path: None,
                    sha256_verified: false,
                    error: Some(msg.clone()),
                });
                return Err(CoreError::StorageError(msg));
            }

            digest_ctx.update(&chunk);
            downloaded_bytes += chunk.len() as u64;

            if last_emit.elapsed() >= Duration::from_millis(80) {
                last_emit = Instant::now();
                let elapsed_secs = started.elapsed().as_secs_f64().max(0.05);
                let speed = (downloaded_bytes as f64 / elapsed_secs) as u64;
                let pct = if total_bytes > 0 {
                    ((downloaded_bytes.saturating_mul(100) / total_bytes).min(100)) as u8
                } else {
                    0
                };
                emit_progress(UpdateDownloadProgress {
                    download_id: download_id.clone(),
                    version: safe_version.clone(),
                    asset_name: safe_name.clone(),
                    stage: "downloading".to_string(),
                    downloaded_bytes,
                    total_bytes,
                    speed_bytes_per_sec: speed,
                    progress_percent: pct,
                    file_path: None,
                    sha256_verified: false,
                    error: None,
                });
            }
        }

        file.flush().await.map_err(|e| {
            CoreError::StorageError(format!("Failed flushing downloaded update: {e}"))
        })?;
        drop(file);

        let elapsed_secs = started.elapsed().as_secs_f64().max(0.05);
        let final_speed = (downloaded_bytes as f64 / elapsed_secs) as u64;
        emit_progress(UpdateDownloadProgress {
            download_id: download_id.clone(),
            version: safe_version.clone(),
            asset_name: safe_name.clone(),
            stage: "verifying".to_string(),
            downloaded_bytes,
            total_bytes: total_bytes.max(downloaded_bytes),
            speed_bytes_per_sec: final_speed,
            progress_percent: 100,
            file_path: None,
            sha256_verified: false,
            error: None,
        });

        let actual_sha256 = hex_encode(digest_ctx.finish().as_ref());
        let mut sha256_verified = false;

        if let Some(sha_url) = parsed_sha_url {
            let sha_client = self.build_client(&safe_version, Duration::from_secs(15))?;
            let sha_resp = sha_client.get(sha_url).send().await.map_err(|e| {
                let msg = format!("Failed downloading SHA-256 checksum: {e}");
                emit_progress(UpdateDownloadProgress {
                    download_id: download_id.clone(),
                    version: safe_version.clone(),
                    asset_name: safe_name.clone(),
                    stage: "error".to_string(),
                    downloaded_bytes,
                    total_bytes: total_bytes.max(downloaded_bytes),
                    speed_bytes_per_sec: 0,
                    progress_percent: 100,
                    file_path: None,
                    sha256_verified: false,
                    error: Some(msg.clone()),
                });
                CoreError::PluginError(msg)
            })?;

            if !sha_resp.status().is_success() {
                let _ = tokio::fs::remove_file(&part_path).await;
                let msg = format!(
                    "SHA-256 checksum download failed with HTTP {}",
                    sha_resp.status().as_u16()
                );
                emit_progress(UpdateDownloadProgress {
                    download_id: download_id.clone(),
                    version: safe_version.clone(),
                    asset_name: safe_name.clone(),
                    stage: "error".to_string(),
                    downloaded_bytes,
                    total_bytes: total_bytes.max(downloaded_bytes),
                    speed_bytes_per_sec: 0,
                    progress_percent: 100,
                    file_path: None,
                    sha256_verified: false,
                    error: Some(msg.clone()),
                });
                return Err(CoreError::PluginError(msg));
            }

            let sha_text = sha_resp.text().await.unwrap_or_default();
            let Some(expected_sha256) = parse_sha256_checksum(&sha_text, &safe_name) else {
                let _ = tokio::fs::remove_file(&part_path).await;
                let msg = "Downloaded .sha256 file did not contain a valid SHA-256 digest".to_string();
                emit_progress(UpdateDownloadProgress {
                    download_id: download_id.clone(),
                    version: safe_version.clone(),
                    asset_name: safe_name.clone(),
                    stage: "error".to_string(),
                    downloaded_bytes,
                    total_bytes: total_bytes.max(downloaded_bytes),
                    speed_bytes_per_sec: 0,
                    progress_percent: 100,
                    file_path: None,
                    sha256_verified: false,
                    error: Some(msg.clone()),
                });
                return Err(CoreError::PluginError(msg));
            };

            if actual_sha256 != expected_sha256 {
                let _ = tokio::fs::remove_file(&part_path).await;
                let msg = format!(
                    "SHA-256 checksum mismatch for {safe_name} (expected {expected_sha256}, got {actual_sha256})"
                );
                emit_progress(UpdateDownloadProgress {
                    download_id: download_id.clone(),
                    version: safe_version.clone(),
                    asset_name: safe_name.clone(),
                    stage: "error".to_string(),
                    downloaded_bytes,
                    total_bytes: total_bytes.max(downloaded_bytes),
                    speed_bytes_per_sec: 0,
                    progress_percent: 100,
                    file_path: None,
                    sha256_verified: false,
                    error: Some(msg.clone()),
                });
                return Err(CoreError::PluginError(msg));
            }

            sha256_verified = true;
        }

        if target_path.exists() {
            let _ = tokio::fs::remove_file(&target_path).await;
        }
        tokio::fs::rename(&part_path, &target_path).await.map_err(|e| {
            CoreError::StorageError(format!(
                "Failed finalizing downloaded update '{}': {e}",
                target_path.display()
            ))
        })?;

        #[cfg(unix)]
        if safe_name.to_ascii_lowercase().ends_with(".appimage") {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&target_path, std::fs::Permissions::from_mode(0o755));
        }

        let file_path_str = target_path.to_string_lossy().into_owned();
        emit_progress(UpdateDownloadProgress {
            download_id: download_id.clone(),
            version: safe_version.clone(),
            asset_name: safe_name.clone(),
            stage: "ready".to_string(),
            downloaded_bytes,
            total_bytes: total_bytes.max(downloaded_bytes),
            speed_bytes_per_sec: final_speed,
            progress_percent: 100,
            file_path: Some(file_path_str.clone()),
            sha256_verified,
            error: None,
        });

        Ok(DownloadedUpdate {
            download_id,
            version: safe_version,
            asset_name: safe_name,
            file_path: file_path_str,
            size_bytes: downloaded_bytes,
            sha256: actual_sha256,
            sha256_verified,
        })
    }

    pub fn cancel_download(&self, download_id: Option<&str>) {
        let active = self.active_downloads.lock();
        if let Some(id) = download_id {
            if let Some(flag) = active.get(id) {
                flag.store(true, Ordering::SeqCst);
            }
        } else {
            for flag in active.values() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    fn canonical_update_file_in_updates_dir(&self, file_path: &str) -> CoreResult<PathBuf> {
        let updates_root = self.storage.data_dir().join("updates");
        let canonical_root = updates_root.canonicalize().map_err(|e| {
            CoreError::InvalidInput(format!("Updates directory is unavailable: {e}"))
        })?;
        let canonical_file = PathBuf::from(file_path).canonicalize().map_err(|e| {
            CoreError::InvalidInput(format!("Downloaded update file not found: {e}"))
        })?;
        if !canonical_file.starts_with(&canonical_root) || !canonical_file.is_file() {
            return Err(CoreError::InvalidInput(
                "Refusing to launch file outside Lighterm updates directory".to_string(),
            ));
        }
        Ok(canonical_file)
    }

    pub fn install_downloaded_update(&self, file_path: &str) -> CoreResult<()> {
        let canonical_file = self.canonical_update_file_in_updates_dir(file_path)?;

        #[cfg(target_os = "windows")]
        {
            Command::new(&canonical_file)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| CoreError::PluginError(format!("Failed launching installer: {e}")))?;
            return Ok(());
        }

        #[cfg(target_os = "macos")]
        {
            Command::new("open")
                .arg(&canonical_file)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| CoreError::PluginError(format!("Failed opening installer: {e}")))?;
            return Ok(());
        }

        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let is_appimage = canonical_file
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.to_ascii_lowercase().ends_with(".appimage"));
            if is_appimage {
                Command::new(&canonical_file)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| {
                        CoreError::PluginError(format!("Failed launching AppImage: {e}"))
                    })?;
            } else {
                Command::new("xdg-open")
                    .arg(&canonical_file)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| CoreError::PluginError(format!("Failed opening package: {e}")))?;
            }
            Ok(())
        }
    }

    pub fn stage_web_bundle_update(&self, file_path: &str) -> CoreResult<StagedWebUpdate> {
        self.stage_web_bundle_update_inner(file_path, cfg!(target_os = "linux"))
    }

    pub(crate) fn stage_web_bundle_update_inner(
        &self,
        file_path: &str,
        probe_binary: bool,
    ) -> CoreResult<StagedWebUpdate> {
        struct TempDirCleanup(Option<PathBuf>);
        impl Drop for TempDirCleanup {
            fn drop(&mut self) {
                if let Some(path) = self.0.take() {
                    let _ = std::fs::remove_dir_all(path);
                }
            }
        }

        let canonical_file = self.canonical_update_file_in_updates_dir(file_path)?;
        let app_dir = self.storage.data_dir().join("app");
        let releases_dir = app_dir.join("releases");
        std::fs::create_dir_all(&releases_dir).map_err(|e| {
            CoreError::StorageError(format!(
                "Failed creating releases directory '{}': {e}",
                releases_dir.display()
            ))
        })?;

        let staging_dir = releases_dir.join(format!(".staging-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&staging_dir).map_err(|e| {
            CoreError::StorageError(format!(
                "Failed creating staging directory '{}': {e}",
                staging_dir.display()
            ))
        })?;
        let mut cleanup = TempDirCleanup(Some(staging_dir.clone()));

        extract_tar_gz_safely(&canonical_file, &staging_dir)?;

        let staged_bin = staging_dir.join("lighterm-server");
        if !staged_bin.is_file() {
            return Err(CoreError::InvalidInput(
                "Web update bundle is missing 'lighterm-server' binary".to_string(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&staged_bin, std::fs::Permissions::from_mode(0o755));
        }

        let staged_dist = staging_dir.join("dist");
        if !staged_dist.join("index.html").is_file() {
            return Err(CoreError::InvalidInput(
                "Web update bundle is missing 'dist/index.html'".to_string(),
            ));
        }

        let version_file = staging_dir.join("VERSION");
        let raw_version = std::fs::read_to_string(&version_file)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                canonical_file
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .map(|s| s.trim().to_string())
            })
            .ok_or_else(|| {
                CoreError::InvalidInput(
                    "Unable to determine version from web update bundle".to_string(),
                )
            })?;

        let parsed_ver = parse_semver_tag(&raw_version).ok_or_else(|| {
            CoreError::InvalidInput(format!("Invalid bundle version '{raw_version}'"))
        })?;
        let safe_ver = sanitize_filename(&parsed_ver.to_string())?;
        std::fs::write(&version_file, format!("{safe_ver}\n")).map_err(|e| {
            CoreError::StorageError(format!("Failed writing VERSION marker: {e}"))
        })?;

        if probe_binary {
            let output = Command::new(&staged_bin)
                .arg("--version")
                .stdin(Stdio::null())
                .output()
                .map_err(|e| {
                    CoreError::PluginError(format!(
                        "Failed verifying staged lighterm-server binary: {e}"
                    ))
                })?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(CoreError::PluginError(format!(
                    "Staged lighterm-server failed compatibility check (exit {:?}): {}",
                    output.status.code(),
                    stderr.trim()
                )));
            }
        }

        let final_dir = releases_dir.join(&safe_ver);
        if final_dir.exists() {
            std::fs::remove_dir_all(&final_dir).map_err(|e| {
                CoreError::StorageError(format!(
                    "Failed replacing existing release directory '{}': {e}",
                    final_dir.display()
                ))
            })?;
        }
        std::fs::rename(&staging_dir, &final_dir).map_err(|e| {
            CoreError::StorageError(format!(
                "Failed promoting staged release '{}': {e}",
                final_dir.display()
            ))
        })?;
        cleanup.0 = None;

        // Atomically update active-version marker and `current` symlink.
        let active_tmp = app_dir.join(".active-version.tmp");
        let active_final = app_dir.join("active-version");
        std::fs::write(&active_tmp, format!("{safe_ver}\n")).map_err(|e| {
            CoreError::StorageError(format!("Failed writing active-version marker: {e}"))
        })?;
        if active_final.exists() {
            let _ = std::fs::remove_file(&active_final);
        }
        std::fs::rename(&active_tmp, &active_final).map_err(|e| {
            CoreError::StorageError(format!("Failed finalizing active-version marker: {e}"))
        })?;

        #[cfg(unix)]
        {
            let tmp_link = app_dir.join(".current.tmp");
            let current_link = app_dir.join("current");
            if tmp_link.symlink_metadata().is_ok() {
                let _ = std::fs::remove_file(&tmp_link);
            }
            std::os::unix::fs::symlink(format!("releases/{safe_ver}"), &tmp_link).map_err(|e| {
                CoreError::StorageError(format!("Failed creating current release symlink: {e}"))
            })?;
            std::fs::rename(&tmp_link, &current_link).map_err(|e| {
                CoreError::StorageError(format!("Failed swapping current release symlink: {e}"))
            })?;
        }

        prune_old_releases(&releases_dir, &safe_ver);
        let _ = std::fs::remove_file(&canonical_file);

        Ok(StagedWebUpdate {
            version: safe_ver,
            release_dir: final_dir.to_string_lossy().into_owned(),
            binary_path: final_dir.join("lighterm-server").to_string_lossy().into_owned(),
            static_dir: final_dir.join("dist").to_string_lossy().into_owned(),
        })
    }
}

fn extract_tar_gz_safely(archive_path: &Path, dest_dir: &Path) -> CoreResult<()> {
    let file = std::fs::File::open(archive_path).map_err(|e| {
        CoreError::StorageError(format!(
            "Failed opening update bundle '{}': {e}",
            archive_path.display()
        ))
    })?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);

    let entries = archive.entries().map_err(|e| {
        CoreError::InvalidInput(format!("Invalid tar.gz update bundle: {e}"))
    })?;

    for entry_res in entries {
        let mut entry = entry_res.map_err(|e| {
            CoreError::InvalidInput(format!("Corrupt entry in tar.gz update bundle: {e}"))
        })?;
        let entry_type = entry.header().entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() || (!entry_type.is_dir() && !entry_type.is_file()) {
            return Err(CoreError::InvalidInput(
                "Refusing unsupported link or special file in web update bundle".to_string(),
            ));
        }

        let raw_path = entry.path().map_err(|e| {
            CoreError::InvalidInput(format!("Invalid entry path in web update bundle: {e}"))
        })?;

        let mut clean_rel = PathBuf::new();
        for comp in raw_path.components() {
            match comp {
                std::path::Component::CurDir => {}
                std::path::Component::Normal(part) => {
                    let s = part.to_string_lossy();
                    if s.contains('\\') || s.contains('\0') {
                        return Err(CoreError::InvalidInput(
                            "Invalid characters in bundle entry path".to_string(),
                        ));
                    }
                    clean_rel.push(part);
                }
                std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_) => {
                    return Err(CoreError::InvalidInput(format!(
                        "Refusing unsafe path traversal '{}' in web update bundle",
                        raw_path.display()
                    )));
                }
            }
        }

        if clean_rel.as_os_str().is_empty() {
            continue;
        }

        let target = dest_dir.join(&clean_rel);
        if entry_type.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| {
                CoreError::StorageError(format!(
                    "Failed creating directory '{}': {e}",
                    target.display()
                ))
            })?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    CoreError::StorageError(format!(
                        "Failed creating parent directory '{}': {e}",
                        parent.display()
                    ))
                })?;
            }
            let mut out = std::fs::File::create(&target).map_err(|e| {
                CoreError::StorageError(format!(
                    "Failed extracting '{}': {e}",
                    target.display()
                ))
            })?;
            std::io::copy(&mut entry, &mut out).map_err(|e| {
                CoreError::StorageError(format!(
                    "Failed writing extracted file '{}': {e}",
                    target.display()
                ))
            })?;
        }
    }

    Ok(())
}

fn prune_old_releases(releases_dir: &Path, keep_active: &str) {
    let Ok(entries) = std::fs::read_dir(releases_dir) else {
        return;
    };
    let mut older: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') || name == keep_active || !path.is_dir() {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        older.push((mtime, path));
    }
    // Keep at most 1 previous release directory alongside the active one.
    older.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in older.into_iter().skip(1) {
        let _ = std::fs::remove_dir_all(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SessionStatus, UpdatePreferences};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct RecordingSink {
        events: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl RecordingSink {
        fn new() -> Self {
            Self {
                events: Mutex::new(Vec::new()),
            }
        }

        fn events(&self) -> Vec<(String, serde_json::Value)> {
            self.events.lock().clone()
        }
    }

    impl CoreEventSink for RecordingSink {
        fn on_terminal_output(&self, _session_id: &str, _data_base64: String) {}
        fn on_terminal_exit(&self, _session_id: &str, _exit_code: Option<u32>) {}
        fn on_terminal_status(
            &self,
            _session_id: &str,
            _status: SessionStatus,
            _message: Option<String>,
        ) {
        }
        fn on_plugin_event(&self, event: &str, payload: serde_json::Value) {
            self.events.lock().push((event.to_string(), payload));
        }
    }

    #[test]
    fn parses_semver_tags_and_rejects_prereleases() {
        assert_eq!(
            parse_semver_tag("v0.3.1"),
            Some(semver::Version::new(0, 3, 1))
        );
        assert_eq!(
            parse_semver_tag("V1.2"),
            Some(semver::Version::new(1, 2, 0))
        );
        assert_eq!(parse_semver_tag("v0.4.0-rc.1"), None);
        assert_eq!(parse_semver_tag("not-a-version"), None);
    }

    #[test]
    fn selects_platform_assets_and_links_sha256() {
        let assets = vec![
            GitHubReleaseAsset {
                name: "Lighterm-Setup-0.3.1-x64.exe".into(),
                browser_download_url: "https://example.com/setup-x64.exe".into(),
                size: 18_400_000,
                content_type: Some("application/vnd.microsoft.portable-executable".into()),
            },
            GitHubReleaseAsset {
                name: "Lighterm-Setup-0.3.1-x64.exe.sha256".into(),
                browser_download_url: "https://example.com/setup-x64.exe.sha256".into(),
                size: 96,
                content_type: Some("text/plain".into()),
            },
            GitHubReleaseAsset {
                name: "Lighterm_0.3.1_aarch64.dmg".into(),
                browser_download_url: "https://example.com/lighterm-arm64.dmg".into(),
                size: 14_000_000,
                content_type: None,
            },
            GitHubReleaseAsset {
                name: "Lighterm_0.3.1_amd64.AppImage".into(),
                browser_download_url: "https://example.com/lighterm-amd64.AppImage".into(),
                size: 20_000_000,
                content_type: None,
            },
        ];

        let win = select_platform_asset(&assets, "windows", "x86_64").expect("win asset");
        assert_eq!(win.name, "Lighterm-Setup-0.3.1-x64.exe");
        assert_eq!(
            win.sha256_url.as_deref(),
            Some("https://example.com/setup-x64.exe.sha256")
        );

        let mac = select_platform_asset(&assets, "macos", "aarch64").expect("mac asset");
        assert_eq!(mac.name, "Lighterm_0.3.1_aarch64.dmg");
        assert_eq!(mac.sha256_url, None);

        let linux = select_platform_asset(&assets, "linux", "x86_64").expect("linux asset");
        assert_eq!(linux.name, "Lighterm_0.3.1_amd64.AppImage");
    }

    #[test]
    fn selects_web_bundle_assets_separately_from_desktop() {
        let assets = vec![
            GitHubReleaseAsset {
                name: "lighterm-web-0.3.1-linux-amd64.tar.gz".into(),
                browser_download_url: "https://example.com/web-amd64.tar.gz".into(),
                size: 5_000_000,
                content_type: Some("application/gzip".into()),
            },
            GitHubReleaseAsset {
                name: "lighterm-web-0.3.1-linux-amd64.tar.gz.sha256".into(),
                browser_download_url: "https://example.com/web-amd64.tar.gz.sha256".into(),
                size: 100,
                content_type: Some("text/plain".into()),
            },
            GitHubReleaseAsset {
                name: "lighterm-web-0.3.1-linux-arm64.tar.gz".into(),
                browser_download_url: "https://example.com/web-arm64.tar.gz".into(),
                size: 5_000_000,
                content_type: Some("application/gzip".into()),
            },
        ];

        assert!(select_platform_asset(&assets, "linux", "x86_64").is_none());

        let amd64 = select_web_bundle_asset(&assets, "linux", "x86_64").expect("web amd64");
        assert_eq!(amd64.name, "lighterm-web-0.3.1-linux-amd64.tar.gz");
        assert_eq!(
            amd64.sha256_url.as_deref(),
            Some("https://example.com/web-amd64.tar.gz.sha256")
        );

        let arm64 = select_web_bundle_asset(&assets, "linux", "aarch64").expect("web arm64");
        assert_eq!(arm64.name, "lighterm-web-0.3.1-linux-arm64.tar.gz");
        assert!(select_web_bundle_asset(&assets, "windows", "x86_64").is_none());
    }

    fn build_tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut builder = tar::Builder::new(&mut gz);
            for (path, data) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(&mut header, path, std::io::Cursor::new(data))
                    .expect("append tar entry");
            }
            builder.finish().expect("finish tar");
        }
        gz.finish().expect("finish gzip")
    }

    #[test]
    fn stage_web_bundle_extracts_validates_prunes_and_rejects_traversal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let storage = Arc::new(Storage::new(dir.path().to_path_buf()).expect("storage"));
        let manager = UpdateManager::new(Arc::clone(&storage));

        // Seed older releases to verify pruning keeps active + 1 previous
        std::fs::create_dir_all(dir.path().join("app/releases/0.1.0")).unwrap();
        std::fs::create_dir_all(dir.path().join("app/releases/0.1.1")).unwrap();
        std::fs::create_dir_all(dir.path().join("app/releases/0.1.2")).unwrap();

        let update_dir = dir.path().join("updates/0.3.1");
        std::fs::create_dir_all(&update_dir).unwrap();
        let good_tgz = update_dir.join("lighterm-web-0.3.1-linux-amd64.tar.gz");
        let payload = build_tar_gz(&[
            ("lighterm-server", b"#!/bin/sh\necho lighterm-server 0.3.1\n"),
            ("dist/index.html", b"<!doctype html><html></html>"),
            ("VERSION", b"0.3.1\n"),
        ]);
        std::fs::write(&good_tgz, payload).unwrap();

        let staged = manager
            .stage_web_bundle_update_inner(&good_tgz.to_string_lossy(), false)
            .expect("stage valid bundle");
        assert_eq!(staged.version, "0.3.1");
        assert!(Path::new(&staged.binary_path).is_file());
        assert!(Path::new(&staged.static_dir).join("index.html").is_file());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("app/active-version"))
                .unwrap()
                .trim(),
            "0.3.1"
        );
        assert!(!good_tgz.exists());

        let remaining_releases: Vec<_> = std::fs::read_dir(dir.path().join("app/releases"))
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_dir())
            .collect();
        assert_eq!(remaining_releases.len(), 2);

        // Missing dist/index.html is rejected
        let missing_dist = update_dir.join("missing-dist.tar.gz");
        std::fs::write(
            &missing_dist,
            build_tar_gz(&[("lighterm-server", b"bin"), ("VERSION", b"0.3.2")]),
        )
        .unwrap();
        let err = manager
            .stage_web_bundle_update_inner(&missing_dist.to_string_lossy(), false)
            .expect_err("missing dist should fail");
        assert!(err.to_string().contains("dist/index.html"));

        // Path traversal is rejected (construct raw header path directly)
        let traversal_tgz = update_dir.join("traversal.tar.gz");
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut builder = tar::Builder::new(&mut gz);
            let data = b"evil";
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            // Set path bypassing Builder's own relative-path guard by writing raw name bytes
            let name_bytes = b"../evil.txt";
            let raw_header = header.as_mut_bytes();
            raw_header[..name_bytes.len()].copy_from_slice(name_bytes);
            header.set_cksum();
            builder.append(&header, std::io::Cursor::new(data)).unwrap();
            builder.finish().unwrap();
        }
        std::fs::write(&traversal_tgz, gz.finish().unwrap()).unwrap();
        let err2 = manager
            .stage_web_bundle_update_inner(&traversal_tgz.to_string_lossy(), false)
            .expect_err("traversal should fail");
        assert!(err2.to_string().contains("traversal"));
    }

    #[test]
    fn parses_sha256_checksum_formats() {
        let digest = "a".repeat(64);
        let standard = format!("{digest}  Lighterm-Setup-0.3.1-x64.exe\n");
        assert_eq!(
            parse_sha256_checksum(&standard, "Lighterm-Setup-0.3.1-x64.exe").as_deref(),
            Some(digest.as_str())
        );

        let multi = format!(
            "{}  other.zip\n{} *Lighterm-Setup-0.3.1-x64.exe\n",
            "b".repeat(64),
            digest
        );
        assert_eq!(
            parse_sha256_checksum(&multi, "Lighterm-Setup-0.3.1-x64.exe").as_deref(),
            Some(digest.as_str())
        );

        assert_eq!(
            parse_sha256_checksum(&digest, "Lighterm-Setup-0.3.1-x64.exe").as_deref(),
            Some(digest.as_str())
        );
        assert_eq!(
            parse_sha256_checksum("invalid-hash", "Lighterm-Setup-0.3.1-x64.exe"),
            None
        );
    }

    #[test]
    fn storage_update_preferences_roundtrip_and_corrupt_recovery() {
        let dir = tempfile::tempdir().expect("tempdir");
        let storage = Storage::new(dir.path().to_path_buf()).expect("storage");

        let defaults = storage.get_update_preferences().expect("defaults");
        assert!(defaults.auto_check);
        assert_eq!(defaults.skipped_version, None);

        let updated = UpdatePreferences {
            auto_check: false,
            skipped_version: Some("0.3.1".into()),
            last_checked_at: Some(1_700_000_000_000),
        };
        storage
            .save_update_preferences(updated.clone())
            .expect("save");
        assert_eq!(storage.get_update_preferences().expect("reload"), updated);

        std::fs::write(dir.path().join("update-state.json"), "{broken json").expect("corrupt");
        assert_eq!(
            storage.get_update_preferences().expect("fallback"),
            UpdatePreferences::default()
        );
    }

    async fn spawn_mock_http_server(
        routes: HashMap<String, (u16, String, Vec<u8>)>,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let routes = Arc::new(routes);

        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let routes = Arc::clone(&routes);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let Ok(n) = socket.read(&mut buf).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("/");

                    let (status, content_type, body) = routes.get(path).cloned().unwrap_or_else(|| {
                        (404, "application/json".to_string(), b"{\"error\":\"not found\"}".to_vec())
                    });

                    let header = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(header.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                });
            }
        });

        format!("http://{addr}")
    }

    #[tokio::test]
    async fn aggregates_releases_filters_drafts_and_honors_skip_version() {
        let dir = tempfile::tempdir().expect("tempdir");
        let storage = Arc::new(Storage::new(dir.path().to_path_buf()).expect("storage"));

        let mut routes = HashMap::new();
        let releases_json = serde_json::json!([
            {
                "tag_name": "v0.4.0-beta.1",
                "name": "Beta",
                "body": "prerelease should be ignored",
                "html_url": "https://github.com/LazyBug1E0CF/Lighterm/releases/tag/v0.4.0-beta.1",
                "draft": false,
                "prerelease": true,
                "published_at": "2026-11-25T00:00:00Z",
                "assets": []
            },
            {
                "tag_name": "v0.3.1",
                "name": "v0.3.1",
                "body": "- feat: auto updater",
                "html_url": "https://github.com/LazyBug1E0CF/Lighterm/releases/tag/v0.3.1",
                "draft": false,
                "prerelease": false,
                "published_at": "2026-11-24T00:00:00Z",
                "assets": [
                    {
                        "name": "Lighterm-Setup-0.3.1-x64.exe",
                        "browser_download_url": "https://example.com/Lighterm-Setup-0.3.1-x64.exe",
                        "size": 1024,
                        "content_type": "application/octet-stream"
                    }
                ]
            },
            {
                "tag_name": "v0.3.0",
                "name": "v0.3.0",
                "body": "- feat: web runtime",
                "html_url": "https://github.com/LazyBug1E0CF/Lighterm/releases/tag/v0.3.0",
                "draft": false,
                "prerelease": false,
                "published_at": "2026-11-10T00:00:00Z",
                "assets": []
            },
            {
                "tag_name": "v0.2.0-draft",
                "name": "Draft",
                "body": "draft ignored",
                "html_url": "https://github.com/LazyBug1E0CF/Lighterm/releases/tag/v0.2.0-draft",
                "draft": true,
                "prerelease": false,
                "published_at": "2026-10-28T00:00:00Z",
                "assets": []
            },
            {
                "tag_name": "v0.2.0",
                "name": "v0.2.0",
                "body": "- feat: github sync",
                "html_url": "https://github.com/LazyBug1E0CF/Lighterm/releases/tag/v0.2.0",
                "draft": false,
                "prerelease": false,
                "published_at": "2026-10-25T00:00:00Z",
                "assets": []
            },
            {
                "tag_name": "v0.1.0",
                "name": "v0.1.0",
                "body": "initial",
                "html_url": "https://github.com/LazyBug1E0CF/Lighterm/releases/tag/v0.1.0",
                "draft": false,
                "prerelease": false,
                "published_at": "2026-10-01T00:00:00Z",
                "assets": []
            }
        ]);

        routes.insert(
            "/repos/LazyBug1E0CF/Lighterm/releases?per_page=100&page=1".to_string(),
            (
                200,
                "application/json".to_string(),
                serde_json::to_vec(&releases_json).unwrap(),
            ),
        );

        let base_url = spawn_mock_http_server(routes).await;
        let manager = UpdateManager::with_config(
            Arc::clone(&storage),
            base_url,
            "LazyBug1E0CF/Lighterm".to_string(),
        );

        let result = manager
            .check_for_updates("0.1.0", true)
            .await
            .expect("check");
        assert!(result.has_update);
        assert!(!result.is_skipped);
        assert_eq!(result.latest_version, "0.3.1");
        assert_eq!(
            result
                .releases
                .iter()
                .map(|r| r.version.as_str())
                .collect::<Vec<_>>(),
            vec!["0.3.1", "0.3.0", "0.2.0"]
        );
        assert!(result.releases[0].is_latest);
        assert!(!result.releases[1].is_latest);

        // Skipping 0.3.1 hides update notification until a newer version arrives
        storage
            .save_update_preferences(UpdatePreferences {
                auto_check: true,
                skipped_version: Some("0.3.1".into()),
                last_checked_at: None,
            })
            .expect("save skip");
        let skipped_res = manager
            .check_for_updates("0.1.0", true)
            .await
            .expect("check skipped");
        assert!(skipped_res.has_update);
        assert!(skipped_res.is_skipped);
    }

    #[tokio::test]
    async fn downloads_and_verifies_sha256_and_rejects_mismatch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let storage = Arc::new(Storage::new(dir.path().to_path_buf()).expect("storage"));

        let payload = b"mock-lighterm-installer-binary-bytes".to_vec();
        let mut ctx = DigestContext::new(&SHA256);
        ctx.update(&payload);
        let good_sha = hex_encode(ctx.finish().as_ref());
        let good_sha_file = format!("{good_sha}  Lighterm-Setup-0.3.1-x64.exe\n").into_bytes();
        let bad_sha_file = format!("{}  Lighterm-Setup-0.3.1-x64.exe\n", "0".repeat(64)).into_bytes();

        let mut routes = HashMap::new();
        routes.insert(
            "/setup.exe".to_string(),
            (200, "application/octet-stream".to_string(), payload.clone()),
        );
        routes.insert(
            "/setup.exe.sha256".to_string(),
            (200, "text/plain".to_string(), good_sha_file),
        );
        routes.insert(
            "/setup-bad.exe.sha256".to_string(),
            (200, "text/plain".to_string(), bad_sha_file),
        );

        let base_url = spawn_mock_http_server(routes).await;
        let manager = UpdateManager::with_config(
            Arc::clone(&storage),
            base_url.clone(),
            "LazyBug1E0CF/Lighterm".to_string(),
        );

        let sink = Arc::new(RecordingSink::new());
        let ok_asset = UpdateAssetInfo {
            name: "Lighterm-Setup-0.3.1-x64.exe".into(),
            download_url: format!("{base_url}/setup.exe"),
            size: payload.len() as u64,
            content_type: None,
            sha256_url: Some(format!("{base_url}/setup.exe.sha256")),
        };

        let downloaded = manager
            .download_update(
                "dl-1".into(),
                "0.3.1".into(),
                ok_asset,
                Arc::clone(&sink) as Arc<dyn CoreEventSink>,
            )
            .await
            .expect("download");
        assert!(downloaded.sha256_verified);
        assert_eq!(downloaded.sha256, good_sha);
        assert!(Path::new(&downloaded.file_path).exists());
        assert!(sink
            .events()
            .iter()
            .any(|(evt, p)| evt == "updater:progress" && p["stage"] == "ready"));

        let bad_asset = UpdateAssetInfo {
            name: "Lighterm-Setup-0.3.1-x64.exe".into(),
            download_url: format!("{base_url}/setup.exe"),
            size: payload.len() as u64,
            content_type: None,
            sha256_url: Some(format!("{base_url}/setup-bad.exe.sha256")),
        };
        let err = manager
            .download_update(
                "dl-2".into(),
                "0.3.1".into(),
                bad_asset,
                Arc::clone(&sink) as Arc<dyn CoreEventSink>,
            )
            .await
            .expect_err("sha mismatch should error");
        assert!(err.to_string().contains("SHA-256 checksum mismatch"));
        assert!(!dir
            .path()
            .join("updates/0.3.1/Lighterm-Setup-0.3.1-x64.exe.part")
            .exists());
    }
}
