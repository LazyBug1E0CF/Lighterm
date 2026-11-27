# Lighterm Project Rules

## Git Workflow

- Whenever the user asks to commit changes (e.g., "提交", "commit"), always run `git push` to push the current branch to the remote repository immediately after creating the commit, unless the user explicitly asks to keep the commit local only.

## Release Workflow

- Whenever the user asks to release a new version (e.g., "发版", "发布新版本 X.Y.Z"), the release MUST include **both** the Desktop app and the Web App:
  1. Bump the version across all 6 manifests (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `crates/lighterm-core/Cargo.toml`, `crates/lighterm-server/Cargo.toml`, `crates/lighterm-installer/Cargo.toml`).
  2. Run frontend build/tests (`npm run build && npx vitest run`) and Rust tests (`lighterm-core`, `lighterm-server`, `lighterm-installer`).
  3. Build the Windows x64 installer and `.sha256` (`node scripts/build-installer.mjs`).
  4. Commit, tag `vX.Y.Z`, and push both `main` and `vX.Y.Z` to `origin`. Pushing tag `vX.Y.Z` automatically triggers `.github/workflows/docker-publish.yml` to build and publish multi-arch (`linux/amd64`, `linux/arm64`) Web App Docker images to **GHCR** (`ghcr.io/lazybug1e0cf/lighterm:X.Y.Z` & `:latest`) and **Docker Hub** (`lmmmd/lighterm:X.Y.Z` & `:latest`).
  5. Publish GitHub Release `vX.Y.Z` with the Windows installer + `.sha256` and include the Web App Docker image tags (`ghcr.io/lazybug1e0cf/lighterm:X.Y.Z` and `lmmmd/lighterm:X.Y.Z`) in the release notes.
  6. Verify the `Publish Web Docker Image` GitHub Actions workflow run starts/succeeds and report the run URL alongside the GitHub Release URL.
