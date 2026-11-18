use std::collections::HashMap;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::Utc;
use parking_lot::Mutex;
use uuid::Uuid;

use crate::error::{CoreError, CoreResult};
use crate::events::CoreEventSink;
use crate::models::{HostConfig, SessionInfo, SessionKind, SessionStatus};
use crate::pty::{spawn_local_pty, LocalPtyHandle};
use crate::ssh::{spawn_ssh_pty, SshConnectionPool, SshPtyHandle};

enum ActiveSessionHandle {
    Local(LocalPtyHandle),
    Ssh(SshPtyHandle),
}

struct SessionEntry {
    info: SessionInfo,
    handle: ActiveSessionHandle,
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionEntry>>,
    ssh_pool: Arc<SshConnectionPool>,
}

impl SessionManager {
    pub fn new(ssh_pool: Arc<SshConnectionPool>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            ssh_pool,
        }
    }

    pub fn create_local(
        &self,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
        title: Option<String>,
        sink: Arc<dyn CoreEventSink>,
    ) -> CoreResult<SessionInfo> {
        let id = Uuid::new_v4().to_string();
        let resolved_title = title.unwrap_or_else(|| "Local Shell".to_string());
        let handle = spawn_local_pty(id.clone(), cols, rows, cwd, shell, sink)?;

        let info = SessionInfo {
            id: id.clone(),
            kind: SessionKind::Local,
            title: resolved_title,
            host_id: None,
            cols: cols.max(1),
            rows: rows.max(1),
            status: SessionStatus::Connected,
            created_at: Utc::now().timestamp_millis(),
        };

        self.sessions.lock().insert(
            id,
            SessionEntry {
                info: info.clone(),
                handle: ActiveSessionHandle::Local(handle),
            },
        );
        Ok(info)
    }

    pub async fn create_ssh(
        &self,
        host: &HostConfig,
        cols: u16,
        rows: u16,
        sink: Arc<dyn CoreEventSink>,
    ) -> CoreResult<SessionInfo> {
        let id = Uuid::new_v4().to_string();
        let handle =
            spawn_ssh_pty(id.clone(), Arc::clone(&self.ssh_pool), host, cols, rows, sink).await?;

        let info = SessionInfo {
            id: id.clone(),
            kind: SessionKind::Ssh,
            title: if host.name.trim().is_empty() {
                format!("{}@{}", host.username, host.host)
            } else {
                host.name.clone()
            },
            host_id: Some(host.id.clone()),
            cols: cols.max(1),
            rows: rows.max(1),
            status: SessionStatus::Connected,
            created_at: Utc::now().timestamp_millis(),
        };

        self.sessions.lock().insert(
            id,
            SessionEntry {
                info: info.clone(),
                handle: ActiveSessionHandle::Ssh(handle),
            },
        );
        Ok(info)
    }

    pub fn write_base64(&self, session_id: &str, data_base64: &str) -> CoreResult<()> {
        let bytes = BASE64
            .decode(data_base64)
            .map_err(|e| CoreError::InvalidInput(format!("Invalid base64 payload: {e}")))?;
        let guard = self.sessions.lock();
        let entry = guard
            .get(session_id)
            .ok_or_else(|| CoreError::SessionNotFound(session_id.to_string()))?;

        match &entry.handle {
            ActiveSessionHandle::Local(h) => h.write(&bytes),
            ActiveSessionHandle::Ssh(h) => h.write(&bytes),
        }
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> CoreResult<()> {
        let mut guard = self.sessions.lock();
        let entry = guard
            .get_mut(session_id)
            .ok_or_else(|| CoreError::SessionNotFound(session_id.to_string()))?;

        entry.info.cols = cols.max(1);
        entry.info.rows = rows.max(1);

        match &entry.handle {
            ActiveSessionHandle::Local(h) => h.resize(cols, rows),
            ActiveSessionHandle::Ssh(h) => h.resize(cols, rows),
        }
    }

    pub fn close(&self, session_id: &str) -> CoreResult<()> {
        let removed = self.sessions.lock().remove(session_id);
        if let Some(entry) = removed {
            match entry.handle {
                ActiveSessionHandle::Local(h) => h.close()?,
                ActiveSessionHandle::Ssh(h) => h.close()?,
            }
        }
        Ok(())
    }

    pub fn list_sessions(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .values()
            .map(|e| e.info.clone())
            .collect()
    }
}
