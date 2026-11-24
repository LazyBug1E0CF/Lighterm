# Rust Backend & Tauri IPC Reference

Authoritative contract reference for writing Rust backend plugins in `crates/plugins/<name>/` (`crates/lighterm-core`) and exposing them over Tauri v2 IPC (`src-tauri/`).

---

## 1. Crate Structure & Cargo Wiring

Every backend plugin is an independent workspace member crate:

```text
crates/plugins/<plugin-name>/
├── Cargo.toml    # [package] name = "lighterm-plugin-<plugin-name>"
└── src/
    └── lib.rs    # Pub struct implementing CorePlugin + unit tests
```

Wire the new crate in two Cargo manifests:
1. Root `Cargo.toml` -> add `"crates/plugins/<plugin-name>"` to `[workspace].members`.
2. `src-tauri/Cargo.toml` -> add `lighterm-plugin-<plugin-name> = { path = "../crates/plugins/<plugin-name>" }` under `[dependencies]`.

Then register the plugin in `src-tauri/src/lib.rs` inside `run()` before `.manage(AppState { ... })`:
```rust
core.register_plugin(Arc::new(MyPlugin::new()))
    .expect("Failed to register My plugin");
```

---

## 2. `CorePlugin` Trait & `PluginRegistry` (`crates/lighterm-core/src/plugin.rs`)

```rust
pub struct CoreContext {
    pub storage: Arc<Storage>,
    pub ssh_pool: Arc<SshConnectionPool>,
    pub sessions: Arc<SessionManager>,
}

pub trait CorePlugin: Send + Sync + 'static {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn version(&self) -> &'static str { "1.0.0" }
    fn description(&self) -> &'static str;
    fn dependencies(&self) -> &'static [&'static str] { &[] }
    fn always_on(&self) -> bool { false }

    fn on_activate(&self, _ctx: &CoreContext) -> CoreResult<()> { Ok(()) }
    fn on_deactivate(&self) -> CoreResult<()> { Ok(()) }

    /// Called automatically whenever `hosts_save` or `hosts_delete` runs.
    fn on_host_invalidated(&self, _host_id: &str) {}

    fn as_any_arc(self: Arc<Self>) -> Arc<dyn Any + Send + Sync>;
}
```

### Registry Validation & Lifecycle Rules
- **`id()` validation**: Enforced by `is_valid_plugin_id(id)` -> lowercase dot-separated segments (`[a-z0-9][a-z0-9_-]*` per segment, at least 2 segments). `name()` and `version()` must be non-empty.
- **Persistence of enable state**: Stored in `<data_dir>/plugins.json`. Unless `always_on() == true`, disabled plugins stay inactive across restarts and cannot be retrieved via `get_active`.
- **`always_on()`**: When `true`, `PluginRegistry::register` forces `enabled = true` and `PluginRegistry::set_enabled(..., false, ...)` ignores disable requests. **Must match frontend `PluginDefinition.alwaysOn`**.
- **Dependencies**: If any ID in `dependencies()` is inactive at registration time, the plugin stays pending and auto-activates when dependencies activate (`reconcile_activations`). Disabling a dependency recursively deactivates dependents (`deactivate_with_dependents`).
- **`on_host_invalidated(host_id)`**: `hosts_save` and `hosts_delete` call `core.plugins.notify_host_invalidated(&id)` across all active plugins. Plugins holding cached SSH/SFTP channels or per-host state must evict `host_id` here instead of requiring core commands to downcast specific plugins.

---

## 3. Core Services Available in `CoreContext`

### A. Plugin Data Persistence (`ctx.storage: Arc<Storage>`)
Use `Storage` (`crates/lighterm-core/src/storage.rs`) for domain JSON files stored inside `data_dir` (`<config_dir>/lighterm`):

- `storage.has_plugin_file(name: &str) -> bool` — check before seeding default records on first activation.
- `storage.read_plugin_json<T: DeserializeOwned + Default>(name: &str) -> CoreResult<T>` — thread-safe mutex-locked read, returns `T::default()` if file is missing or empty.
- `storage.write_plugin_json<T: Serialize>(name: &str, value: &T, restricted: bool) -> CoreResult<()>` — atomic write-to-`.tmp` + rename. Set `restricted = true` for secrets/credentials so Unix writes mode `0o600`.

> Do not invent custom config persistence commands if you only need user settings toggles/numbers/strings. The frontend `usePluginConfig` / `ctx.updateConfig` automatically uses the kernel's `plugin-configs.json` (`plugin_configs_get_all`, `plugin_config_get`, `plugin_config_save`, `plugin_config_reset`).

### B. Pooled SSH2 Connections (`ctx.ssh_pool: Arc<SshConnectionPool>`)
Use `SshConnectionPool` (`crates/lighterm-core/src/ssh.rs`) when your plugin runs remote SSH/SFTP/exec operations against a `HostConfig`:

```rust
let handle = pool.get_or_connect(host).await?;
let channel = match handle.channel_open_session().await {
    Ok(ch) => ch,
    Err(_) => {
        // Handle went stale: evict cached connection and reconnect once
        pool.invalidate(&host.id);
        let fresh = pool.get_or_connect(host).await?;
        fresh
            .channel_open_session()
            .await
            .map_err(|e| CoreError::PluginError(format!("Failed to open SSH channel: {e}")))?
    }
};
```

> **Windows / MSVC OpenSSL Note**: Avoid crates depending on `openssl-sys` or native C TLS bindings that require external OpenSSL toolchains on Windows. Follow `crates/plugins/*` (`russh`, `russh-sftp`, `sysinfo`, `tokio`, `chrono`, `parking_lot`).

---

## 4. `CoreError` Variants (`crates/lighterm-core/src/error.rs`)

`CoreError` serializes directly as `{ "code": "...", "message": "...", "detail"?: ... }` across Tauri IPC:
- `CoreError::PtyError(String)` -> `"PTY_ERROR"`
- `CoreError::SshError(String)` -> `"SSH_ERROR"`
- `CoreError::AuthFailed(String)` -> `"AUTH_FAILED"`
- `CoreError::StorageError(String)` -> `"STORAGE_ERROR"`
- `CoreError::SessionNotFound(String)` -> `"SESSION_NOT_FOUND"`
- `CoreError::InvalidInput(String)` -> `"INVALID_INPUT"`
- `CoreError::PluginDisabled(String)` -> `"PLUGIN_DISABLED"`
- `CoreError::PluginError(String)` -> `"PLUGIN_ERROR"`

Always store optional `Arc<Storage>` / `Arc<SshConnectionPool>` inside `RwLock<Option<...>>` on your plugin struct, populate it in `on_activate`, clear it in `on_deactivate`, and return `CoreError::PluginDisabled(id)` when `None`.

---

## 5. Exposing Tauri Commands & Streaming Events (`src-tauri/`)

### Command Handler Pattern (`src-tauri/src/commands.rs`)

1. **Always enforce activation guard** at the top of every plugin command:
   ```rust
   let plugin = state
       .core
       .plugins
       .get_active::<MyPlugin>("acme.my-plugin")?;
   ```
   If disabled, `get_active` immediately returns `CoreError::PluginDisabled`.
2. **Resolve hosts via helper**: `let host = resolve_host(&state, &host_id)?;` searches `hosts.json`.
3. **Offload blocking sync work**: Wrap blocking file/CPU/sysinfo work in `run_blocking(CoreError::PluginError, move || ...)`. Async SSH network I/O stays directly `async` with `.await`.
4. **DTO serialization**: Annotate request/response structs with `#[derive(Debug, Clone, Serialize, Deserialize)]` and `#[serde(rename_all = "camelCase")]`.
5. **Argument naming across Tauri v2 IPC**: Tauri v2 automatically converts Rust `snake_case` command parameter names to `camelCase` on the JS side! Example: `host_id: String` in Rust expects `invokeTauri('my_plugin_cmd', { hostId })` in TypeScript.
6. **Register commands**: Add every new `#[tauri::command]` path to `tauri::generate_handler![...]` in `src-tauri/src/lib.rs`.

### Pushing Real-Time Events from Rust to Frontend
Use `CoreEventSink` via `sink_for(&app)` (`sink.on_plugin_event("acme:progress", serde_json::to_value(payload)?)`) or emit directly via `app.emit("acme:progress", payload)`. Always use `<plugin>:<event>` naming.
