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
use crate::models::{AppSettings, HostConfig, SavedWorkspace};

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

    // ---- Workspaces ----

    pub fn list_workspaces(&self) -> CoreResult<Vec<SavedWorkspace>> {
        let _guard = self.lock.lock();
        self.read_json_or_default("workspaces.json")
    }

    pub fn save_workspace(&self, mut workspace: SavedWorkspace) -> CoreResult<SavedWorkspace> {
        let trimmed_name = workspace.name.trim().to_string();
        if trimmed_name.is_empty() {
            return Err(CoreError::InvalidInput(
                "workspace name cannot be empty".into(),
            ));
        }
        workspace.name = trimmed_name;

        let _guard = self.lock.lock();
        let mut workspaces: Vec<SavedWorkspace> = self.read_json_or_default("workspaces.json")?;
        let now = chrono::Utc::now().timestamp_millis();

        if workspace.id.trim().is_empty() {
            workspace.id = uuid::Uuid::new_v4().to_string();
        }
        if workspace.created_at == 0 {
            if let Some(existing) = workspaces.iter().find(|w| w.id == workspace.id) {
                workspace.created_at = existing.created_at;
            } else {
                workspace.created_at = now;
            }
        }
        workspace.updated_at = now;

        if let Some(existing) = workspaces.iter_mut().find(|w| w.id == workspace.id) {
            *existing = workspace.clone();
        } else {
            workspaces.push(workspace.clone());
        }

        self.write_json_atomic("workspaces.json", &workspaces, true)?;
        Ok(workspace)
    }

    pub fn delete_workspace(&self, id: &str) -> CoreResult<()> {
        let _guard = self.lock.lock();
        let mut workspaces: Vec<SavedWorkspace> = self.read_json_or_default("workspaces.json")?;
        workspaces.retain(|w| w.id != id);
        self.write_json_atomic("workspaces.json", &workspaces, true)
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

#[cfg(test)]
mod workspace_tests {
    use super::*;
    use crate::models::{
        QuickShellLayoutPreset, SavedDockNode, SavedFloatingSlot, SavedTerminalSlot, SessionKind,
        SplitDirection,
    };

    #[test]
    fn workspaces_persist_and_serialize_dock_nodes_camel_case() {
        let dir = tempfile::tempdir().expect("tempdir");
        let storage = Storage::new(dir.path().to_path_buf()).expect("storage");

        assert!(storage.list_workspaces().expect("initial list").is_empty());

        let dock = SavedDockNode::Split {
            direction: SplitDirection::Horizontal,
            ratio: 0.42,
            first: Box::new(SavedDockNode::Group {
                slot_ids: vec!["slot-1".into(), "slot-2".into()],
                active_slot_id: Some("slot-2".into()),
            }),
            second: Box::new(SavedDockNode::Group {
                slot_ids: vec!["slot-3".into()],
                active_slot_id: Some("slot-3".into()),
            }),
        };

        let json_val = serde_json::to_value(&dock).expect("serialize dock");
        assert_eq!(json_val["type"], "split");
        assert_eq!(json_val["direction"], "horizontal");
        assert_eq!(json_val["first"]["type"], "group");
        assert!(json_val["first"].get("slotIds").is_some());
        assert!(json_val["first"].get("slot_ids").is_none());
        assert_eq!(json_val["first"]["activeSlotId"], "slot-2");

        let saved = storage
            .save_workspace(SavedWorkspace {
                id: String::new(),
                name: "  Prod Cluster  ".into(),
                slots: vec![SavedTerminalSlot {
                    slot_id: "slot-1".into(),
                    title: "web-01".into(),
                    kind: SessionKind::Ssh,
                    host_id: Some("host-1".into()),
                    cwd: None,
                    shell: None,
                }],
                dock_root: Some(dock),
                floating: vec![SavedFloatingSlot {
                    slot_id: "slot-float".into(),
                    x: 40.0,
                    y: 50.0,
                    width: 420.0,
                    height: 300.0,
                    z_index: 3,
                }],
                active_slot_id: Some("slot-2".into()),
                maximized_slot_id: None,
                layout_preset: Some(QuickShellLayoutPreset::Hsp),
                created_at: 0,
                updated_at: 0,
            })
            .expect("save workspace");

        assert!(!saved.id.is_empty());
        assert_eq!(saved.name, "Prod Cluster");
        assert!(saved.created_at > 0);
        assert!(saved.updated_at >= saved.created_at);

        let listed = storage.list_workspaces().expect("list after save");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, saved.id);
        assert_eq!(listed[0].layout_preset, Some(QuickShellLayoutPreset::Hsp));
        assert_eq!(listed[0].floating.len(), 1);

        let mut renamed = listed[0].clone();
        renamed.name = "Staging Cluster".into();
        let updated = storage.save_workspace(renamed).expect("rename save");
        assert_eq!(updated.id, saved.id);
        assert_eq!(updated.created_at, saved.created_at);
        assert_eq!(storage.list_workspaces().expect("list").len(), 1);
        assert_eq!(
            storage.list_workspaces().expect("list")[0].name,
            "Staging Cluster"
        );

        storage.delete_workspace(&saved.id).expect("delete");
        assert!(storage.list_workspaces().expect("list after delete").is_empty());
    }
}
