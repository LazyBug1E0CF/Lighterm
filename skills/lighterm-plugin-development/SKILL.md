---
name: lighterm-plugin-development
description: >-
  Guides AI coding agents through designing, implementing, wiring, and testing
  frontend and full-stack Rust + Tauri v2 plugins for the Lighterm terminal and
  SSH/SFTP workbench. Use when the user asks to create, scaffold, modify, debug,
  or review a Lighterm plugin, GUI viewport, Settings page, UI slot, Command
  Palette action, or Rust CorePlugin backend crate.
---

# Lighterm Plugin Development

Lighterm uses a Cordis-inspired **everything-is-a-plugin** microkernel spanning a React 19 / TypeScript frontend (`src/harness/`) and an async Rust / Tauri v2 backend (`crates/lighterm-core/`).

---

## Core Architectural Rules (Read Before Editing)

1. **Zero Hardcoding in Core or Layout**: Never hardcode plugin IDs or viewport `typeId` strings in `src/core/`, `src/layout/`, or core Tauri commands (`hosts_save`, `hosts_delete` broadcast `CorePlugin::on_host_invalidated` automatically). Only wire plugins in `src/plugins/index.ts`, `Cargo.toml`, `src-tauri/Cargo.toml`, `src-tauri/src/commands.rs`, and `src-tauri/src/lib.rs`.
2. **Reserved `core:*` Services**: Never call `ctx.provide('core:*', ...)`. `'core:shell'` and `'core:layout'` are reserved by `HarnessKernel` and throw at runtime.
3. **Tick-0 Synchronous Registration**: Inside `activate(ctx)`, call `ctx.provide`, `ctx.registerViewport`, `ctx.registerSettingsPage`, `ctx.registerSlot`, and `ctx.registerCommand` **synchronously before any `await`** so initial UI chrome and startup drawers populate on frame 0.
4. **Reversible `EffectScope` Cleanup**: Register disposers via `ctx.onCleanup(...)` for all `window` event listeners, timers, `shell.on*` / `listenTauri` subscriptions, and dynamic command lists so disabling/re-enabling a plugin leaves zero leaks.
5. **Dual-Runtime Support**: Plugins run both inside Tauri desktop (`isTauriRuntime() === true`) and browser preview / Vitest (`isTauriRuntime() === false`). Every IPC client must provide a mock or `localStorage` (`readLs` / `writeLs`) fallback when `!isTauriRuntime()`.
6. **Theme Variables & Drag Isolation**: Style exclusively with Lighterm CSS variables (`--bg-app`, `--bg-surface`, `--bg-elevated`, `--border-subtle`, `--text-primary`, `--text-muted`, `--accent`, `--success`, `--warning`, `--danger`). Never hardcode fixed hex colors. On interactive controls inside draggable cards/headers, call `e.stopPropagation()` on `onPointerDown` or add `data-no-drag="true"`.

---

## Step 1: Decide Plugin Scope, Lifecycle & Viewport Position

Before writing code, classify the plugin along four axes:

| Decision | Options | Where It Applies |
| --- | --- | --- |
| **Runtime stack** | Frontend-only (`src/plugins/<name>/`) vs. Full-stack (`+ crates/plugins/<name>/` & `src-tauri/`) | Need native PTY/SSH/FS/SQLite/OS telemetry -> add Rust crate |
| **Activation tier** | Optional toggleable (`alwaysOn: false`, default) vs. Core permanent (`alwaysOn: true`) | `alwaysOn: false` Settings appear in **Plugins** section; `alwaysOn: true` cannot be disabled and its Settings appear in **General** section |
| **GUI Viewport** | Headless (no viewport) vs. `ctx.registerViewport(...)` | Required `defaultPosition` sets startup placement, `toggleSingletonViewport`, `openPluginViewport`, and `Reset Layout` |
| **Persistence** | Settings metadata (`ctx.getConfig` / `usePluginConfig`) vs. Domain lists/records (`Storage::read_plugin_json` / `write_plugin_json`) | Generic plugin settings are automatically persisted to `plugin-configs.json` + `localStorage` by the kernel |

> **Full-stack Parity Rule**: If a plugin has both a Rust `CorePlugin` and a frontend `PluginDefinition`, `PluginDefinition.id` **must equal** `CorePlugin::id()`, and `Boolean(PluginDefinition.alwaysOn)` **must equal** `CorePlugin::always_on()`.

### Standard `defaultPosition` Values (`ViewportPosition`)

| `defaultPosition` | Host Area | Best For |
| --- | --- | --- |
| `'left-drawer'` | Left collapsible drawer + Activity Rail | Navigators, directories, snippets, history panels |
| `'right-drawer'` | Right collapsible drawer + Activity Rail | Telemetry monitors, inspectors, assistants |
| `'bottom'` | Horizontal split below workspace | SFTP file browser, log tailers, transfer queues |
| `'top'` | Horizontal split above workspace | Top toolbars or summary strips |
| `'left'` | Vertical split left of main area | Persistent side-by-side workspace panes |
| `'right'` | Vertical split right of main area | Side-by-side previews or debuggers |
| `'center'` | Main workspace center tab group | Terminal viewports or primary interactive documents |
| `'float'` | Movable, 8-edge resizable floating window | Scratchpads, calculators, pop-out utilities |

- Set `singleton: true` for utility panels (clicking toggles/focuses the single instance) or `singleton: false` for multi-instance tabs.
- Set `openOnStartup: true` (with `singleton: true`) if the viewport should mount automatically on clean boot and when dynamically enabled from Plugin Manager (`Ctrl+Shift+X`).
- For drawer viewports with `openOnStartup: true`, set `activateOnStartup: true` only if it should be the initially focused tab in that drawer.

---

## Step 2: Follow Identifier Naming Contracts

| Identifier | Rule / Pattern | Example |
| --- | --- | --- |
| `plugin.id` | `/^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/` | `acme.port-forward`, `lighterm.sftp` |
| `viewport.typeId` | `<namespace>.<viewport>` (globally unique across plugins) | `port-forward.panel`, `sftp.browser` |
| `serviceName` | `<namespace>:<service>` (never `core:*`) | `acme:tunnel-api`, `terminal:service` |
| `settingsPage.id` | Short lowercase ID (keyed as `${pluginId}:${id}`) | `general`, `port-forward` |
| `command.id` | `<namespace>:<action>` | `port-forward:toggle` |
| `slot.id` | `<plugin>-<purpose>` | `port-forward-statusbar-btn` |
| Tauri command | `<plugin>_<action>` (`snake_case`) | `port_forward_list` |
| Tauri event | `<plugin>:<event>` | `port-forward:status` |
| Rust crate name | `lighterm-plugin-<name>` in `crates/plugins/<name>/` | `lighterm-plugin-sftp` |

---

## Step 3: Implement & Wire the Frontend Plugin (`src/plugins/<name>/`)

Create `src/plugins/<name>/` with clean separation:
- `index.tsx` — exports `<name>Plugin = definePlugin({ ... })` and exported `*_VIEWPORT_TYPE` / `DEFAULT_*_CONFIG` constants.
- `<Name>Viewport.tsx` — React component accepting `ViewportComponentProps` (if the plugin has a GUI viewport).
- `<Name>SettingsPage.tsx` — React component accepting `PluginSettingsPageProps` (if configurable).
- `<name>Client.ts` — domain Zustand store, module-level `DEFAULT_*_CONFIG`, Tauri IPC + browser fallback helpers, and `resetForTesting()`.

### Key Frontend APIs
1. **Define Plugin**: Wrap exported definition in `definePlugin({ id, name, version, description, icon, author, inject, provides, defaultEnabled, alwaysOn, activate(ctx) { ... } })`.
2. **Inject Core Services**: `const shell = ctx.inject('core:shell');` and `const layout = ctx.inject('core:layout');` (`LightermServiceMap` provides full type inference automatically).
3. **Register GUI Viewport(s)**: Call `ctx.registerViewport({ typeId, title, icon, defaultPosition, defaultDockRatio?, defaultFloatSize?, singleton, openOnStartup?, activateOnStartup?, order, component, onClose? })`. A single plugin may register **multiple viewports** with distinct `typeId`s, content components, and `defaultPosition`s (or different runtime display modes simultaneously). Use `layout.toggleSingletonViewport({ typeId })` or `layout.openPluginViewport(typeId)` to open/focus a viewport, and use `layout.startTearOffDrag(...)` / `layout.detachToViewport(...)` when internal sub-cards can be torn out into independent drawer, docked, or floating viewports (as `lighterm.monitor` does for `monitor.processes`, etc.).
4. **Register Settings UI**: Call `ctx.registerSettingsPage({ id, title, description?, icon?, order, mountTo?, defaultExpanded?, component })`. Omit `mountTo` for a standalone Settings tab (placed in **General** if `alwaysOn: true`, or **Plugins** otherwise); set `mountTo` (e.g., `'lighterm.terminal:terminal'`, `'appearance'`, or `'shortcuts'`) to append it as a collapsible panel inside an existing Settings page. Use `order >= 60` for new extensions (built-ins use `10`–`50`). Never use the deprecated `'settings:tabs'` slot.
5. **Read & Persist Config**:
   - Declare `export const DEFAULT_<NAME>_CONFIG = { ... } as const;` at **module top level** (never inline inside a component render, or `useSyncExternalStore` loops).
   - Inside React components: `const { config, updateConfig, resetConfig } = usePluginConfig(pluginId, DEFAULT_<NAME>_CONFIG);`
   - Outside React (`activate` / client services): `ctx.getConfig(DEFAULT_<NAME>_CONFIG)` / `await ctx.updateConfig(patch)`.
6. **Wire into `src/plugins/index.ts`**:
   - Import `<name>Plugin` and pass it to `kernel.register(<name>Plugin)` inside `registerBuiltinPlugins`.
   - Re-export `<name>Plugin` if needed externally.
   - If the plugin maintains a standalone store or service with module state, reset it inside `resetLightermHarnessForTesting()`.

Detailed APIs and examples:
- [Frontend Harness & Layout Reference](./references/frontend-harness-and-layout.md)
- [Frontend-Only Plugin Example](./examples/frontend-only-plugin.md)

---

## Step 4: Add a Rust Backend Crate & Tauri Commands (Full-Stack Only)

Skip this step if the plugin is purely frontend UI or only orchestrates existing core sessions/services.

1. **Create `crates/plugins/<name>/Cargo.toml`** depending on `lighterm-core = { path = "../../lighterm-core" }`, `parking_lot`, `serde` (`derive`), plus domain crates.
2. **Implement `CorePlugin` in `crates/plugins/<name>/src/lib.rs`**:
   - Implement `id()`, `name()`, `version()`, `description()`, `dependencies()`, `always_on()`, `on_activate(ctx)`, `on_deactivate()`, `on_host_invalidated(host_id)`, and `as_any_arc`.
   - Persist plugin-specific data via `ctx.storage.has_plugin_file`, `read_plugin_json`, and `write_plugin_json` (pass `restricted = true` if sensitive -> `0600` on Unix). Never bypass `plugin-configs.json` for generic user settings.
   - Guard plugin domain methods against deactivated state by returning `CoreError::PluginDisabled("<plugin.id>".to_string())` if internal `Arc<Storage>` / `Arc<SshConnectionPool>` handle is `None`.
3. **Register Crate & Tauri Commands**:
   - Add `"crates/plugins/<name>"` to `[workspace].members` in root `Cargo.toml`.
   - Add `lighterm-plugin-<name> = { path = "../crates/plugins/<name>" }` to `src-tauri/Cargo.toml`.
   - Add `#[tauri::command]` handlers in `src-tauri/src/commands.rs`, **always fetching the plugin via `state.core.plugins.get_active::<MyPlugin>("<plugin.id>")?`** and offloading sync/blocking I/O with `run_blocking(...)`.
   - Call `core.register_plugin(Arc::new(MyPlugin::new()))` and add commands to `tauri::generate_handler![...]` in `src-tauri/src/lib.rs`.

Detailed Rust & IPC patterns:
- [Rust Backend & Tauri IPC Reference](./references/rust-backend-and-tauri-ipc.md)
- [Full-Stack Plugin Walkthrough](./examples/fullstack-plugin-walkthrough.md)

---

## Step 5: Test & Verify Before Finishing

Add both unit/integration coverage and run the repository verification suite:

1. **Frontend Tests**: Add a Vitest + React Testing Library spec in `src/__tests__/` covering:
   - `defaultPosition` mounting (`left-drawer`, `right-drawer`, `bottom`, `float`, etc.) and `layoutService.resetLayoutPreservingViewports()`.
   - Settings placement (`General Settings` if `alwaysOn: true`, `Plugin Settings` if optional), `usePluginConfig` updates/reset, and clean `disablePlugin` / `enablePlugin` cycling.
2. **Backend Tests (Full-Stack Only)**: Add `#[cfg(test)]` tests using `tempfile::tempdir()` and `LightermCore::with_data_dir(...)` verifying activation, domain CRUD/behavior, `on_host_invalidated`, and `get_active` rejection when disabled.
3. **Run All Checks**:
   - `pnpm exec tsc --noEmit` (Windows PowerShell with restricted `.ps1` execution policy: use `pnpm.cmd exec tsc --noEmit`)
   - `pnpm test --run` (`pnpm.cmd test --run` on PowerShell)
   - `pnpm run build` (`pnpm.cmd run build` on PowerShell)
   - `cargo test --workspace` (if any Rust code or `src-tauri/` was touched; run standalone to ensure compilation)

Detailed test recipes and common pitfall fixes:
- [Testing & Troubleshooting Guide](./references/testing-and-troubleshooting.md)

### Pre-Completion Checklist
- [ ] `plugin.id` matches `<namespace>.<name>` lowercase regex (and matches Rust `CorePlugin::id()` + `alwaysOn` if full-stack).
- [ ] Zero plugin-specific hardcoding inside `src/core/`, `src/layout/`, or core Tauri commands.
- [ ] No `'core:*'` services provided; `viewport.typeId` is unique.
- [ ] All viewports explicitly declare `defaultPosition`; interactive controls inside headers/cards stop drag propagation.
- [ ] Settings UI registered with `ctx.registerSettingsPage` (`order >= 60` for new extensions; optional `mountTo` for collapsible panel inside a host page) and module-level `DEFAULT_*_CONFIG`.
- [ ] All listeners/timers/dynamic commands disposed in `ctx.onCleanup`; singleton state reset in `resetLightermHarnessForTesting()`.
- [ ] `tsc --noEmit`, `vitest`, `vite build`, and (when Rust touched) `cargo test --workspace` all pass cleanly.
