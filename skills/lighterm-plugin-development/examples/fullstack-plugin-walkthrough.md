# Walkthrough: Full-Stack Rust + Frontend Plugin (`acme.port-notes`)

A complete minimal full-stack plugin showing every touchpoint from Rust `CorePlugin` crate + `Storage` + `on_host_invalidated` + Tauri v2 IPC commands to a React dual-runtime frontend client and right-drawer viewport.

---

## 1. Backend Crate Manifest (`crates/plugins/port-notes/Cargo.toml`)

```toml
[package]
name = "lighterm-plugin-port-notes"
version = "0.1.0"
edition = "2021"
description = "Per-host port bookmark plugin for Lighterm"

[dependencies]
chrono = "0.4"
lighterm-core = { path = "../../lighterm-core" }
parking_lot = "0.12"
serde = { version = "1", features = ["derive"] }
uuid = { version = "1", features = ["v4"] }

[dev-dependencies]
tempfile = "3"
```

---

## 2. Rust `CorePlugin` Implementation (`crates/plugins/port-notes/src/lib.rs`)

```rust
use std::any::Any;
use std::collections::HashSet;
use std::sync::Arc;

use chrono::Utc;
use lighterm_core::error::{CoreError, CoreResult};
use lighterm_core::plugin::{CoreContext, CorePlugin};
use lighterm_core::storage::Storage;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const DATA_FILE: &str = "port-notes.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortNote {
    pub id: String,
    pub host_id: String,
    pub port: u16,
    pub label: String,
    pub updated_at: i64,
}

#[derive(Default)]
pub struct PortNotesPlugin {
    storage: RwLock<Option<Arc<Storage>>>,
    cached_hosts: Mutex<HashSet<String>>,
}

impl PortNotesPlugin {
    pub fn new() -> Self {
        Self::default()
    }

    fn require_storage(&self) -> CoreResult<Arc<Storage>> {
        self.storage
            .read()
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| CoreError::PluginDisabled("acme.port-notes".to_string()))
    }

    pub fn list_notes(&self, host_id: Option<&str>) -> CoreResult<Vec<PortNote>> {
        let storage = self.require_storage()?;
        let mut items: Vec<PortNote> = storage.read_plugin_json(DATA_FILE)?;
        if let Some(hid) = host_id {
            self.cached_hosts.lock().insert(hid.to_string());
            items.retain(|n| n.host_id == hid);
        }
        Ok(items)
    }

    pub fn save_note(&self, host_id: String, port: u16, label: String) -> CoreResult<PortNote> {
        let storage = self.require_storage()?;
        if host_id.trim().is_empty() || label.trim().is_empty() || port == 0 {
            return Err(CoreError::InvalidInput(
                "hostId, non-empty label, and port > 0 are required".to_string(),
            ));
        }

        let mut items: Vec<PortNote> = storage.read_plugin_json(DATA_FILE)?;
        let note = PortNote {
            id: Uuid::new_v4().to_string(),
            host_id,
            port,
            label: label.trim().to_string(),
            updated_at: Utc::now().timestamp_millis(),
        };
        items.push(note.clone());
        storage.write_plugin_json(DATA_FILE, &items, false)?;
        Ok(note)
    }
}

impl CorePlugin for PortNotesPlugin {
    fn id(&self) -> &'static str {
        "acme.port-notes"
    }

    fn name(&self) -> &'static str {
        "Host Port Notes"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "Saves service port notes per SSH host"
    }

    fn always_on(&self) -> bool {
        false
    }

    fn on_activate(&self, ctx: &CoreContext) -> CoreResult<()> {
        *self.storage.write() = Some(Arc::clone(&ctx.storage));
        Ok(())
    }

    fn on_deactivate(&self) -> CoreResult<()> {
        self.cached_hosts.lock().clear();
        *self.storage.write() = None;
        Ok(())
    }

    fn on_host_invalidated(&self, host_id: &str) {
        self.cached_hosts.lock().remove(host_id);
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
    fn port_notes_crud_and_activation_guard() {
        let dir = tempdir().unwrap();
        let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();
        let plugin = Arc::new(PortNotesPlugin::new());
        core.register_plugin(plugin.clone()).unwrap();

        let saved = plugin
            .save_note("host-1".into(), 5432, "Postgres".into())
            .unwrap();
        assert_eq!(saved.port, 5432);
        assert_eq!(plugin.list_notes(Some("host-1")).unwrap().len(), 1);

        core.plugins
            .set_enabled("acme.port-notes", false, &core.context())
            .unwrap();
        assert!(matches!(
            core.plugins.get_active::<PortNotesPlugin>("acme.port-notes"),
            Err(CoreError::PluginDisabled(_))
        ));
    }
}
```

---

## 3. Cargo Workspace & Tauri Registration

1. **Root `Cargo.toml`**:
   ```toml
   [workspace]
   resolver = "2"
   members = [
     ...,
     "crates/plugins/port-notes",
   ]
   ```
2. **`src-tauri/Cargo.toml`**:
   ```toml
   lighterm-plugin-port-notes = { path = "../crates/plugins/port-notes" }
   ```
3. **`src-tauri/src/commands.rs`** — always check `get_active` and keep `host:actions` invalidation automatic:
   ```rust
   use lighterm_plugin_port_notes::{PortNote, PortNotesPlugin};

   #[tauri::command]
   pub async fn port_notes_list(
       state: State<'_, AppState>,
       host_id: Option<String>,
   ) -> CoreResult<Vec<PortNote>> {
       let plugin = state
           .core
           .plugins
           .get_active::<PortNotesPlugin>("acme.port-notes")?;
       run_blocking(CoreError::PluginError, move || {
           plugin.list_notes(host_id.as_deref())
       })
       .await
   }

   #[tauri::command]
   pub async fn port_notes_save(
       state: State<'_, AppState>,
       host_id: String,
       port: u16,
       label: String,
   ) -> CoreResult<PortNote> {
       let plugin = state
           .core
           .plugins
           .get_active::<PortNotesPlugin>("acme.port-notes")?;
       run_blocking(CoreError::PluginError, move || {
           plugin.save_note(host_id, port, label)
       })
       .await
   }
   ```
4. **`src-tauri/src/lib.rs`**:
   - Import `use lighterm_plugin_port_notes::PortNotesPlugin;`
   - Register in `run()`:
     ```rust
     core.register_plugin(Arc::new(PortNotesPlugin::new()))
         .expect("Failed to register Port Notes plugin");
     ```
   - Add `commands::port_notes_list` and `commands::port_notes_save` to `tauri::generate_handler![...]`.

---

## 4. Dual-Runtime Client (`src/plugins/port-notes/portNotesClient.ts`)

```ts
import { create } from 'zustand';
import { invokeTauri, isTauriRuntime, makeUuid, readLs, writeLs } from '../../core/ipc';

export interface PortNote {
  id: string;
  hostId: string;
  port: number;
  label: string;
  updatedAt: number;
}

export interface PortNotesConfig extends Record<string, unknown> {
  showHostBadge: boolean;
}

export const DEFAULT_PORT_NOTES_CONFIG: PortNotesConfig = {
  showHostBadge: true,
};

const LS_PORT_NOTES = 'lighterm:port-notes';

interface PortNotesStoreState {
  notes: PortNote[];
}

export const usePortNotesStore = create<PortNotesStoreState>(() => ({
  notes: [],
}));

export const portNotesClient = {
  async list(hostId?: string): Promise<PortNote[]> {
    const notes = isTauriRuntime()
      ? await invokeTauri<PortNote[]>('port_notes_list', { hostId })
      : readLs<PortNote[]>(LS_PORT_NOTES, () => []).filter((n) => !hostId || n.hostId === hostId);
    usePortNotesStore.setState({ notes });
    return notes;
  },

  async save(hostId: string, port: number, label: string): Promise<PortNote> {
    if (isTauriRuntime()) {
      // Rust params `host_id, port, label` map to `{ hostId, port, label }` in Tauri v2
      const saved = await invokeTauri<PortNote>('port_notes_save', { hostId, port, label });
      await this.list();
      return saved;
    }

    const current = readLs<PortNote[]>(LS_PORT_NOTES, () => []);
    const note: PortNote = {
      id: makeUuid('pn'),
      hostId,
      port,
      label: label.trim(),
      updatedAt: Date.now(),
    };
    const next = [...current, note];
    writeLs(LS_PORT_NOTES, next);
    usePortNotesStore.setState({ notes: next });
    return note;
  },

  resetForTesting(): void {
    usePortNotesStore.setState({ notes: [] });
  },
};
```

---

## 5. Frontend Entry (`src/plugins/port-notes/index.tsx`) & Registration

```tsx
import React, { useEffect } from 'react';
import { Network } from 'lucide-react';
import { definePlugin, usePluginConfig, type PluginSettingsPageProps, type ViewportComponentProps } from '../../kernel';
import { DEFAULT_PORT_NOTES_CONFIG, portNotesClient, usePortNotesStore } from './portNotesClient';

export const PORT_NOTES_VIEWPORT_TYPE = 'acme.port-notes.panel';

const PortNotesViewport: React.FC<ViewportComponentProps> = () => {
  const notes = usePortNotesStore((s) => s.notes);

  useEffect(() => {
    void portNotesClient.list();
  }, []);

  return (
    <div className="p-2 text-xs text-[var(--text-primary)] space-y-1.5">
      {notes.length === 0 ? (
        <div className="text-[var(--text-muted)]">No saved port notes yet.</div>
      ) : (
        notes.map((n) => (
          <div
            key={n.id}
            className="px-2 py-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-app)] flex items-center justify-between"
          >
            <span>{n.label}</span>
            <span className="font-mono text-[var(--accent)]">:{n.port}</span>
          </div>
        ))
      )}
    </div>
  );
};

const PortNotesSettingsPage: React.FC<PluginSettingsPageProps> = ({ pluginId }) => {
  const { config, updateConfig } = usePluginConfig(pluginId, DEFAULT_PORT_NOTES_CONFIG);
  return (
    <label className="flex items-center gap-2 text-[var(--text-primary)] cursor-pointer">
      <input
        type="checkbox"
        checked={Boolean(config.showHostBadge)}
        onChange={(e) => void updateConfig({ showHostBadge: e.target.checked })}
      />
      <span>Show port notes shortcut on SSH Host cards</span>
    </label>
  );
};

export const portNotesPlugin = definePlugin({
  id: 'acme.port-notes',
  name: 'Host Port Notes',
  version: '1.0.0',
  description: 'Saves service port notes per SSH host',
  icon: Network,
  author: 'Acme',
  inject: ['core:layout'],
  defaultEnabled: true,
  alwaysOn: false, // Matches CorePlugin::always_on() == false

  activate(ctx) {
    const layout = ctx.inject('core:layout');

    ctx.registerViewport({
      typeId: PORT_NOTES_VIEWPORT_TYPE,
      title: 'Port Notes',
      icon: Network,
      defaultPosition: 'right-drawer',
      defaultFloatSize: { width: 320, height: 420 },
      singleton: true,
      openOnStartup: false,
      order: 60,
      component: PortNotesViewport,
    });

    ctx.registerSettingsPage({
      id: 'port-notes',
      title: 'Port Notes',
      description: 'Configure host card actions for Port Notes.',
      icon: Network,
      order: 60,
      component: PortNotesSettingsPage,
    });

    ctx.registerSlot({
      id: 'port-notes-host-action',
      slot: 'host:actions',
      order: 60,
      render: (context) => {
        if (!context?.host) return null;
        if (!ctx.getConfig(DEFAULT_PORT_NOTES_CONFIG).showHostBadge) return null;
        return (
          <button
            type="button"
            onClick={() => {
              layout.openPluginViewport(PORT_NOTES_VIEWPORT_TYPE);
              void portNotesClient.list(context.host!.id);
            }}
            className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-app)] text-[var(--text-muted)] hover:text-[var(--accent)]"
          >
            Ports
          </button>
        );
      },
    });
  },
});
```

Finally, register `portNotesPlugin` inside `registerBuiltinPlugins` in `src/plugins/index.ts`, and call `portNotesClient.resetForTesting()` inside `resetLightermKernelForTesting()`.
