use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::error::{CoreError, CoreResult};
use crate::events::CoreEventSink;
use crate::models::{LocalShellProfile, SessionStatus};

static STARTUP_CWD: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

/// Stores an initial working directory requested from CLI arguments (e.g. context menu).
pub fn set_startup_cwd(path: PathBuf) {
    let lock = STARTUP_CWD.get_or_init(|| Mutex::new(None));
    *lock.lock() = Some(path);
}

/// Consumes the one-shot startup working directory so only the initial local terminal uses it.
pub fn take_startup_cwd() -> Option<PathBuf> {
    STARTUP_CWD.get().and_then(|lock| lock.lock().take())
}

pub struct LocalPtyHandle {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    closed: Arc<AtomicBool>,
}

#[cfg(windows)]
fn windows_system_root() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

#[cfg(windows)]
fn find_pwsh_windows() -> Option<PathBuf> {
    let program_files = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);

    let mut candidates = Vec::new();
    if let Some(p) = find_in_path("pwsh.exe") {
        candidates.push(p);
    }
    candidates.push(program_files.join("PowerShell").join("7").join("pwsh.exe"));
    candidates.push(
        program_files
            .join("PowerShell")
            .join("7-preview")
            .join("pwsh.exe"),
    );
    if let Some(ref lad) = local_app_data {
        candidates.push(lad.join("Microsoft").join("WindowsApps").join("pwsh.exe"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

#[cfg(windows)]
fn find_win_powershell() -> Option<PathBuf> {
    let win_ps = windows_system_root()
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if win_ps.is_file() {
        Some(win_ps)
    } else {
        find_in_path("powershell.exe")
    }
}

#[cfg(windows)]
fn find_cmd_windows() -> Option<PathBuf> {
    std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| {
            let p = windows_system_root().join("System32").join("cmd.exe");
            p.is_file().then_some(p)
        })
        .or_else(|| find_in_path("cmd.exe"))
}

fn resolve_default_shell(shell: Option<&str>) -> String {
    if let Some(s) = shell {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    #[cfg(windows)]
    {
        if let Some(pwsh) = find_pwsh_windows() {
            return pwsh.to_string_lossy().to_string();
        }
        if let Some(win_ps) = find_win_powershell() {
            return win_ps.to_string_lossy().to_string();
        }
        if let Some(cmd) = find_cmd_windows() {
            return cmd.to_string_lossy().to_string();
        }
        return "powershell.exe".to_string();
    }

    #[cfg(not(windows))]
    {
        if let Ok(env_shell) = std::env::var("SHELL") {
            if !env_shell.trim().is_empty() && std::path::Path::new(&env_shell).exists() {
                return env_shell;
            }
        }
        if std::path::Path::new("/bin/bash").exists() {
            return "/bin/bash".to_string();
        }
        "/bin/sh".to_string()
    }
}

fn find_in_path(exe_name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn normalize_shell_key(shell: &str) -> String {
    #[cfg(windows)]
    {
        shell.trim().to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        std::fs::canonicalize(shell)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| shell.trim().to_string())
    }
}

fn is_executable_file(path: &std::path::Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            return meta.permissions().mode() & 0o111 != 0;
        }
        return false;
    }
    #[cfg(windows)]
    {
        true
    }
}

pub fn shell_executable_exists(shell: &str) -> bool {
    let trimmed = shell.trim();
    if trimmed.is_empty() {
        return false;
    }
    let path = std::path::Path::new(trimmed);
    if path.components().count() > 1 || path.is_absolute() {
        return is_executable_file(path);
    }
    if find_in_path(trimmed).is_some() {
        return true;
    }
    #[cfg(windows)]
    if !trimmed.to_ascii_lowercase().ends_with(".exe") {
        let with_exe = format!("{trimmed}.exe");
        if find_in_path(&with_exe).is_some() {
            return true;
        }
    }
    false
}

pub fn resolve_configured_default_shell(configured: Option<&str>) -> Option<String> {
    let trimmed = configured?.trim();
    if trimmed.is_empty() {
        return None;
    }
    if shell_executable_exists(trimmed) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn push_shell_candidate(
    profiles: &mut Vec<LocalShellProfile>,
    seen: &mut std::collections::HashSet<String>,
    id: &str,
    name: &str,
    path: PathBuf,
    description: Option<&str>,
) {
    if !is_executable_file(&path) {
        return;
    }
    let shell_str = path.to_string_lossy().to_string();
    let key = normalize_shell_key(&shell_str);
    if !seen.insert(key) {
        return;
    }

    let base_id = if id.trim().is_empty() { "shell" } else { id.trim() };
    let mut unique_id = base_id.to_string();
    let mut suffix = 2usize;
    while profiles.iter().any(|p| p.id == unique_id) {
        unique_id = format!("{base_id}-{suffix}");
        suffix += 1;
    }

    profiles.push(LocalShellProfile {
        id: unique_id,
        name: name.to_string(),
        shell: shell_str,
        description: description.map(str::to_string),
        is_default: false,
    });
}

#[cfg(windows)]
fn detect_platform_shells(
    profiles: &mut Vec<LocalShellProfile>,
    seen: &mut std::collections::HashSet<String>,
) {
    let system_root = windows_system_root();
    let program_files = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let program_files_x86 = std::env::var_os("ProgramFiles(x86)")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)"));
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);

    // PowerShell 7+
    if let Some(p) = find_pwsh_windows() {
        push_shell_candidate(
            profiles,
            seen,
            "pwsh",
            "PowerShell 7",
            p,
            Some("Cross-platform PowerShell"),
        );
    }

    // Windows PowerShell
    if let Some(p) = find_win_powershell() {
        push_shell_candidate(
            profiles,
            seen,
            "powershell",
            "Windows PowerShell",
            p,
            Some("Built-in Windows PowerShell"),
        );
    }

    // Command Prompt
    if let Some(p) = find_cmd_windows() {
        push_shell_candidate(
            profiles,
            seen,
            "cmd",
            "Command Prompt",
            p,
            Some("Windows Command Processor"),
        );
    }

    // Git Bash
    let mut git_bash_candidates = vec![
        program_files.join("Git").join("bin").join("bash.exe"),
        program_files_x86.join("Git").join("bin").join("bash.exe"),
    ];
    if let Some(ref lad) = local_app_data {
        git_bash_candidates.push(
            lad.join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    for candidate in git_bash_candidates {
        if candidate.is_file() {
            push_shell_candidate(
                profiles,
                seen,
                "git-bash",
                "Git Bash",
                candidate,
                Some("Git for Windows Bash"),
            );
            break;
        }
    }

    // WSL
    let mut wsl_candidates = vec![system_root.join("System32").join("wsl.exe")];
    if let Some(ref lad) = local_app_data {
        wsl_candidates.push(lad.join("Microsoft").join("WindowsApps").join("wsl.exe"));
    }
    if let Some(p) = find_in_path("wsl.exe") {
        wsl_candidates.push(p);
    }
    for candidate in wsl_candidates {
        if candidate.is_file() {
            push_shell_candidate(
                profiles,
                seen,
                "wsl",
                "WSL",
                candidate,
                Some("Windows Subsystem for Linux"),
            );
            break;
        }
    }

    // Nushell
    if let Some(p) = find_in_path("nu.exe") {
        push_shell_candidate(profiles, seen, "nu", "Nushell", p, Some("Modern structured shell"));
    }

    // MSYS2 Bash
    let msys2_bash = PathBuf::from(r"C:\msys64\usr\bin\bash.exe");
    if msys2_bash.is_file() {
        push_shell_candidate(
            profiles,
            seen,
            "msys2-bash",
            "MSYS2 Bash",
            msys2_bash,
            Some("MSYS2 Unix environment"),
        );
    }
}

#[cfg(not(windows))]
fn friendly_unix_shell_name(bin_name: &str) -> String {
    match bin_name.to_ascii_lowercase().as_str() {
        "zsh" => "Zsh".to_string(),
        "bash" => "Bash".to_string(),
        "fish" => "Fish".to_string(),
        "nu" => "Nushell".to_string(),
        "pwsh" => "PowerShell".to_string(),
        "sh" => "POSIX Shell".to_string(),
        "dash" => "Dash".to_string(),
        "csh" => "C Shell".to_string(),
        "tcsh" => "Tcsh".to_string(),
        "ksh" => "KornShell".to_string(),
        _ => bin_name.to_string(),
    }
}

#[cfg(not(windows))]
fn detect_platform_shells(
    profiles: &mut Vec<LocalShellProfile>,
    seen: &mut std::collections::HashSet<String>,
) {
    let candidates: &[(&str, &str, &str, &[&str])] = &[
        ("zsh", "Zsh", "Z Shell", &["/bin/zsh", "/usr/bin/zsh", "/opt/homebrew/bin/zsh", "/usr/local/bin/zsh"]),
        ("bash", "Bash", "Bourne Again Shell", &["/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"]),
        ("fish", "Fish", "Friendly Interactive Shell", &["/usr/bin/fish", "/bin/fish", "/opt/homebrew/bin/fish", "/usr/local/bin/fish"]),
        ("nu", "Nushell", "Modern structured shell", &["/usr/bin/nu", "/bin/nu", "/opt/homebrew/bin/nu", "/usr/local/bin/nu"]),
        ("pwsh", "PowerShell", "Cross-platform PowerShell", &["/usr/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/local/bin/pwsh"]),
        ("sh", "POSIX Shell", "Standard system shell", &["/bin/sh", "/usr/bin/sh"]),
    ];

    for (id, name, desc, paths) in candidates {
        let found = paths
            .iter()
            .map(PathBuf::from)
            .find(|p| is_executable_file(p))
            .or_else(|| find_in_path(id));
        if let Some(path) = found {
            push_shell_candidate(profiles, seen, id, name, path, Some(desc));
        }
    }

    if let Ok(env_shell) = std::env::var("SHELL") {
        let p = PathBuf::from(env_shell.trim());
        if is_executable_file(&p) {
            let bin = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("shell")
                .to_string();
            let label = friendly_unix_shell_name(&bin);
            push_shell_candidate(profiles, seen, &bin, &label, p, Some("User login shell"));
        }
    }

    if let Ok(etc_shells) = std::fs::read_to_string("/etc/shells") {
        for line in etc_shells.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let p = PathBuf::from(trimmed);
            if is_executable_file(&p) {
                let bin = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("shell")
                    .to_string();
                let label = friendly_unix_shell_name(&bin);
                push_shell_candidate(profiles, seen, &bin, &label, p, Some("System shell"));
            }
        }
    }
}

pub fn detect_local_shells() -> Vec<LocalShellProfile> {
    let mut profiles = Vec::new();
    let mut seen = std::collections::HashSet::new();

    detect_platform_shells(&mut profiles, &mut seen);

    let default_shell = resolve_default_shell(None);
    let default_key = normalize_shell_key(&default_shell);

    if let Some(default_profile) = profiles
        .iter_mut()
        .find(|p| normalize_shell_key(&p.shell) == default_key)
    {
        default_profile.is_default = true;
    } else if profiles.is_empty() {
        profiles.push(LocalShellProfile {
            id: "default".to_string(),
            name: "Local Shell".to_string(),
            shell: default_shell,
            description: Some("System default shell".to_string()),
            is_default: true,
        });
    } else {
        profiles[0].is_default = true;
    }

    if let Some(default_idx) = profiles.iter().position(|p| p.is_default) {
        if default_idx > 0 {
            let item = profiles.remove(default_idx);
            profiles.insert(0, item);
        }
    }

    profiles
}

pub fn spawn_local_pty(
    session_id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    sink: Arc<dyn CoreEventSink>,
) -> CoreResult<LocalPtyHandle> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| CoreError::PtyError(format!("Failed to open PTY: {e}")))?;

    let resolved_shell = resolve_default_shell(shell.as_deref());
    let mut cmd = CommandBuilder::new(&resolved_shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let explicit_cwd = cwd.and_then(|d| {
        let trimmed = d.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed))
        }
    });

    if let Some(path) = explicit_cwd {
        if path.exists() && path.is_dir() {
            cmd.cwd(path);
        }
    } else if let Some(startup) = take_startup_cwd().filter(|p| p.exists() && p.is_dir()) {
        cmd.cwd(startup);
    } else if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| CoreError::PtyError(format!("Failed to spawn shell '{resolved_shell}': {e}")))?;

    // Drop slave immediately so master sees EOF when child process exits.
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| CoreError::PtyError(format!("Failed to clone PTY reader: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| CoreError::PtyError(format!("Failed to take PTY writer: {e}")))?;

    let closed = Arc::new(AtomicBool::new(false));
    let closed_reader = Arc::clone(&closed);
    let sid = session_id.clone();

    sink.on_terminal_status(&sid, SessionStatus::Connected, None);

    std::thread::Builder::new()
        .name(format!("lighterm-pty-{}", &session_id))
        .spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let encoded = BASE64.encode(&buf[..n]);
                        sink.on_terminal_output(&sid, encoded);
                    }
                    Err(err) => {
                        if !closed_reader.load(Ordering::SeqCst) {
                            tracing::debug!("PTY read ended for {sid}: {err}");
                        }
                        break;
                    }
                }
            }

            closed_reader.store(true, Ordering::SeqCst);
            let exit_code = child.wait().ok().map(|status| status.exit_code());
            sink.on_terminal_status(&sid, SessionStatus::Disconnected, None);
            sink.on_terminal_exit(&sid, exit_code);
        })
        .map_err(|e| CoreError::PtyError(format!("Failed to spawn PTY reader thread: {e}")))?;

    Ok(LocalPtyHandle {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        killer: Mutex::new(killer),
        closed,
    })
}

impl LocalPtyHandle {
    pub fn write(&self, data: &[u8]) -> CoreResult<()> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(CoreError::PtyError("PTY session is closed".to_string()));
        }
        let mut writer = self.writer.lock();
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|e| CoreError::PtyError(format!("PTY write failed: {e}")))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> CoreResult<()> {
        if self.closed.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.master
            .lock()
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| CoreError::PtyError(format!("PTY resize failed: {e}")))
    }

    pub fn close(&self) -> CoreResult<()> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let _ = self.killer.lock().kill();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_cwd_is_consumed_once() {
        let sample = std::env::temp_dir();
        set_startup_cwd(sample.clone());
        assert_eq!(take_startup_cwd(), Some(sample));
        assert_eq!(take_startup_cwd(), None);
    }

    #[test]
    fn detect_local_shells_returns_at_least_one_default_profile() {
        let shells = detect_local_shells();
        assert!(!shells.is_empty());
        assert_eq!(shells.iter().filter(|s| s.is_default).count(), 1);
        assert!(shells[0].is_default);

        let mut seen = std::collections::HashSet::new();
        for s in &shells {
            assert!(!s.name.is_empty());
            assert!(!s.shell.is_empty());
            assert!(seen.insert(normalize_shell_key(&s.shell)));
        }

        #[cfg(windows)]
        if shells.iter().any(|s| s.id == "pwsh") {
            assert_eq!(shells[0].id, "pwsh");
            assert_eq!(
                normalize_shell_key(&resolve_default_shell(None)),
                normalize_shell_key(&shells[0].shell)
            );
        }

        assert_eq!(resolve_default_shell(Some("custom-shell")), "custom-shell");
    }

    #[test]
    fn configured_default_shell_ignores_missing_cross_os_paths() {
        assert_eq!(resolve_configured_default_shell(None), None);
        assert_eq!(resolve_configured_default_shell(Some("   ")), None);
        assert_eq!(
            resolve_configured_default_shell(Some("/nonexistent/cross-os/zsh")),
            None
        );

        let shells = detect_local_shells();
        let existing = &shells[0].shell;
        assert_eq!(
            resolve_configured_default_shell(Some(existing)),
            Some(existing.clone())
        );
    }
}
