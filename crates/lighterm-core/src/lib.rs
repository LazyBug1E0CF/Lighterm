pub mod error;
pub mod events;
pub mod models;
pub mod monitor;
pub mod pty;
pub mod session_manager;
pub mod sftp;
pub mod ssh;
pub mod storage;

use std::path::PathBuf;
use std::sync::Arc;

use error::CoreResult;
use monitor::SystemMonitor;
use session_manager::SessionManager;
use sftp::SftpManager;
use ssh::SshConnectionPool;
use storage::Storage;

pub struct LightermCore {
    pub storage: Arc<Storage>,
    pub ssh_pool: Arc<SshConnectionPool>,
    pub sftp: Arc<SftpManager>,
    pub sessions: Arc<SessionManager>,
    pub monitor: Arc<SystemMonitor>,
}

impl LightermCore {
    pub fn with_data_dir(data_dir: PathBuf) -> CoreResult<Self> {
        let storage = Arc::new(Storage::new(data_dir)?);
        let ssh_pool = Arc::new(SshConnectionPool::new());
        let sftp = Arc::new(SftpManager::new(Arc::clone(&ssh_pool)));
        let sessions = Arc::new(SessionManager::new(Arc::clone(&ssh_pool)));
        let monitor = Arc::new(SystemMonitor::new(Arc::clone(&ssh_pool)));
        Ok(Self {
            storage,
            ssh_pool,
            sftp,
            sessions,
            monitor,
        })
    }

    pub fn default_instance() -> CoreResult<Self> {
        Self::with_data_dir(Storage::default_dir())
    }
}
