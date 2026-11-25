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
use crate::models::SessionStatus;

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

fn resolve_default_shell(shell: Option<&str>) -> String {
    if let Some(s) = shell {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    #[cfg(windows)]
    {
        if let Ok(comspec) = std::env::var("COMSPEC") {
            if !comspec.trim().is_empty() {
                return comspec;
            }
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
}
