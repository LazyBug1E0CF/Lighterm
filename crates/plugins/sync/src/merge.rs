use std::collections::{HashMap, HashSet};

use lighterm_core::error::CoreResult;
use lighterm_core::models::{AppSettings, AuthMethod, HostConfig, SavedWorkspace};

use crate::crypto::sha256_hex;
use crate::models::{ConflictResolution, SyncedSnippet};

pub const TOMBSTONE_RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;

pub trait SyncEntity: Clone {
    fn id(&self) -> &str;
    fn updated_at(&self) -> i64;
}

impl SyncEntity for HostConfig {
    fn id(&self) -> &str {
        &self.id
    }

    fn updated_at(&self) -> i64 {
        self.updated_at
    }
}

impl SyncEntity for SavedWorkspace {
    fn id(&self) -> &str {
        &self.id
    }

    fn updated_at(&self) -> i64 {
        self.updated_at
    }
}

impl SyncEntity for SyncedSnippet {
    fn id(&self) -> &str {
        &self.id
    }

    fn updated_at(&self) -> i64 {
        self.updated_at
    }
}

pub fn strip_host_secrets(host: &HostConfig) -> HostConfig {
    let mut cleaned = host.clone();
    cleaned.auth = match &host.auth {
        AuthMethod::Password { .. } => AuthMethod::Password { password: None },
        AuthMethod::PrivateKey { key_path, .. } => AuthMethod::PrivateKey {
            key_path: key_path.clone(),
            private_key_pem: None,
            passphrase: None,
        },
    };
    cleaned
}

pub fn host_has_secrets(host: &HostConfig) -> bool {
    match &host.auth {
        AuthMethod::Password { password } => password.as_deref().is_some_and(|s| !s.is_empty()),
        AuthMethod::PrivateKey {
            private_key_pem,
            passphrase,
            ..
        } => {
            private_key_pem.as_deref().is_some_and(|s| !s.trim().is_empty())
                || passphrase.as_deref().is_some_and(|s| !s.is_empty())
        }
    }
}

pub fn preserve_local_secrets(incoming: &HostConfig, local: Option<&HostConfig>) -> HostConfig {
    let Some(local_host) = local else {
        return incoming.clone();
    };
    if host_has_secrets(incoming) {
        return incoming.clone();
    }
    let mut merged = incoming.clone();
    merged.auth = match (&incoming.auth, &local_host.auth) {
        (AuthMethod::Password { .. }, AuthMethod::Password { password }) => AuthMethod::Password {
            password: password.clone(),
        },
        (
            AuthMethod::PrivateKey { key_path, .. },
            AuthMethod::PrivateKey {
                private_key_pem,
                passphrase,
                ..
            },
        ) => AuthMethod::PrivateKey {
            key_path: key_path.clone(),
            private_key_pem: private_key_pem.clone(),
            passphrase: passphrase.clone(),
        },
        _ => incoming.auth.clone(),
    };
    merged
}

pub fn prune_tombstones(map: &mut HashMap<String, i64>, now_ms: i64) {
    let cutoff = now_ms - TOMBSTONE_RETENTION_MS;
    map.retain(|_, ts| *ts >= cutoff);
}

pub fn collect_local_deletions(
    last_synced_ids: &[String],
    current_ids: &HashSet<String>,
    tombstones: &mut HashMap<String, i64>,
    now_ms: i64,
) {
    for id in last_synced_ids {
        if !current_ids.contains(id) {
            tombstones.entry(id.clone()).or_insert(now_ms);
        }
    }
    prune_tombstones(tombstones, now_ms);
}

pub fn merge_tombstones(
    local: &HashMap<String, i64>,
    remote: &HashMap<String, i64>,
    now_ms: i64,
) -> HashMap<String, i64> {
    let mut merged = local.clone();
    for (id, ts) in remote {
        merged
            .entry(id.clone())
            .and_modify(|existing| {
                if *ts > *existing {
                    *existing = *ts;
                }
            })
            .or_insert(*ts);
    }
    prune_tombstones(&mut merged, now_ms);
    merged
}

pub fn merge_entities<T: SyncEntity>(
    local: &[T],
    remote: &[T],
    tombstones: &mut HashMap<String, i64>,
    resolution: ConflictResolution,
) -> Vec<T> {
    let local_map: HashMap<&str, &T> = local.iter().map(|item| (item.id(), item)).collect();
    let remote_map: HashMap<&str, &T> = remote.iter().map(|item| (item.id(), item)).collect();

    let mut ordered_ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for item in local {
        let id = item.id().to_string();
        if seen.insert(id.clone()) {
            ordered_ids.push(id);
        }
    }
    for item in remote {
        let id = item.id().to_string();
        if seen.insert(id.clone()) {
            ordered_ids.push(id);
        }
    }

    let mut result = Vec::new();
    for id in ordered_ids {
        let l = local_map.get(id.as_str()).copied();
        let r = remote_map.get(id.as_str()).copied();
        let tomb_ts = tombstones.get(&id).copied();

        let chosen: Option<T> = match (l, r) {
            (Some(li), Some(ri)) => {
                if let Some(t_ts) = tomb_ts {
                    let max_item_ts = li.updated_at().max(ri.updated_at());
                    if t_ts > max_item_ts {
                        None
                    } else {
                        tombstones.remove(&id);
                        Some(pick_conflict(li, ri, resolution))
                    }
                } else {
                    Some(pick_conflict(li, ri, resolution))
                }
            }
            (Some(li), None) => {
                if let Some(t_ts) = tomb_ts {
                    if t_ts >= li.updated_at() {
                        None
                    } else {
                        tombstones.remove(&id);
                        Some(li.clone())
                    }
                } else {
                    Some(li.clone())
                }
            }
            (None, Some(ri)) => {
                if let Some(t_ts) = tomb_ts {
                    if t_ts >= ri.updated_at() {
                        None
                    } else {
                        tombstones.remove(&id);
                        Some(ri.clone())
                    }
                } else {
                    Some(ri.clone())
                }
            }
            (None, None) => None,
        };

        if let Some(item) = chosen {
            result.push(item);
        }
    }

    result
}

fn pick_conflict<T: SyncEntity>(local: &T, remote: &T, resolution: ConflictResolution) -> T {
    match resolution {
        ConflictResolution::Local => local.clone(),
        ConflictResolution::Remote => remote.clone(),
        ConflictResolution::Newest => {
            if remote.updated_at() > local.updated_at() {
                remote.clone()
            } else {
                local.clone()
            }
        }
    }
}

pub fn merge_hosts(
    local: &[HostConfig],
    remote: &[HostConfig],
    tombstones: &mut HashMap<String, i64>,
    resolution: ConflictResolution,
    remote_includes_secrets: bool,
) -> Vec<HostConfig> {
    let local_by_id: HashMap<&str, &HostConfig> = local.iter().map(|h| (h.id.as_str(), h)).collect();
    let merged = merge_entities(local, remote, tombstones, resolution);

    if remote_includes_secrets {
        merged
    } else {
        merged
            .into_iter()
            .map(|h| preserve_local_secrets(&h, local_by_id.get(h.id.as_str()).copied()))
            .collect()
    }
}

pub fn merge_snippets(
    local: &[SyncedSnippet],
    remote: &[SyncedSnippet],
    tombstones: &mut HashMap<String, i64>,
    resolution: ConflictResolution,
    is_first_sync: bool,
) -> Vec<SyncedSnippet> {
    if !is_first_sync {
        return merge_entities(local, remote, tombstones, resolution);
    }

    // Deduplicate freshly seeded starter snippets that have identical (title, command) on first sync
    let remote_keys: HashSet<(&str, &str)> = remote
        .iter()
        .map(|s| (s.title.trim(), s.command.trim()))
        .collect();
    let remote_ids: HashSet<&str> = remote.iter().map(|s| s.id.as_str()).collect();

    let filtered_local: Vec<SyncedSnippet> = local
        .iter()
        .filter(|s| {
            remote_ids.contains(s.id.as_str())
                || !remote_keys.contains(&(s.title.trim(), s.command.trim()))
        })
        .cloned()
        .collect();

    merge_entities(&filtered_local, remote, tombstones, resolution)
}

pub fn merge_singleton<T: Clone + serde::Serialize>(
    local: &T,
    remote: &T,
    last_synced_hash: Option<&str>,
    resolution: ConflictResolution,
    is_first_sync: bool,
    prefer_remote_if_local_default: Option<&T>,
) -> CoreResult<T> {
    let local_hash = sha256_hex(local)?;
    let remote_hash = sha256_hex(remote)?;

    if local_hash == remote_hash {
        return Ok(local.clone());
    }

    if is_first_sync {
        if let Some(default_val) = prefer_remote_if_local_default {
            let default_hash = sha256_hex(default_val)?;
            if local_hash == default_hash {
                return Ok(remote.clone());
            }
        }
    }

    if let Some(base) = last_synced_hash {
        let local_changed = local_hash != base;
        let remote_changed = remote_hash != base;
        if !local_changed && remote_changed {
            return Ok(remote.clone());
        }
        if local_changed && !remote_changed {
            return Ok(local.clone());
        }
    }

    match resolution {
        ConflictResolution::Local => Ok(local.clone()),
        ConflictResolution::Remote | ConflictResolution::Newest => Ok(remote.clone()),
    }
}

pub fn merge_settings(
    local: &AppSettings,
    remote: &AppSettings,
    last_hash: Option<&str>,
    resolution: ConflictResolution,
    is_first_sync: bool,
) -> CoreResult<AppSettings> {
    let defaults = AppSettings::default();
    merge_singleton(
        local,
        remote,
        last_hash,
        resolution,
        is_first_sync,
        Some(&defaults),
    )
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBundle {
    pub plugin_states: HashMap<String, bool>,
    pub plugin_configs: HashMap<String, serde_json::Value>,
}

pub fn filter_plugin_states_for_sync(
    states: &HashMap<String, bool>,
    sync_plugin_id: &str,
) -> HashMap<String, bool> {
    states
        .iter()
        .filter(|(id, _)| id.as_str() != sync_plugin_id)
        .map(|(id, enabled)| (id.clone(), *enabled))
        .collect()
}

pub fn filter_plugin_configs_for_sync(
    configs: &HashMap<String, serde_json::Value>,
    sync_plugin_id: &str,
) -> HashMap<String, serde_json::Value> {
    configs
        .iter()
        .filter(|(id, _)| id.as_str() != sync_plugin_id)
        .map(|(id, cfg)| (id.clone(), cfg.clone()))
        .collect()
}

pub fn compute_invalidated_host_ids(before: &[HostConfig], after: &[HostConfig]) -> Vec<String> {
    let before_map: HashMap<&str, String> = before
        .iter()
        .filter_map(|h| sha256_hex(h).ok().map(|hash| (h.id.as_str(), hash)))
        .collect();
    let after_map: HashMap<&str, String> = after
        .iter()
        .filter_map(|h| sha256_hex(h).ok().map(|hash| (h.id.as_str(), hash)))
        .collect();

    let mut changed = HashSet::new();
    for (id, hash) in &before_map {
        match after_map.get(id) {
            Some(after_hash) if after_hash == hash => {}
            _ => {
                changed.insert((*id).to_string());
            }
        }
    }
    for id in after_map.keys() {
        if !before_map.contains_key(id) {
            changed.insert((*id).to_string());
        }
    }
    let mut out: Vec<String> = changed.into_iter().collect();
    out.sort();
    out
}
