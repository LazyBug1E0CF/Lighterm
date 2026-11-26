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
        "linux" => pick_by(&|n| n.ends_with(".appimage") && matches_arch_token(n, arch))
            .or_else(|| pick_by(&|n| n.ends_with(".deb") && matches_arch_token(n, arch)))
            .or_else(|| pick_by(&|n| n.ends_with(".rpm") && matches_arch_token(n, arch)))
            .or_else(|| pick_by(&|n| n.ends_with(".tar.gz") && matches_arch_token(n, arch)))
            .or_else(|| {
                pick_by(&|n| {
                    (n.ends_with(".appimage") || n.ends_with(".deb"))
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
            let asset =
                select_platform_asset(&latest_rel.assets, std::env::consts::OS, std::env::consts::ARCH);
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

    pub fn install_downloaded_update(&self, file_path: &str) -> CoreResult<()> {
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
