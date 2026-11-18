use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionKind {
    Local,
    Ssh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub kind: SessionKind,
    pub title: String,
    pub host_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub status: SessionStatus,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthMethod {
    Password {
        password: Option<String>,
    },
    PrivateKey {
        #[serde(rename = "keyPath")]
        key_path: Option<String>,
        #[serde(rename = "privateKeyPem")]
        private_key_pem: Option<String>,
        passphrase: Option<String>,
    },
}

impl Default for AuthMethod {
    fn default() -> Self {
        Self::Password { password: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub id: String,
    pub name: String,
    pub group: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub default_path: Option<String>,
    pub startup_command: Option<String>,
    pub color: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub permissions: String,
    pub mode: u32,
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferProgress {
    pub transfer_id: String,
    pub host_id: String,
    pub file_name: String,
    pub direction: String,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub title: String,
    pub command: String,
    pub category: String,
    pub description: Option<String>,
    pub auto_execute: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub command: String,
    pub session_kind: SessionKind,
    pub host_label: String,
    pub timestamp: i64,
    pub count: u32,
}

fn default_toggle_monitor() -> String {
    "Ctrl+Shift+M".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutMap {
    pub new_local_tab: String,
    pub new_host_modal: String,
    pub split_horizontal: String,
    pub split_vertical: String,
    pub close_pane: String,
    pub find_in_terminal: String,
    pub command_palette: String,
    pub toggle_sidebar: String,
    pub toggle_sftp: String,
    #[serde(default = "default_toggle_monitor")]
    pub toggle_monitor: String,
    pub open_settings: String,
    pub next_tab: String,
    pub prev_tab: String,
}

impl Default for ShortcutMap {
    fn default() -> Self {
        Self {
            new_local_tab: "Ctrl+Shift+T".to_string(),
            new_host_modal: "Ctrl+Shift+N".to_string(),
            split_horizontal: "Ctrl+Shift+D".to_string(),
            split_vertical: "Ctrl+Shift+E".to_string(),
            close_pane: "Ctrl+Shift+W".to_string(),
            find_in_terminal: "Ctrl+Shift+F".to_string(),
            command_palette: "Ctrl+Shift+P".to_string(),
            toggle_sidebar: "Ctrl+Shift+B".to_string(),
            toggle_sftp: "Ctrl+Shift+S".to_string(),
            toggle_monitor: default_toggle_monitor(),
            open_settings: "Ctrl+,".to_string(),
            next_tab: "Ctrl+Tab".to_string(),
            prev_tab: "Ctrl+Shift+Tab".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme_id: String,
    pub font_family: String,
    pub font_size: u16,
    pub line_height: f32,
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub scrollback: u32,
    pub background_opacity: f32,
    pub copy_on_select: bool,
    pub shortcuts: ShortcutMap,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme_id: "tokyo-night".to_string(),
            font_family: "'JetBrains Mono', 'Fira Code', 'Noto Sans Mono CJK SC', monospace"
                .to_string(),
            font_size: 14,
            line_height: 1.35,
            cursor_style: "bar".to_string(),
            cursor_blink: true,
            scrollback: 10000,
            background_opacity: 0.96,
            copy_on_select: false,
            shortcuts: ShortcutMap::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub success: bool,
    pub latency_ms: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskStat {
    pub name: String,
    pub mount_point: String,
    pub fs_type: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub usage_percent: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStat {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub source: SessionKind,
    pub hostname: String,
    pub os_name: String,
    pub kernel_version: String,
    pub arch: String,
    pub uptime_secs: u64,
    pub load_avg: [f64; 3],
    pub cpu_usage_percent: f32,
    pub cpu_cores: usize,
    pub mem_total_bytes: u64,
    pub mem_used_bytes: u64,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub net_rx_bytes_per_sec: u64,
    pub net_tx_bytes_per_sec: u64,
    pub net_total_rx_bytes: u64,
    pub net_total_tx_bytes: u64,
    pub disks: Vec<DiskStat>,
    pub top_processes: Vec<ProcessStat>,
    pub sampled_at: i64,
}
