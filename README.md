# Lighterm

A lightweight, cross-platform GUI terminal emulator and SSH/SFTP workbench built with **Tauri v2**, **Rust**, **React 19**, **TypeScript**, **Tailwind CSS v4**, and **xterm.js**, structured around an **everything-is-a-plugin** kernel inspired by **Cordis**.

## Architecture

### Minimal Core (`crates/lighterm-core` & `src/core/`, `src/kernel/`, `src/layout/`)
The core contains **only**:
- **Shell Connections**: Local PTY (`portable-pty`) and async SSH2 (`russh`) connection pooling & active shell `SessionManager`
- **Persistence & Config**: Atomic JSON persistence (`hosts.json` with `0600` Unix permissions, `settings.json`, `plugins.json`, and generic plugin JSON storage)
- **Plugin Kernel**:
  - Rust: `CorePlugin` trait (`id`, `name`, `version`, `dependencies`, `on_activate`, `on_deactivate`, `on_host_invalidated`) & `PluginRegistry` (`crates/lighterm-core/src/plugin.rs`) with ID namespace validation, dependency verification, and cascading activation/deactivation
  - Frontend: Cordis-inspired `PluginKernel` (`src/kernel/`) with `definePlugin`, `inject` / `provide`, `EffectScope` reversible cleanup, declarative viewport default positioning (`defaultPosition`: `left-drawer`, `right-drawer`, `bottom`, `top`, `left`, `right`, `center`, `float`), Settings `General`/`Plugins` sections & mountable collapsible Settings panels (`ctx.registerSettingsPage` with optional `mountTo`), standardized `PluginConfig` persistence (`plugin-configs.json` + `localStorage`), and live runtime toggling via **Plugin Manager** (`Ctrl+Shift+X`)
- **Plugin Development Specification**: See [`docs/PLUGIN_DEVELOPMENT.md`](docs/PLUGIN_DEVELOPMENT.md) for the complete frontend/backend plugin contract, viewport layout guidelines, and Settings integration spec.
- **AI Agent Skill (`skills/`)**: Install [`skills/lighterm-plugin-development`](skills/lighterm-plugin-development/SKILL.md) into any compatible AI coding agent (Claude Code, Cursor, Codex, Antigravity, Gemini CLI, etc.) — see [`skills/README.md`](skills/README.md) for setup instructions.
- **Universal Viewport Layout Engine (`src/layout/`)**:
  - Unified recursive `DockNode` split/tab tree + `FloatingViewportLayer`
  - Every plugin viewport can be dragged by its tab/header, snapped to any outer workspace edge (`Left`, `Right`, `Top`, `Bottom`), split/merged into any docked panel via the 5-zone Dock Compass HUD, undocked into a free-floating window, and resized via split sashes or 8-direction floating window handles

### Built-in Plugins (`crates/plugins/*` & `src/plugins/*`)
All higher-level features are implemented as independent, hot-toggleable plugins:
- **`lighterm.terminal`** (`src/plugins/terminal`): `xterm.js` + WebGL terminal viewports, split/tab management, find-in-output, and Terminal Settings tab
- **`lighterm.hosts`** (`src/plugins/hosts`): Saved SSH host manager viewport & extensible `host:actions` slot
- **`lighterm.sftp`** (`crates/plugins/sftp`, `src/plugins/sftp`): Multiplexed SFTP directory browser & chunked upload/download viewport
- **`lighterm.monitor`** (`crates/plugins/monitor`, `src/plugins/monitor`): Real-time local & remote SSH CPU, memory, network, disk, and process telemetry with tear-off modular viewports (`monitor.panel`, `monitor.host`, `monitor.cpu`, `monitor.memory`, `monitor.network`, `monitor.disks`, `monitor.processes`) that can be dragged into independent drawer, split, or floating viewports
- **`lighterm.snippets`** (`crates/plugins/snippets`, `src/plugins/snippets`): Reusable command templates with `{{variable}}` prompts
- **`lighterm.history`** (`crates/plugins/history`, `src/plugins/history`): Searchable deduplicated command history subscribed directly to `core:shell` I/O streams
- **`lighterm.sync`** (`crates/plugins/sync`, `src/plugins/sync`): Cross-device GitHub configuration sync via OAuth Device Flow using Lighterm's built-in OAuth App Client ID out of the box (overridable via `LIGHTERM_GITHUB_CLIENT_ID` or Optional & Advanced Settings), defaulting to an auto-managed Secret Gist with optional Private Repository and AES-256-GCM end-to-end encryption

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

# Build custom Obsidian Spotlight Windows installer (Windows x64)
pnpm run build:installer
```

### Linux (Debian / Ubuntu / Deepin 25) System Dependencies for Tauri

```bash
sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev libxdo-dev librsvg2-dev libayatana-appindicator3-dev
```

## Web App & Docker Deployment

Lighterm also ships a standalone Rust web backend (`crates/lighterm-server`) serving the React workbench over HTTP + WebSocket, with full support for local PTY shells, remote SSH/SFTP, real-time monitoring, snippets, history, and GitHub Config Sync.

### Quick Start with Docker

```bash
# Build image
docker build -t lighterm-web:latest .

# Run container (persistent data in named volume, protected by password)
docker run -d \
  --name lighterm-web \
  -p 8080:8080 \
  -e LIGHTERM_AUTH_PASSWORD="your-strong-password" \
  -v lighterm-data:/data \
  lighterm-web:latest
```

Or using Docker Compose:

```bash
LIGHTERM_AUTH_PASSWORD="your-strong-password" docker compose up -d
```

Open `http://localhost:8080` in your browser.

### Server Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `LIGHTERM_BIND` | `0.0.0.0:8080` | Bind address (`host:port`). Falls back to `0.0.0.0:${PORT:-8080}`. |
| `LIGHTERM_DATA_DIR` | OS config dir (`/data` in Docker) | Persistent storage directory for `hosts.json`, `settings.json`, `workspaces.json`, `plugins.json`, etc. |
| `LIGHTERM_STATIC_DIR` | `dist` (or `/app/dist`) | Directory containing the built Vite frontend bundle. |
| `LIGHTERM_AUTH_PASSWORD` | _(unset)_ | Enables Web UI login gate & session cookies (`HttpOnly`, `SameSite=Lax`). **Strongly recommended** when exposed on a network. |
| `LIGHTERM_AUTH_USER` | _(unset)_ | Optional username required alongside `LIGHTERM_AUTH_PASSWORD`. |
| `LIGHTERM_SESSION_TTL_SECS` | `86400` | Web auth session lifetime in seconds. |
| `LIGHTERM_COOKIE_SECURE` | `auto` | `auto` (sets `Secure` when `X-Forwarded-Proto: https`), `always`, or `never`. |
| `PUID` / `PGID` | `1000` / `1000` | Target UID/GID used inside the container. On startup, the entrypoint automatically aligns `/data` ownership for NAS bind mounts before dropping privileges via `gosu`. |
| `LIGHTERM_GITHUB_CLIENT_ID` | _(built-in)_ | Optional GitHub OAuth App Client ID override for `lighterm.sync`. |
| `RUST_LOG` | `info` | Server logging filter (`tracing_subscriber`). |

> **Web App Local Shell Setting**: In Web App mode, local server/container PTY shells are **disabled by default** so deployments act as an SSH/SFTP gateway out of the box. You can toggle **Allow Local Shell** at any time under **Settings → Web App** (persisted in `/data/web-settings.json`).

### Reverse Proxy (Nginx WebSocket Example)

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 0;
}
```

### Local Web Development

```bash
# Terminal 1: Start the Rust web backend
cargo run -p lighterm-server

# Terminal 2: Start Vite in web mode (proxies /api and /ws to 127.0.0.1:8080)
pnpm run dev:web
```

## License

Lighterm is licensed under the [MIT License](LICENSE).
