use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::error::{CoreError, CoreResult};
use crate::events::CoreEventSink;
use crate::models::{HostConfig, SftpEntry, SftpTransferProgress};
use crate::ssh::SshConnectionPool;

pub fn join_remote_path(base: &str, segment: &str) -> String {
    let trimmed_seg = segment.trim();
    if trimmed_seg.starts_with('/') {
        return normalize_remote_path(trimmed_seg);
    }
    let clean_base = if base.is_empty() { "/" } else { base };
    let joined = if clean_base == "/" {
        format!("/{trimmed_seg}")
    } else {
        format!("{}/{trimmed_seg}", clean_base.trim_end_matches('/'))
    };
    normalize_remote_path(&joined)
}

pub fn normalize_remote_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

pub fn format_unix_mode(mode: u32, is_dir: bool, is_symlink: bool) -> String {
    let kind = if is_symlink {
        'l'
    } else if is_dir {
        'd'
    } else {
        '-'
    };
    let bits = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    let mut out = String::with_capacity(10);
    out.push(kind);
    for (mask, ch) in bits {
        out.push(if mode & mask != 0 { ch } else { '-' });
    }
    out
}

pub struct SftpManager {
    pool: Arc<SshConnectionPool>,
    sessions: Mutex<HashMap<String, Arc<SftpSession>>>,
}

impl SftpManager {
    pub fn new(pool: Arc<SshConnectionPool>) -> Self {
        Self {
            pool,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn invalidate(&self, host_id: &str) {
        self.sessions.lock().remove(host_id);
    }

    async fn get_session(&self, host: &HostConfig) -> CoreResult<Arc<SftpSession>> {
        if let Some(existing) = self.sessions.lock().get(&host.id).cloned() {
            return Ok(existing);
        }
        self.open_session(host).await
    }

    async fn open_session(&self, host: &HostConfig) -> CoreResult<Arc<SftpSession>> {
        let handle = self.pool.get_or_connect(host).await?;
        let channel = match handle.channel_open_session().await {
            Ok(ch) => ch,
            Err(_) => {
                self.pool.invalidate(&host.id);
                let fresh = self.pool.get_or_connect(host).await?;
                fresh
                    .channel_open_session()
                    .await
                    .map_err(|e| CoreError::SftpError(format!("Failed to open SFTP channel: {e}")))?
            }
        };

        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| CoreError::SftpError(format!("Failed to request SFTP subsystem: {e}")))?;

        let session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| CoreError::SftpError(format!("Failed to start SFTP session: {e}")))?;

        let arc = Arc::new(session);
        self.sessions.lock().insert(host.id.clone(), Arc::clone(&arc));
        Ok(arc)
    }

    pub async fn canonicalize(&self, host: &HostConfig, path: &str) -> CoreResult<String> {
        let target = if path.trim().is_empty() { "." } else { path.trim() };
        let sftp = self.get_session(host).await?;
        match sftp.canonicalize(target).await {
            Ok(resolved) => Ok(resolved),
            Err(_) => {
                self.invalidate(&host.id);
                let fresh = self.open_session(host).await?;
                fresh
                    .canonicalize(target)
                    .await
                    .map_err(|e| CoreError::SftpError(format!("Canonicalize failed: {e}")))
            }
        }
    }

    pub async fn list_dir(&self, host: &HostConfig, path: &str) -> CoreResult<Vec<SftpEntry>> {
        let target = if path.trim().is_empty() { "." } else { path.trim() };
        let sftp = self.get_session(host).await?;
        let read_dir = match sftp.read_dir(target).await {
            Ok(rd) => rd,
            Err(_) => {
                self.invalidate(&host.id);
                let fresh = self.open_session(host).await?;
                fresh
                    .read_dir(target)
                    .await
                    .map_err(|e| CoreError::SftpError(format!("Failed to list '{target}': {e}")))?
            }
        };

        let mut entries = Vec::new();
        for item in read_dir {
            let name = item.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = item.metadata();
            let is_symlink = meta.is_symlink();
            let mut is_dir = meta.is_dir();
            let entry_path = join_remote_path(target, &name);

            if is_symlink && !is_dir {
                if let Ok(resolved_meta) = sftp.metadata(&entry_path).await {
                    is_dir = resolved_meta.is_dir();
                }
            }

            let mode = meta.permissions.unwrap_or(if is_dir { 0o755 } else { 0o644 });
            let permissions = format_unix_mode(mode, is_dir, is_symlink);
            let modified_at = meta.mtime.map(|t| t as i64);

            entries.push(SftpEntry {
                name,
                path: entry_path,
                is_dir,
                is_symlink,
                size: meta.len(),
                permissions,
                mode,
                modified_at,
            });
        }

        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(entries)
    }

    pub async fn create_dir(&self, host: &HostConfig, path: &str) -> CoreResult<()> {
        let sftp = self.get_session(host).await?;
        sftp.create_dir(path)
            .await
            .map_err(|e| CoreError::SftpError(format!("Failed to create directory '{path}': {e}")))
    }

    pub async fn remove_entry(&self, host: &HostConfig, path: &str, is_dir: bool) -> CoreResult<()> {
        let sftp = self.get_session(host).await?;
        if is_dir {
            sftp.remove_dir(path)
                .await
                .map_err(|e| CoreError::SftpError(format!("Failed to remove directory '{path}': {e}")))
        } else {
            sftp.remove_file(path)
                .await
                .map_err(|e| CoreError::SftpError(format!("Failed to remove file '{path}': {e}")))
        }
    }

    pub async fn rename_entry(
        &self,
        host: &HostConfig,
        old_path: &str,
        new_path: &str,
    ) -> CoreResult<()> {
        let sftp = self.get_session(host).await?;
        sftp.rename(old_path, new_path)
            .await
            .map_err(|e| CoreError::SftpError(format!("Failed to rename '{old_path}': {e}")))
    }

    pub async fn upload_file(
        &self,
        host: &HostConfig,
        local_path: &Path,
        remote_path: &str,
        sink: &dyn CoreEventSink,
    ) -> CoreResult<()> {
        let sftp = self.get_session(host).await?;
        let mut local_file = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| CoreError::SftpError(format!("Failed to open local file: {e}")))?;
        let total_bytes = local_file
            .metadata()
            .await
            .map(|m| m.len())
            .unwrap_or(0);

        let file_name = local_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("upload")
            .to_string();
        let transfer_id = Uuid::new_v4().to_string();

        let mut remote_file = sftp
            .create(remote_path)
            .await
            .map_err(|e| CoreError::SftpError(format!("Failed to create remote file '{remote_path}': {e}")))?;

        let mut buf = vec![0u8; 65536];
        let mut transferred = 0u64;

        loop {
            let n = local_file
                .read(&mut buf)
                .await
                .map_err(|e| CoreError::SftpError(format!("Local read failed: {e}")))?;
            if n == 0 {
                break;
            }
            if let Err(err) = remote_file.write_all(&buf[..n]).await {
                sink.on_sftp_progress(SftpTransferProgress {
                    transfer_id,
                    host_id: host.id.clone(),
                    file_name,
                    direction: "upload".to_string(),
                    bytes_transferred: transferred,
                    total_bytes,
                    done: true,
                    error: Some(err.to_string()),
                });
                return Err(CoreError::SftpError(format!("Remote write failed: {err}")));
            }
            transferred += n as u64;
            sink.on_sftp_progress(SftpTransferProgress {
                transfer_id: transfer_id.clone(),
                host_id: host.id.clone(),
                file_name: file_name.clone(),
                direction: "upload".to_string(),
                bytes_transferred: transferred,
                total_bytes,
                done: false,
                error: None,
            });
        }

        remote_file
            .flush()
            .await
            .map_err(|e| CoreError::SftpError(format!("Remote flush failed: {e}")))?;
        remote_file
            .close()
            .await
            .map_err(|e| CoreError::SftpError(format!("Remote close failed: {e}")))?;

        sink.on_sftp_progress(SftpTransferProgress {
            transfer_id,
            host_id: host.id.clone(),
            file_name,
            direction: "upload".to_string(),
            bytes_transferred: transferred,
            total_bytes,
            done: true,
            error: None,
        });

        Ok(())
    }

    pub async fn download_file(
        &self,
        host: &HostConfig,
        remote_path: &str,
        local_path: &Path,
        sink: &dyn CoreEventSink,
    ) -> CoreResult<()> {
        let sftp = self.get_session(host).await?;
        let total_bytes = sftp
            .metadata(remote_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);

        let mut remote_file = sftp
            .open(remote_path)
            .await
            .map_err(|e| CoreError::SftpError(format!("Failed to open remote file '{remote_path}': {e}")))?;

        let mut local_file = tokio::fs::File::create(local_path)
            .await
            .map_err(|e| CoreError::SftpError(format!("Failed to create local file: {e}")))?;

        let file_name = remote_path
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("download")
            .to_string();
        let transfer_id = Uuid::new_v4().to_string();

        let mut buf = vec![0u8; 65536];
        let mut transferred = 0u64;

        loop {
            let n = remote_file
                .read(&mut buf)
                .await
                .map_err(|e| CoreError::SftpError(format!("Remote read failed: {e}")))?;
            if n == 0 {
                break;
            }
            if let Err(err) = local_file.write_all(&buf[..n]).await {
                sink.on_sftp_progress(SftpTransferProgress {
                    transfer_id,
                    host_id: host.id.clone(),
                    file_name,
                    direction: "download".to_string(),
                    bytes_transferred: transferred,
                    total_bytes,
                    done: true,
                    error: Some(err.to_string()),
                });
                return Err(CoreError::SftpError(format!("Local write failed: {err}")));
            }
            transferred += n as u64;
            sink.on_sftp_progress(SftpTransferProgress {
                transfer_id: transfer_id.clone(),
                host_id: host.id.clone(),
                file_name: file_name.clone(),
                direction: "download".to_string(),
                bytes_transferred: transferred,
                total_bytes,
                done: false,
                error: None,
            });
        }

        local_file
            .flush()
            .await
            .map_err(|e| CoreError::SftpError(format!("Local flush failed: {e}")))?;
        let _ = remote_file.close().await;

        sink.on_sftp_progress(SftpTransferProgress {
            transfer_id,
            host_id: host.id.clone(),
            file_name,
            direction: "download".to_string(),
            bytes_transferred: transferred,
            total_bytes,
            done: true,
            error: None,
        });

        Ok(())
    }
}
