use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::Serialize;
use uuid::Uuid;

use crate::error::{CoreError, CoreResult};
use crate::models::{AppSettings, HostConfig};

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

    // ---- Generic Plugin Storage ----

    pub fn has_plugin_file(&self, name: &str) -> bool {
        let _guard = self.lock.lock();
        self.file_path(name).exists()
    }

    pub fn read_plugin_json<T: DeserializeOwned + Default>(&self, name: &str) -> CoreResult<T> {
        let _guard = self.lock.lock();
        self.read_json_or_default(name)
    }

    pub fn write_plugin_json<T: Serialize>(
        &self,
        name: &str,
        value: &T,
        restricted: bool,
    ) -> CoreResult<()> {
        let _guard = self.lock.lock();
        self.write_json_atomic(name, value, restricted)
    }

    // ---- Plugin States ----

    pub fn get_plugin_states(&self) -> CoreResult<HashMap<String, bool>> {
        let _guard = self.lock.lock();
        self.read_json_or_default("plugins.json")
    }

    pub fn save_plugin_states(&self, states: &HashMap<String, bool>) -> CoreResult<()> {
        let _guard = self.lock.lock();
        self.write_json_atomic("plugins.json", states, false)
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
