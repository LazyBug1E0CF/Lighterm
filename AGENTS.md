# Lighterm Project Rules

## Git Workflow

- Whenever the user asks to commit changes (e.g., "提交", "commit"), always run `git push` to push the current branch to the remote repository immediately after creating the commit, unless the user explicitly asks to keep the commit local only.

## Release Workflow

- Whenever the user asks to release a new version (e.g., "发版", "发布新版本 X.Y.Z"), the release MUST include **both** the Desktop app and the Web App via CI:
  1. Bump the version across all 6 manifests (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `crates/lighterm-core/Cargo.toml`, `crates/lighterm-server/Cargo.toml`, `crates/lighterm-installer/Cargo.toml`).
  2. Run frontend build/tests (`pnpm run build && pnpm test --run`) and Rust tests (`cargo test --workspace` when available locally).
  3. Commit, tag `vX.Y.Z`, and push both `main` and `vX.Y.Z` to `origin`. Do NOT build installers or run `gh release create` locally.
  4. Pushing tag `vX.Y.Z` automatically triggers `.github/workflows/release.yml` (`Release`), which builds and publishes:
     - **Windows x64** custom installer (`Lighterm-Setup-X.Y.Z-x64.exe` + `.sha256`)
     - **Linux (`amd64` & `arm64`)** desktop packages (`.deb`, `.rpm`, `.AppImage` + `.sha256`)
     - **Web App** multi-arch (`linux/amd64`, `linux/arm64`) Docker images to **GHCR** (`ghcr.io/lazybug1e0cf/lighterm:X.Y.Z` & `:latest`) and **Docker Hub** (`lmmmd/lighterm:X.Y.Z` & `:latest`), plus `lighterm-web-X.Y.Z-linux-{amd64,arm64}.tar.gz` (+ `.sha256`) self-update bundles
     - **GitHub Release `vX.Y.Z`** created/updated automatically with all build artifacts and SHA-256 checksums.
  5. Verify the `Release` GitHub Actions workflow run starts/succeeds and report both the workflow run URL and the GitHub Release URL.
