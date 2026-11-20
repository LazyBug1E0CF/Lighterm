# Lighterm

A lightweight, cross-platform GUI terminal emulator and SSH/SFTP workbench built with **Tauri v2**, **Rust**, **React 19**, **TypeScript**, **Tailwind CSS v4**, and **xterm.js**, structured around an **everything-is-a-plugin** kernel inspired by `deepseek-harness` (**Cordis**).

## Architecture

### Minimal Core (`crates/lighterm-core` & `src/core/`, `src/harness/`, `src/layout/`)
The core contains **only**:
- **Shell Connections**: Local PTY (`portable-pty`) and async SSH2 (`russh`) connection pooling & active shell `SessionManager`
- **Persistence & Config**: Atomic JSON persistence (`hosts.json` with `0600` Unix permissions, `settings.json`, `plugins.json`, and generic plugin JSON storage)
- **Plugin Kernel**:
  - Rust: `CorePlugin` trait & `PluginRegistry` (`crates/lighterm-core/src/plugin.rs`) with explicit dependency verification and cascading activation/deactivation
  - Frontend: Cordis-inspired `HarnessKernel` (`src/harness/HarnessKernel.ts`) with `inject` / `provide`, `EffectScope` reversible cleanup, slot registration, and live runtime toggling via **Plugin Manager** (`Ctrl+Shift+X`)
- **Universal Viewport Layout Engine (`src/layout/`)**:
  - Unified recursive `DockNode` split/tab tree + `FloatingViewportLayer`
  - Every plugin viewport can be dragged by its tab/header, snapped to any outer workspace edge (`Left`, `Right`, `Top`, `Bottom`), split/merged into any docked panel via the 5-zone Dock Compass HUD, undocked into a free-floating window, and resized via split sashes or 8-direction floating window handles

### Built-in Plugins (`crates/plugins/*` & `src/plugins/*`)
All higher-level features are implemented as independent, hot-toggleable plugins:
- **`lighterm.terminal`** (`src/plugins/terminal`): `xterm.js` + WebGL terminal viewports, split/tab management, find-in-output, and Terminal Settings tab
- **`lighterm.hosts`** (`src/plugins/hosts`): Saved SSH host manager viewport & extensible `host:actions` slot
- **`lighterm.sftp`** (`crates/plugins/sftp`, `src/plugins/sftp`): Multiplexed SFTP directory browser & chunked upload/download viewport
- **`lighterm.monitor`** (`crates/plugins/monitor`, `src/plugins/monitor`): Real-time local & remote SSH CPU, memory, network, disk, and process telemetry viewport
- **`lighterm.snippets`** (`crates/plugins/snippets`, `src/plugins/snippets`): Reusable command templates with `{{variable}}` prompts
- **`lighterm.history`** (`crates/plugins/history`, `src/plugins/history`): Searchable deduplicated command history subscribed directly to `core:shell` I/O streams

## Development & Verification

```bash
# Install frontend dependencies
pnpm install

# Run all Rust workspace tests (core + 4 plugin crates)
cargo test --workspace

# Type-check & run frontend unit/integration tests
pnpm exec tsc --noEmit
pnpm test --run

# Build frontend bundle
pnpm run build

# Run Tauri desktop app in dev mode / build desktop bundle
pnpm tauri dev
pnpm tauri build
```

### Linux (Debian / Ubuntu / Deepin 25) System Dependencies for Tauri

```bash
sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev libxdo-dev librsvg2-dev libayatana-appindicator3-dev
```
