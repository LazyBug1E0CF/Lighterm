use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::error::{CoreError, CoreResult};
use crate::models::PluginInfo;
use crate::session_manager::SessionManager;
use crate::ssh::SshConnectionPool;
use crate::storage::Storage;

/// Minimal kernel context injected into every backend plugin on activation.
#[derive(Clone)]
pub struct CoreContext {
    pub storage: Arc<Storage>,
    pub ssh_pool: Arc<SshConnectionPool>,
    pub sessions: Arc<SessionManager>,
}

/// Validates that a plugin identifier uses lowercase dot-separated namespaces (e.g. `lighterm.sftp`).
pub fn is_valid_plugin_id(id: &str) -> bool {
    let mut segments = id.split('.');
    let mut count = 0usize;
    for seg in &mut segments {
        count += 1;
        let mut chars = seg.chars();
        let Some(first) = chars.next() else {
            return false;
        };
        if !matches!(first, 'a'..='z' | '0'..='9') {
            return false;
        }
        if !chars.all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_' | '-')) {
            return false;
        }
    }
    count >= 2
}

/// Cordis-inspired plugin trait for Lighterm backend capabilities.
pub trait CorePlugin: Send + Sync + 'static {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn version(&self) -> &'static str {
        "1.0.0"
    }
    fn description(&self) -> &'static str;
    fn dependencies(&self) -> &'static [&'static str] {
        &[]
    }

    fn always_on(&self) -> bool {
        false
    }

    fn on_activate(&self, _ctx: &CoreContext) -> CoreResult<()> {
        Ok(())
    }

    fn on_deactivate(&self) -> CoreResult<()> {
        Ok(())
    }

    /// Invoked when a saved SSH host profile is updated or deleted so plugins can clear caches.
    fn on_host_invalidated(&self, _host_id: &str) {}

    fn as_any_arc(self: Arc<Self>) -> Arc<dyn Any + Send + Sync>;
}

struct PluginEntry {
    plugin: Arc<dyn CorePlugin>,
    enabled: bool,
    active: bool,
}

pub struct PluginRegistry {
    entries: Mutex<HashMap<String, PluginEntry>>,
    order: Mutex<Vec<String>>,
}

impl Default for PluginRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginRegistry {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            order: Mutex::new(Vec::new()),
        }
    }

    pub fn register(&self, plugin: Arc<dyn CorePlugin>, ctx: &CoreContext) -> CoreResult<()> {
        let id_str = plugin.id();
        if !is_valid_plugin_id(id_str) {
            return Err(CoreError::PluginError(format!(
                "Invalid plugin ID '{id_str}': expected lowercase dot-separated segments (e.g. 'lighterm.sftp')"
            )));
        }
        if plugin.name().trim().is_empty() {
            return Err(CoreError::PluginError(format!(
                "Invalid plugin '{id_str}': name cannot be empty"
            )));
        }
        if plugin.version().trim().is_empty() {
            return Err(CoreError::PluginError(format!(
                "Invalid plugin '{id_str}': version cannot be empty"
            )));
        }

        let id = id_str.to_string();
        let persisted = ctx.storage.get_plugin_states().unwrap_or_default();
        let enabled = if plugin.always_on() {
            true
        } else {
            persisted.get(&id).copied().unwrap_or(true)
        };

        let deps_satisfied = {
            let entries = self.entries.lock();
            plugin
                .dependencies()
                .iter()
                .all(|dep| entries.get(*dep).is_some_and(|e| e.active))
        };

        let should_activate = enabled && deps_satisfied;
        if should_activate {
            plugin.on_activate(ctx)?;
        }

        {
            let mut entries = self.entries.lock();
            if !entries.contains_key(&id) {
                self.order.lock().push(id.clone());
            }
            entries.insert(
                id,
                PluginEntry {
                    plugin,
                    enabled,
                    active: should_activate,
                },
            );
        }

        // Cascade activation for any already-registered enabled plugins waiting on this one
        if should_activate {
            self.reconcile_activations(ctx)?;
        }

        Ok(())
    }

    fn reconcile_activations(&self, ctx: &CoreContext) -> CoreResult<()> {
        loop {
            let next_to_activate: Option<(String, Arc<dyn CorePlugin>)> = {
                let entries = self.entries.lock();
                let order = self.order.lock();
                order.iter().find_map(|id| {
                    let entry = entries.get(id)?;
                    if !entry.enabled || entry.active {
                        return None;
                    }
                    let deps_ok = entry
                        .plugin
                        .dependencies()
                        .iter()
                        .all(|dep| entries.get(*dep).is_some_and(|d| d.active));
                    if deps_ok {
                        Some((id.clone(), Arc::clone(&entry.plugin)))
                    } else {
                        None
                    }
                })
            };

            let Some((id, plugin)) = next_to_activate else {
                break;
            };
            plugin.on_activate(ctx)?;
            if let Some(entry) = self.entries.lock().get_mut(&id) {
                entry.active = true;
            }
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<PluginInfo> {
        let entries = self.entries.lock();
        let order = self.order.lock();
        order
            .iter()
            .filter_map(|id| entries.get(id))
            .map(|entry| PluginInfo {
                id: entry.plugin.id().to_string(),
                name: entry.plugin.name().to_string(),
                version: entry.plugin.version().to_string(),
                description: entry.plugin.description().to_string(),
                enabled: entry.active,
                always_on: entry.plugin.always_on(),
                dependencies: entry
                    .plugin
                    .dependencies()
                    .iter()
                    .map(|s| (*s).to_string())
                    .collect(),
            })
            .collect()
    }

    pub fn notify_host_invalidated(&self, host_id: &str) {
        let active_plugins: Vec<Arc<dyn CorePlugin>> = {
            let entries = self.entries.lock();
            let order = self.order.lock();
            order
                .iter()
                .filter_map(|id| entries.get(id))
                .filter(|entry| entry.active)
                .map(|entry| Arc::clone(&entry.plugin))
                .collect()
        };
        for plugin in active_plugins {
            plugin.on_host_invalidated(host_id);
        }
    }

    pub fn is_active(&self, id: &str) -> bool {
        self.entries
            .lock()
            .get(id)
            .is_some_and(|entry| entry.active)
    }

    pub fn get_active<P: CorePlugin + 'static>(&self, id: &str) -> CoreResult<Arc<P>> {
        let plugin = {
            let entries = self.entries.lock();
            let entry = entries
                .get(id)
                .ok_or_else(|| CoreError::PluginError(format!("Unknown plugin '{id}'")))?;
            if !entry.active {
                return Err(CoreError::PluginDisabled(id.to_string()));
            }
            Arc::clone(&entry.plugin)
        };

        plugin
            .as_any_arc()
            .downcast::<P>()
            .map_err(|_| CoreError::PluginError(format!("Plugin type mismatch for '{id}'")))
    }

    pub fn set_enabled(
        &self,
        id: &str,
        enabled: bool,
        ctx: &CoreContext,
    ) -> CoreResult<Vec<PluginInfo>> {
        if enabled {
            let plugin = {
                let entries = self.entries.lock();
                let entry = entries
                    .get(id)
                    .ok_or_else(|| CoreError::PluginError(format!("Unknown plugin '{id}'")))?;

                for dep in entry.plugin.dependencies() {
                    if !entries.get(*dep).is_some_and(|d| d.active) {
                        return Err(CoreError::PluginError(format!(
                            "Cannot enable '{id}': missing active dependency '{dep}'"
                        )));
                    }
                }
                Arc::clone(&entry.plugin)
            };

            if !self.is_active(id) {
                plugin.on_activate(ctx)?;
            }

            {
                let mut entries = self.entries.lock();
                if let Some(entry) = entries.get_mut(id) {
                    entry.enabled = true;
                    entry.active = true;
                }
            }

            self.reconcile_activations(ctx)?;
        } else {
            let is_always_on = {
                let entries = self.entries.lock();
                let entry = entries
                    .get(id)
                    .ok_or_else(|| CoreError::PluginError(format!("Unknown plugin '{id}'")))?;
                entry.plugin.always_on()
            };
            if is_always_on {
                return Ok(self.list());
            }
            self.deactivate_recursive(id)?;
        }

        let states: HashMap<String, bool> = {
            let entries = self.entries.lock();
            entries
                .iter()
                .map(|(k, v)| (k.clone(), v.enabled))
                .collect()
        };
        ctx.storage.save_plugin_states(&states)?;

        Ok(self.list())
    }

    fn deactivate_recursive(&self, target_id: &str) -> CoreResult<()> {
        let mut visited = HashSet::new();
        self.deactivate_with_dependents(target_id, &mut visited, true)
    }

    fn deactivate_with_dependents(
        &self,
        id: &str,
        visited: &mut HashSet<String>,
        mark_disabled: bool,
    ) -> CoreResult<()> {
        if !visited.insert(id.to_string()) {
            return Ok(());
        }

        let dependents: Vec<String> = {
            let entries = self.entries.lock();
            if !entries.contains_key(id) {
                return Err(CoreError::PluginError(format!("Unknown plugin '{id}'")));
            }
            entries
                .iter()
                .filter(|(_, entry)| entry.active && entry.plugin.dependencies().contains(&id))
                .map(|(dep_id, _)| dep_id.clone())
                .collect()
        };

        for dep_id in dependents {
            self.deactivate_with_dependents(&dep_id, visited, false)?;
        }

        let plugin_to_deactivate = {
            let mut entries = self.entries.lock();
            let entry = entries
                .get_mut(id)
                .ok_or_else(|| CoreError::PluginError(format!("Unknown plugin '{id}'")))?;
            if mark_disabled {
                entry.enabled = false;
            }
            if entry.active {
                entry.active = false;
                Some(Arc::clone(&entry.plugin))
            } else {
                None
            }
        };

        if let Some(plugin) = plugin_to_deactivate {
            plugin.on_deactivate()?;
        }

        Ok(())
    }
}
