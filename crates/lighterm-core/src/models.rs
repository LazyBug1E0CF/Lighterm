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

fn default_toggle_monitor() -> String {
    "Ctrl+Shift+M".to_string()
}

fn default_open_plugins() -> String {
    "Ctrl+Shift+X".to_string()
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
    #[serde(default = "default_open_plugins")]
    pub open_plugins: String,
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
            open_plugins: default_open_plugins(),
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
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub dependencies: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuickShellLayoutPreset {
    Tab,
    Vsp,
    Hsp,
    Grid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTerminalSlot {
    pub slot_id: String,
    pub title: String,
    pub kind: SessionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SavedDockNode {
    #[serde(rename_all = "camelCase")]
    Group {
        slot_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_slot_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Split {
        direction: SplitDirection,
        ratio: f64,
        first: Box<SavedDockNode>,
        second: Box<SavedDockNode>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFloatingSlot {
    pub slot_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z_index: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedWorkspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub slots: Vec<SavedTerminalSlot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dock_root: Option<SavedDockNode>,
    #[serde(default)]
    pub floating: Vec<SavedFloatingSlot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_slot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximized_slot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_preset: Option<QuickShellLayoutPreset>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

