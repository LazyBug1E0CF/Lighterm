# Lighterm

A lightweight, cross-platform GUI terminal emulator and SSH/SFTP manager built with **Tauri v2**, **Rust**, **React 19**, **TypeScript**, **Tailwind CSS v4**, and **xterm.js**.

## Architecture

- **`crates/lighterm-core`**: Pure Rust core engine (zero GTK/WebView dependencies)
  - Local PTY sessions via `portable-pty` (`bash` / `zsh` / `sh` / `powershell.exe` / `cmd`)
  - Pure-Rust async SSH2 client via `russh` (`ring` crypto backend) supporting password, private key file, inline PEM, and passphrase authentication
  - Multiplexed SFTP client via `russh-sftp` supporting directory navigation, creation, renaming, deletion, and chunked uploads/downloads with progress events
  - Atomic JSON persistence (`hosts.json` with `0600` Unix permissions, `snippets.json`, `history.json`, `settings.json`)
- **`src-tauri`**: Thin Tauri v2 desktop wrapper bridging `lighterm-core` to IPC commands and window events
- **`src/`**: React + Zustand + `xterm.js` UI featuring multi-tab & recursive horizontal/vertical split panes, SSH host manager, SFTP browser drawer, snippets with `{{variable}}` prompts, searchable command history, `Ctrl+Shift+P` command palette, 6 color themes, opacity control, and interactive shortcut customization.

## Development & Verification

```bash
# Install frontend dependencies
pnpm install

# Run Rust core unit & integration tests (PTY, Storage, embedded SSH server)
cargo test -p lighterm-core

# Type-check & run frontend unit/component tests
pnpm tsc --noEmit
pnpm test --run

# Build frontend bundle
pnpm build

# Run Tauri desktop app in dev mode / build desktop bundle
pnpm tauri dev
pnpm tauri build
```

### Linux (Debian / Ubuntu / Deepin 25) System Dependencies for Tauri

```bash
sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev libxdo-dev librsvg2-dev libayatana-appindicator3-dev
```
