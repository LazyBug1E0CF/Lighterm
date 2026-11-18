use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::Serialize;
use uuid::Uuid;

use crate::error::{CoreError, CoreResult};
use crate::models::{AppSettings, HistoryEntry, HostConfig, SessionKind, Snippet};

pub struct Storage {
    data_dir: PathBuf,
    lock: Mutex<()>,
}

impl Storage {
    pub fn new(data_dir: PathBuf) -> CoreResult<Self> {
        fs::create_dir_all(&data_dir).map_err(|e| {
            CoreError::StorageError(format!(
                "Failed to create data directory '{}': {e}",
                data_dir.display()
            ))
        })?;
        let storage = Self {
            data_dir,
            lock: Mutex::new(()),
        };
        storage.ensure_defaults()?;
        Ok(storage)
    }

    pub fn default_dir() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("lighterm")
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    fn file_path(&self, name: &str) -> PathBuf {
        self.data_dir.join(name)
    }

    fn ensure_defaults(&self) -> CoreResult<()> {
        let snippets_path = self.file_path("snippets.json");
        if !snippets_path.exists() {
            let now = Utc::now().timestamp_millis();
            let starters = vec![
                Snippet {
                    id: Uuid::new_v4().to_string(),
                    title: "Disk Usage (Human)".to_string(),
                    command: "df -h".to_string(),
                    category: "System".to_string(),
                    description: Some("Show mounted filesystem disk usage".to_string()),
                    auto_execute: true,
                    updated_at: now,
                },
                Snippet {
                    id: Uuid::new_v4().to_string(),
                    title: "Listening Ports".to_string(),
                    command: "ss -tulpn".to_string(),
                    category: "Network".to_string(),
                    description: Some("List listening TCP/UDP sockets".to_string()),
                    auto_execute: true,
                    updated_at: now,
                },
                Snippet {
                    id: Uuid::new_v4().to_string(),
                    title: "Docker Containers".to_string(),
                    command: "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'".to_string(),
                    category: "Docker".to_string(),
                    description: Some("Compact running container status table".to_string()),
                    auto_execute: true,
                    updated_at: now,
                },
                Snippet {
                    id: Uuid::new_v4().to_string(),
                    title: "Follow Service Logs".to_string(),
                    command: "journalctl -u {{service}} -f -n 100".to_string(),
                    category: "System".to_string(),
                    description: Some("Tail systemd logs for a service".to_string()),
                    auto_execute: false,
                    updated_at: now,
                },
                Snippet {
                    id: Uuid::new_v4().to_string(),
                    title: "Find Large Files".to_string(),
                    command: "du -ah {{path}} | sort -rh | head -n 20".to_string(),
                    category: "Files".to_string(),
                    description: Some("Top 20 largest files/folders under path".to_string()),
                    auto_execute: false,
                    updated_at: now,
                },
            ];
            self.write_json_atomic("snippets.json", &starters, false)?;
        }

        let settings_path = self.file_path("settings.json");
        if !settings_path.exists() {
            self.write_json_atomic("settings.json", &AppSettings::default(), false)?;
        }
        Ok(())
    }

    fn read_json_or_default<T: DeserializeOwned + Default>(&self, name: &str) -> CoreResult<T> {
        let path = self.file_path(name);
        if !path.exists() {
            return Ok(T::default());
        }
        let raw = fs::read_to_string(&path).map_err(|e| {
            CoreError::StorageError(format!("Failed to read '{}': {e}", path.display()))
        })?;
        if raw.trim().is_empty() {
            return Ok(T::default());
        }
        serde_json::from_str(&raw).map_err(|e| {
            CoreError::StorageError(format!("Failed to parse '{}': {e}", path.display()))
        })
    }

    fn write_json_atomic<T: Serialize>(
        &self,
        name: &str,
        value: &T,
        restricted: bool,
    ) -> CoreResult<()> {
        let target = self.file_path(name);
        let tmp = self.file_path(&format!("{name}.tmp"));
        let json = serde_json::to_string_pretty(value)
            .map_err(|e| CoreError::StorageError(format!("Serialization error: {e}")))?;

        let mut file = fs::File::create(&tmp).map_err(|e| {
            CoreError::StorageError(format!("Failed to create '{}': {e}", tmp.display()))
        })?;

        #[cfg(unix)]
        if restricted {
            use std::os::unix::fs::PermissionsExt;
            let perms = fs::Permissions::from_mode(0o600);
            let _ = fs::set_permissions(&tmp, perms);
        }

        #[cfg(not(unix))]
        let _ = restricted;

        file.write_all(json.as_bytes()).and_then(|_| file.flush()).map_err(|e| {
            CoreError::StorageError(format!("Failed to write '{}': {e}", tmp.display()))
        })?;
        drop(file);

        fs::rename(&tmp, &target).map_err(|e| {
            CoreError::StorageError(format!("Failed to commit '{}': {e}", target.display()))
        })
    }

    // ---- Hosts ----

    pub fn list_hosts(&self) -> CoreResult<Vec<HostConfig>> {
        let _guard = self.lock.lock();
        self.read_json_or_default("hosts.json")
    }

    pub fn get_host(&self, id: &str) -> CoreResult<Option<HostConfig>> {
        let hosts = self.list_hosts()?;
        Ok(hosts.into_iter().find(|h| h.id == id))
    }

    pub fn save_host(&self, mut host: HostConfig) -> CoreResult<HostConfig> {
        let _guard = self.lock.lock();
        let mut hosts: Vec<HostConfig> = self.read_json_or_default("hosts.json")?;
        if host.id.trim().is_empty() {
            host.id = Uuid::new_v4().to_string();
        }
        host.updated_at = Utc::now().timestamp_millis();

        if let Some(existing) = hosts.iter_mut().find(|h| h.id == host.id) {
            *existing = host.clone();
        } else {
            hosts.push(host.clone());
        }
        self.write_json_atomic("hosts.json", &hosts, true)?;
        Ok(host)
    }

    pub fn delete_host(&self, id: &str) -> CoreResult<()> {
        let _guard = self.lock.lock();
        let mut hosts: Vec<HostConfig> = self.read_json_or_default("hosts.json")?;
        hosts.retain(|h| h.id != id);
        self.write_json_atomic("hosts.json", &hosts, true)
    }

    // ---- Snippets ----

    pub fn list_snippets(&self) -> CoreResult<Vec<Snippet>> {
        let _guard = self.lock.lock();
        self.read_json_or_default("snippets.json")
    }

    pub fn save_snippet(&self, mut snippet: Snippet) -> CoreResult<Snippet> {
        let _guard = self.lock.lock();
        let mut snippets: Vec<Snippet> = self.read_json_or_default("snippets.json")?;
        if snippet.id.trim().is_empty() {
            snippet.id = Uuid::new_v4().to_string();
        }
        snippet.updated_at = Utc::now().timestamp_millis();

        if let Some(existing) = snippets.iter_mut().find(|s| s.id == snippet.id) {
            *existing = snippet.clone();
        } else {
            snippets.push(snippet.clone());
        }
        self.write_json_atomic("snippets.json", &snippets, false)?;
        Ok(snippet)
    }

    pub fn delete_snippet(&self, id: &str) -> CoreResult<()> {
        let _guard = self.lock.lock();
        let mut snippets: Vec<Snippet> = self.read_json_or_default("snippets.json")?;
        snippets.retain(|s| s.id != id);
        self.write_json_atomic("snippets.json", &snippets, false)
    }

    // ---- History ----

    pub fn list_history(&self, query: Option<&str>, limit: Option<usize>) -> CoreResult<Vec<HistoryEntry>> {
        let _guard = self.lock.lock();
        let mut entries: Vec<HistoryEntry> = self.read_json_or_default("history.json")?;
        entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

        if let Some(q) = query.map(str::trim).filter(|s| !s.is_empty()) {
            let lower = q.to_lowercase();
            entries.retain(|e| {
                e.command.to_lowercase().contains(&lower)
                    || e.host_label.to_lowercase().contains(&lower)
            });
        }

        if let Some(max) = limit {
            entries.truncate(max);
        }
        Ok(entries)
    }

    pub fn record_history(
        &self,
        command: String,
        session_kind: SessionKind,
        host_label: String,
    ) -> CoreResult<Option<HistoryEntry>> {
        let trimmed = command.trim().to_string();
        if trimmed.is_empty() {
            return Ok(None);
        }

        let _guard = self.lock.lock();
        let mut entries: Vec<HistoryEntry> = self.read_json_or_default("history.json")?;
        let now = Utc::now().timestamp_millis();

        let saved = if let Some(existing) = entries.iter_mut().find(|e| e.command == trimmed) {
            existing.timestamp = now;
            existing.count = existing.count.saturating_add(1);
            existing.session_kind = session_kind;
            existing.host_label = host_label;
            existing.clone()
        } else {
            let entry = HistoryEntry {
                id: Uuid::new_v4().to_string(),
                command: trimmed,
                session_kind,
                host_label,
                timestamp: now,
                count: 1,
            };
            entries.push(entry.clone());
            entry
        };

        entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        if entries.len() > 1000 {
            entries.truncate(1000);
        }
        self.write_json_atomic("history.json", &entries, false)?;
        Ok(Some(saved))
    }

    pub fn delete_history(&self, id: &str) -> CoreResult<()> {
        let _guard = self.lock.lock();
        let mut entries: Vec<HistoryEntry> = self.read_json_or_default("history.json")?;
        entries.retain(|e| e.id != id);
        self.write_json_atomic("history.json", &entries, false)
    }

    pub fn clear_history(&self) -> CoreResult<()> {
        let _guard = self.lock.lock();
        let empty: Vec<HistoryEntry> = Vec::new();
        self.write_json_atomic("history.json", &empty, false)
    }

    // ---- Settings ----

    pub fn get_settings(&self) -> CoreResult<AppSettings> {
        let _guard = self.lock.lock();
        let path = self.file_path("settings.json");
        if !path.exists() {
            return Ok(AppSettings::default());
        }
        self.read_json_or_default("settings.json")
    }

    pub fn save_settings(&self, settings: AppSettings) -> CoreResult<AppSettings> {
        let _guard = self.lock.lock();
        self.write_json_atomic("settings.json", &settings, false)?;
        Ok(settings)
    }
}
