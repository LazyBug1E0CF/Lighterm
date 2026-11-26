use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const APP_NAME: &str = "Lighterm";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const APP_EXE_NAME: &str = "lighterm.exe";
pub const UNINSTALL_EXE_NAME: &str = "uninstall.exe";
pub const MANIFEST_FILE_NAME: &str = "install-manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    pub install_dir: String,
    pub desktop_shortcut: bool,
    pub start_menu_shortcut: bool,
    pub add_to_path: bool,
    pub context_menu: bool,
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            install_dir: default_install_dir().to_string_lossy().into_owned(),
            desktop_shortcut: true,
            start_menu_shortcut: true,
            add_to_path: false,
            context_menu: false,
        }
    }
}

/// Returns `%LOCALAPPDATA%\Programs\Lighterm` (or a safe fallback when unavailable).
pub fn default_install_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(r"C:\Users\Public"));
    base.join("Programs").join(APP_NAME)
}

/// Ensures user-selected installation folders always terminate in a dedicated `Lighterm` directory
/// so uninstall cleanup never removes a shared parent folder.
pub fn normalize_browse_folder(picked: &Path) -> PathBuf {
    let is_lighterm = picked
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(APP_NAME));
    if is_lighterm {
        picked.to_path_buf()
    } else {
        picked.join(APP_NAME)
    }
}

fn normalize_path_entry(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"');
    let without_trailing = trimmed.trim_end_matches(['\\', '/']);
    without_trailing.to_ascii_lowercase()
}

/// Appends `dir` to a semicolon-separated Windows `PATH` value if not already present.
/// Returns `None` if `dir` is already listed.
pub fn append_to_user_path(existing: &str, dir: &str) -> Option<String> {
    let target_norm = normalize_path_entry(dir);
    if target_norm.is_empty() {
        return None;
    }

    let mut entries: Vec<String> = existing
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .collect();

    if entries
        .iter()
        .any(|entry| normalize_path_entry(entry) == target_norm)
    {
        return None;
    }

    entries.push(dir.trim().trim_end_matches(['\\', '/']).to_string());
    Some(entries.join(";"))
}

/// Removes `dir` from a semicolon-separated Windows `PATH` value if present.
/// Returns `None` if `dir` was not in `existing`.
pub fn remove_from_user_path(existing: &str, dir: &str) -> Option<String> {
    let target_norm = normalize_path_entry(dir);
    if target_norm.is_empty() {
        return None;
    }

    let mut changed = false;
    let kept: Vec<String> = existing
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|entry| {
            let matches = normalize_path_entry(entry) == target_norm;
            if matches {
                changed = true;
            }
            !matches
        })
        .map(ToString::to_string)
        .collect();

    if changed {
        Some(kept.join(";"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_options_match_requirements() {
        let opts = InstallOptions::default();
        assert!(opts.desktop_shortcut);
        assert!(opts.start_menu_shortcut);
        assert!(!opts.add_to_path);
        assert!(!opts.context_menu);
        assert!(opts.install_dir.ends_with("Lighterm"));
    }

    #[test]
    fn browse_folder_appends_lighterm_unless_already_named_lighterm() {
        assert_eq!(
            normalize_browse_folder(Path::new(r"D:\Apps")),
            PathBuf::from(r"D:\Apps\Lighterm")
        );
        assert_eq!(
            normalize_browse_folder(Path::new(r"D:\Apps\lighterm")),
            PathBuf::from(r"D:\Apps\lighterm")
        );
    }

    #[test]
    fn user_path_append_and_remove_are_case_insensitive_and_idempotent() {
        let existing = r"%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;C:\Tools\";
        assert_eq!(append_to_user_path(existing, r"c:\tools"), None);

        let updated = append_to_user_path(existing, r"C:\Users\MingL\AppData\Local\Programs\Lighterm\")
            .expect("should append new dir");
        assert!(updated.ends_with(r";C:\Users\MingL\AppData\Local\Programs\Lighterm"));
        assert!(updated.contains(r"%USERPROFILE%\AppData\Local\Microsoft\WindowsApps"));

        assert_eq!(
            remove_from_user_path(&updated, r"c:\users\mingl\appdata\local\programs\lighterm"),
            Some(r"%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;C:\Tools\".to_string())
        );
        assert_eq!(
            remove_from_user_path(existing, r"D:\NonExistent"),
            None
        );
    }
}
