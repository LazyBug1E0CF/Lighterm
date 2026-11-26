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
use crate::models::{AppSettings, HostConfig, SavedWorkspace, UpdatePreferences, WindowBounds};

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

    // ---- Plugin States & Configs ----

    pub fn get_plugin_states(&self) -> CoreResult<HashMap<String, bool>> {
        let _guard = self.lock.lock();
        self.read_json_or_default("plugins.json")
    }

    pub fn save_plugin_states(&self, states: &HashMap<String, bool>) -> CoreResult<()> {
        let _guard = self.lock.lock();
        self.write_json_atomic("plugins.json", states, false)
    }

    pub fn get_all_plugin_configs(&self) -> CoreResult<HashMap<String, serde_json::Value>> {
        let _guard = self.lock.lock();
        self.read_json_or_default("plugin-configs.json")
    }

    pub fn save_all_plugin_configs(&self, configs: &HashMap<String, serde_json::Value>) -> CoreResult<()> {
        for (plugin_id, value) in configs {
            if !crate::plugin::is_valid_plugin_id(plugin_id) {
                return Err(CoreError::InvalidInput(format!(
                    "Invalid plugin ID '{plugin_id}'"
                )));
            }
            if !value.is_object() {
                return Err(CoreError::InvalidInput(format!(
                    "Plugin config for '{plugin_id}' must be a JSON object"
                )));
            }
        }
        let _guard = self.lock.lock();
        self.write_json_atomic("plugin-configs.json", configs, false)
    }

    pub fn get_plugin_config(&self, plugin_id: &str) -> CoreResult<serde_json::Value> {
        if !crate::plugin::is_valid_plugin_id(plugin_id) {
            return Err(CoreError::InvalidInput(format!(
                "Invalid plugin ID '{plugin_id}'"
            )));
        }
        let _guard = self.lock.lock();
        let all: HashMap<String, serde_json::Value> =
            self.read_json_or_default("plugin-configs.json")?;
        Ok(all
            .get(plugin_id)
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Object(Default::default())))
    }

    pub fn save_plugin_config(
        &self,
        plugin_id: &str,
        config: serde_json::Value,
    ) -> CoreResult<serde_json::Value> {
        if !crate::plugin::is_valid_plugin_id(plugin_id) {
            return Err(CoreError::InvalidInput(format!(
                "Invalid plugin ID '{plugin_id}'"
            )));
        }
        if !config.is_object() {
            return Err(CoreError::InvalidInput(
                "Plugin config must be a JSON object".to_string(),
            ));
        }
        let _guard = self.lock.lock();
        let mut all: HashMap<String, serde_json::Value> =
            self.read_json_or_default("plugin-configs.json")?;
        all.insert(plugin_id.to_string(), config.clone());
        self.write_json_atomic("plugin-configs.json", &all, false)?;
        Ok(config)
    }

    pub fn reset_plugin_config(&self, plugin_id: &str) -> CoreResult<()> {
        if !crate::plugin::is_valid_plugin_id(plugin_id) {
            return Err(CoreError::InvalidInput(format!(
                "Invalid plugin ID '{plugin_id}'"
            )));
        }
        let _guard = self.lock.lock();
        let mut all: HashMap<String, serde_json::Value> =
            self.read_json_or_default("plugin-configs.json")?;
        if all.remove(plugin_id).is_some() {
            self.write_json_atomic("plugin-configs.json", &all, false)?;
        }
        Ok(())
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

    pub fn replace_hosts(&self, hosts: &[HostConfig]) -> CoreResult<()> {
        let _guard = self.lock.lock();
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

    pub fn replace_workspaces(&self, workspaces: &[SavedWorkspace]) -> CoreResult<()> {
        let _guard = self.lock.lock();
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

    // ---- Window Bounds ----

    pub fn get_window_bounds(&self) -> CoreResult<Option<WindowBounds>> {
        let _guard = self.lock.lock();
        let path = self.file_path("window-state.json");
        if !path.exists() {
            return Ok(None);
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            return Ok(None);
        };
        if raw.trim().is_empty() {
            return Ok(None);
        }
        let Ok(bounds) = serde_json::from_str::<WindowBounds>(&raw) else {
            return Ok(None);
        };
        if !bounds.is_sane() {
            return Ok(None);
        }
        Ok(Some(bounds))
    }

    pub fn save_window_bounds(&self, bounds: WindowBounds) -> CoreResult<WindowBounds> {
        if !bounds.is_sane() {
            return Err(CoreError::InvalidInput("invalid window bounds".into()));
        }
        let _guard = self.lock.lock();
        self.write_json_atomic("window-state.json", &bounds, false)?;
        Ok(bounds)
    }

    // ---- Updater Preferences ----

    pub fn get_update_preferences(&self) -> CoreResult<UpdatePreferences> {
        let _guard = self.lock.lock();
        let path = self.file_path("update-state.json");
        if !path.exists() {
            return Ok(UpdatePreferences::default());
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            return Ok(UpdatePreferences::default());
        };
        if raw.trim().is_empty() {
            return Ok(UpdatePreferences::default());
        }
        Ok(serde_json::from_str::<UpdatePreferences>(&raw).unwrap_or_default())
    }

    pub fn save_update_preferences(
        &self,
        prefs: UpdatePreferences,
    ) -> CoreResult<UpdatePreferences> {
        let _guard = self.lock.lock();
        self.write_json_atomic("update-state.json", &prefs, false)?;
        Ok(prefs)
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

    #[test]
    fn window_bounds_persist_validate_and_clamp_monitors() {
        use crate::models::{MonitorRect, WindowBounds};

        let dir = tempfile::tempdir().expect("tempdir");
        let storage = Storage::new(dir.path().to_path_buf()).expect("storage");

        assert_eq!(storage.get_window_bounds().expect("initial empty"), None);

        // Reject Win32 minimized sentinel (-32000, -32000) or collapsed sizes
        let minimized = WindowBounds {
            x: -32_000,
            y: -32_000,
            width: 1200,
            height: 800,
            maximized: false,
        };
        assert!(!minimized.is_sane());
        assert!(storage.save_window_bounds(minimized).is_err());

        let collapsed = WindowBounds {
            x: 100,
            y: 100,
            width: 120,
            height: 80,
            maximized: false,
        };
        assert!(!collapsed.is_sane());
        assert!(storage.save_window_bounds(collapsed).is_err());

        // Persist and reload normal + maximized flag
        let saved_bounds = WindowBounds {
            x: -1600,
            y: 80,
            width: 1200,
            height: 800,
            maximized: true,
        };
        storage
            .save_window_bounds(saved_bounds)
            .expect("save valid bounds");
        assert_eq!(
            storage.get_window_bounds().expect("reload bounds"),
            Some(saved_bounds)
        );

        // Corrupt JSON recovers safely to None rather than failing startup
        fs::write(dir.path().join("window-state.json"), "{broken json").expect("write corrupt");
        assert_eq!(storage.get_window_bounds().expect("corrupt fallback"), None);

        // Multi-monitor clamping preserves valid secondary negative-x monitor coordinates
        let dual_monitors = [
            MonitorRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            MonitorRect {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1080,
            },
        ];
        assert_eq!(
            saved_bounds.clamp_to_monitors(&dual_monitors),
            Some(saved_bounds)
        );

        // Unplugging the secondary monitor re-centers onto the primary monitor
        let primary_only = [MonitorRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        }];
        let clamped_unplugged = saved_bounds
            .clamp_to_monitors(&primary_only)
            .expect("clamped onto primary");
        assert_eq!(clamped_unplugged.width, 1200);
        assert_eq!(clamped_unplugged.height, 800);
        assert_eq!(clamped_unplugged.x, 360);
        assert_eq!(clamped_unplugged.y, 140);
        assert!(clamped_unplugged.maximized);

        // Window whose top drag strip sits off-screen is also re-centered onto primary
        let top_offscreen = WindowBounds {
            x: 200,
            y: -100,
            width: 1000,
            height: 700,
            maximized: false,
        };
        let clamped_top = top_offscreen
            .clamp_to_monitors(&primary_only)
            .expect("clamped top bar");
        assert_eq!(clamped_top.x, 460);
        assert_eq!(clamped_top.y, 190);
    }
}
