pub mod error;
pub mod events;
pub mod models;
pub mod plugin;
pub mod pty;
pub mod session_manager;
pub mod ssh;
pub mod storage;

use std::path::PathBuf;
use std::sync::Arc;

use error::CoreResult;
use plugin::{CoreContext, CorePlugin, PluginRegistry};
use session_manager::SessionManager;
use ssh::SshConnectionPool;
use storage::Storage;

pub struct LightermCore {
    pub storage: Arc<Storage>,
    pub ssh_pool: Arc<SshConnectionPool>,
    pub sessions: Arc<SessionManager>,
    pub plugins: Arc<PluginRegistry>,
}

impl LightermCore {
    pub fn with_data_dir(data_dir: PathBuf) -> CoreResult<Self> {
        let storage = Arc::new(Storage::new(data_dir)?);
        let ssh_pool = Arc::new(SshConnectionPool::new());
        let sessions = Arc::new(SessionManager::new(Arc::clone(&ssh_pool)));
        let plugins = Arc::new(PluginRegistry::new());
        Ok(Self {
            storage,
            ssh_pool,
            sessions,
            plugins,
        })
    }

    pub fn default_instance() -> CoreResult<Self> {
        Self::with_data_dir(Storage::default_dir())
    }

    pub fn context(&self) -> CoreContext {
        CoreContext {
            storage: Arc::clone(&self.storage),
            ssh_pool: Arc::clone(&self.ssh_pool),
            sessions: Arc::clone(&self.sessions),
        }
    }

    pub fn register_plugin(&self, plugin: Arc<dyn CorePlugin>) -> CoreResult<()> {
        let ctx = self.context();
        self.plugins.register(plugin, &ctx)
    }
}
