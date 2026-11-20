use std::any::Any;
use std::sync::Arc;

use chrono::Utc;
use lighterm_core::error::{CoreError, CoreResult};
use lighterm_core::plugin::{CoreContext, CorePlugin};
use lighterm_core::storage::Storage;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const SNIPPETS_FILE: &str = "snippets.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub title: String,
    pub command: String,
    pub category: String,
    pub description: Option<String>,
    pub auto_execute: bool,
    pub updated_at: i64,
}

#[derive(Default)]
pub struct SnippetsPlugin {
    storage: RwLock<Option<Arc<Storage>>>,
}

impl SnippetsPlugin {
    pub fn new() -> Self {
        Self::default()
    }

    fn require_storage(&self) -> CoreResult<Arc<Storage>> {
        self.storage
            .read()
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| CoreError::PluginDisabled("lighterm.snippets".to_string()))
    }

    pub fn list_snippets(&self) -> CoreResult<Vec<Snippet>> {
        let storage = self.require_storage()?;
        storage.read_plugin_json(SNIPPETS_FILE)
    }

    pub fn save_snippet(&self, mut snippet: Snippet) -> CoreResult<Snippet> {
        let storage = self.require_storage()?;
        let mut snippets: Vec<Snippet> = storage.read_plugin_json(SNIPPETS_FILE)?;
        if snippet.id.trim().is_empty() {
            snippet.id = Uuid::new_v4().to_string();
        }
        snippet.updated_at = Utc::now().timestamp_millis();

        if let Some(existing) = snippets.iter_mut().find(|s| s.id == snippet.id) {
            *existing = snippet.clone();
        } else {
            snippets.push(snippet.clone());
        }
        storage.write_plugin_json(SNIPPETS_FILE, &snippets, false)?;
        Ok(snippet)
    }

    pub fn delete_snippet(&self, id: &str) -> CoreResult<()> {
        let storage = self.require_storage()?;
        let mut snippets: Vec<Snippet> = storage.read_plugin_json(SNIPPETS_FILE)?;
        snippets.retain(|s| s.id != id);
        storage.write_plugin_json(SNIPPETS_FILE, &snippets, false)
    }
}

impl CorePlugin for SnippetsPlugin {
    fn id(&self) -> &'static str {
        "lighterm.snippets"
    }

    fn name(&self) -> &'static str {
        "Command Snippets"
    }

    fn description(&self) -> &'static str {
        "Reusable command templates with {{variable}} prompts and persistence"
    }

    fn on_activate(&self, ctx: &CoreContext) -> CoreResult<()> {
        if !ctx.storage.has_plugin_file(SNIPPETS_FILE) {
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
                    command: "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'"
                        .to_string(),
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
            ctx.storage
                .write_plugin_json(SNIPPETS_FILE, &starters, false)?;
        }

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
    fn snippets_seed_and_crud_roundtrip() {
        let dir = tempdir().unwrap();
        let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();
        let plugin = Arc::new(SnippetsPlugin::new());
        core.register_plugin(plugin.clone()).unwrap();

        let seeded = plugin.list_snippets().unwrap();
        assert!(!seeded.is_empty());

        let saved = plugin
            .save_snippet(Snippet {
                id: String::new(),
                title: "Check Memory".to_string(),
                command: "free -h".to_string(),
                category: "System".to_string(),
                description: None,
                auto_execute: true,
                updated_at: 0,
            })
            .unwrap();
        assert_eq!(plugin.list_snippets().unwrap().len(), seeded.len() + 1);

        plugin.delete_snippet(&saved.id).unwrap();
        assert_eq!(plugin.list_snippets().unwrap().len(), seeded.len());
    }
}
