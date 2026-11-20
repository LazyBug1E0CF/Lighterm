use std::any::Any;
use std::sync::Arc;

use chrono::Utc;
use lighterm_core::error::{CoreError, CoreResult};
use lighterm_core::models::SessionKind;
use lighterm_core::plugin::{CoreContext, CorePlugin};
use lighterm_core::storage::Storage;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const HISTORY_FILE: &str = "history.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub command: String,
    pub session_kind: SessionKind,
    pub host_label: String,
    pub timestamp: i64,
    pub count: u32,
}

#[derive(Default)]
pub struct HistoryPlugin {
    storage: RwLock<Option<Arc<Storage>>>,
}

impl HistoryPlugin {
    pub fn new() -> Self {
        Self::default()
    }

    fn require_storage(&self) -> CoreResult<Arc<Storage>> {
        self.storage
            .read()
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| CoreError::PluginDisabled("lighterm.history".to_string()))
    }

    pub fn list_history(
        &self,
        query: Option<&str>,
        limit: Option<usize>,
    ) -> CoreResult<Vec<HistoryEntry>> {
        let storage = self.require_storage()?;
        let mut entries: Vec<HistoryEntry> = storage.read_plugin_json(HISTORY_FILE)?;
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
        let storage = self.require_storage()?;
        let trimmed = command.trim().to_string();
        if trimmed.is_empty() {
            return Ok(None);
        }

        let mut entries: Vec<HistoryEntry> = storage.read_plugin_json(HISTORY_FILE)?;
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
        storage.write_plugin_json(HISTORY_FILE, &entries, false)?;
        Ok(Some(saved))
    }

    pub fn delete_history(&self, id: &str) -> CoreResult<()> {
        let storage = self.require_storage()?;
        let mut entries: Vec<HistoryEntry> = storage.read_plugin_json(HISTORY_FILE)?;
        entries.retain(|e| e.id != id);
        storage.write_plugin_json(HISTORY_FILE, &entries, false)
    }

    pub fn clear_history(&self) -> CoreResult<()> {
        let storage = self.require_storage()?;
        let empty: Vec<HistoryEntry> = Vec::new();
        storage.write_plugin_json(HISTORY_FILE, &empty, false)
    }
}

impl CorePlugin for HistoryPlugin {
    fn id(&self) -> &'static str {
        "lighterm.history"
    }

    fn name(&self) -> &'static str {
        "Command History"
    }

    fn description(&self) -> &'static str {
        "Searchable deduplicated command history recorder and quick launcher"
    }

    fn on_activate(&self, ctx: &CoreContext) -> CoreResult<()> {
        *self.storage.write() = Some(Arc::clone(&ctx.storage));
        Ok(())
    }

    fn on_deactivate(&self) -> CoreResult<()> {
        *self.storage.write() = None;
        Ok(())
    }

    fn as_any_arc(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lighterm_core::LightermCore;
    use tempfile::tempdir;

    #[test]
    fn history_deduplication_filter_and_clear() {
        let dir = tempdir().unwrap();
        let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();
        let plugin = Arc::new(HistoryPlugin::new());
        core.register_plugin(plugin.clone()).unwrap();

        plugin
            .record_history("ls -la".to_string(), SessionKind::Local, "Local".to_string())
            .unwrap();
        plugin
            .record_history("uname -a".to_string(), SessionKind::Local, "Local".to_string())
            .unwrap();
        let updated = plugin
            .record_history("ls -la".to_string(), SessionKind::Local, "Local".to_string())
            .unwrap()
            .unwrap();
        assert_eq!(updated.count, 2);

        let filtered = plugin.list_history(Some("uname"), Some(10)).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].command, "uname -a");

        plugin.clear_history().unwrap();
        assert!(plugin.list_history(None, None).unwrap().is_empty());
    }
}
