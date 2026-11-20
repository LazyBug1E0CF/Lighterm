use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use parking_lot::Mutex;
use russh::keys::PrivateKey;
use russh::server::{self, Msg, Server as _, Session};
use russh::{Channel, ChannelId, Pty};
use serde::{Deserialize, Serialize};
use tempfile::tempdir;

use lighterm_core::error::{CoreError, CoreResult};
use lighterm_core::events::CoreEventSink;
use lighterm_core::models::{AuthMethod, HostConfig, SessionKind, SessionStatus};
use lighterm_core::plugin::{CoreContext, CorePlugin};
use lighterm_core::ssh::connect_host;
use lighterm_core::LightermCore;

#[derive(Default)]
struct RecordingSink {
    outputs: Mutex<HashMap<String, Vec<u8>>>,
    exits: Mutex<HashMap<String, Option<u32>>>,
    statuses: Mutex<Vec<(String, SessionStatus)>>,
}

impl RecordingSink {
    fn output_text(&self, session_id: &str) -> String {
        let guard = self.outputs.lock();
        guard
            .get(session_id)
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .unwrap_or_default()
    }
}

impl CoreEventSink for RecordingSink {
    fn on_terminal_output(&self, session_id: &str, data_base64: String) {
        if let Ok(bytes) = BASE64.decode(data_base64) {
            self.outputs
                .lock()
                .entry(session_id.to_string())
                .or_default()
                .extend_from_slice(&bytes);
        }
    }

    fn on_terminal_exit(&self, session_id: &str, exit_code: Option<u32>) {
        self.exits.lock().insert(session_id.to_string(), exit_code);
    }

    fn on_terminal_status(&self, session_id: &str, status: SessionStatus, _message: Option<String>) {
        self.statuses.lock().push((session_id.to_string(), status));
    }
}

#[test]
fn local_pty_spawn_write_resize_close() {
    let dir = tempdir().unwrap();
    let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();
    let sink = Arc::new(RecordingSink::default());

    #[cfg(windows)]
    let (shell_bin, raw_cmd): (&str, &[u8]) = (
        "cmd.exe",
        b"set \"LT_PFX=LIGHTERM_OK\" && call echo %LT_PFX%_42\r\n",
    );
    #[cfg(not(windows))]
    let (shell_bin, raw_cmd): (&str, &[u8]) = (
        "/bin/sh",
        b"printf \"LIGHTERM_OK_%d\\n\" 42\n",
    );

    let info = core
        .sessions
        .create_local(
            80,
            24,
            Some(dir.path().to_string_lossy().into_owned()),
            Some(shell_bin.to_string()),
            Some("Test Shell".to_string()),
            sink.clone(),
        )
        .unwrap();

    assert_eq!(info.kind, SessionKind::Local);
    assert_eq!(core.sessions.list_sessions().len(), 1);

    #[cfg(windows)]
    {
        // Windows ConPTY (PSEUDOCONSOLE_INHERIT_CURSOR) emits DSR `\x1b[6n` on startup
        // and blocks until the terminal host replies with CPR `\x1b[1;1R`.
        for _ in 0..80 {
            if sink.output_text(&info.id).contains("\x1b[6n") {
                core.sessions
                    .write_base64(&info.id, &BASE64.encode(b"\x1b[1;1R"))
                    .unwrap();
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        for _ in 0..80 {
            if sink.output_text(&info.id).contains('>') {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    let cmd = BASE64.encode(raw_cmd);
    core.sessions.write_base64(&info.id, &cmd).unwrap();

    let mut found = false;
    for _ in 0..120 {
        if sink.output_text(&info.id).contains("LIGHTERM_OK_42") {
            found = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        found,
        "Expected LIGHTERM_OK_42 in output, got: {:?}",
        sink.output_text(&info.id)
    );

    core.sessions.resize(&info.id, 120, 40).unwrap();
    let sessions = core.sessions.list_sessions();
    assert_eq!(sessions[0].cols, 120);
    assert_eq!(sessions[0].rows, 40);

    core.sessions.close(&info.id).unwrap();
    assert!(core.sessions.list_sessions().is_empty());
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
struct DummyPluginData {
    counter: u32,
    label: String,
}

#[test]
fn storage_roundtrip_and_unix_permissions() {
    let dir = tempdir().unwrap();
    let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();

    // Host persistence and 0600 permissions on Unix
    let saved_host = core
        .storage
        .save_host(HostConfig {
            id: String::new(),
            name: "Prod Web".to_string(),
            group: "Production".to_string(),
            host: "10.0.0.5".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth: AuthMethod::Password {
                password: Some("s3cr3t".to_string()),
            },
            default_path: Some("/var/www".to_string()),
            startup_command: None,
            color: Some("#7aa2f7".to_string()),
            updated_at: 0,
        })
        .unwrap();
    assert_eq!(core.storage.list_hosts().unwrap().len(), 1);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(dir.path().join("hosts.json")).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    }

    core.storage.delete_host(&saved_host.id).unwrap();
    assert!(core.storage.list_hosts().unwrap().is_empty());

    // Generic plugin JSON storage roundtrip
    assert!(!core.storage.has_plugin_file("dummy-plugin.json"));
    let data = DummyPluginData {
        counter: 7,
        label: "ok".to_string(),
    };
    core.storage
        .write_plugin_json("dummy-plugin.json", &data, false)
        .unwrap();
    assert!(core.storage.has_plugin_file("dummy-plugin.json"));
    let loaded: DummyPluginData = core.storage.read_plugin_json("dummy-plugin.json").unwrap();
    assert_eq!(loaded, data);

    // Settings persistence
    let mut settings = core.storage.get_settings().unwrap();
    settings.theme_id = "catppuccin-mocha".to_string();
    settings.background_opacity = 0.85;
    core.storage.save_settings(settings).unwrap();
    let reloaded = core.storage.get_settings().unwrap();
    assert_eq!(reloaded.theme_id, "catppuccin-mocha");
    assert!((reloaded.background_opacity - 0.85).abs() < f32::EPSILON);
}

#[derive(Default)]
struct BaseTestPlugin {
    activations: AtomicUsize,
    deactivations: AtomicUsize,
}

impl CorePlugin for BaseTestPlugin {
    fn id(&self) -> &'static str {
        "test.base"
    }

    fn name(&self) -> &'static str {
        "Base Plugin"
    }

    fn description(&self) -> &'static str {
        "Provides base capability"
    }

    fn on_activate(&self, _ctx: &CoreContext) -> CoreResult<()> {
        self.activations.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn on_deactivate(&self) -> CoreResult<()> {
        self.deactivations.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn as_any_arc(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

#[derive(Default)]
struct DependentTestPlugin {
    activations: AtomicUsize,
    deactivations: AtomicUsize,
}

impl CorePlugin for DependentTestPlugin {
    fn id(&self) -> &'static str {
        "test.dependent"
    }

    fn name(&self) -> &'static str {
        "Dependent Plugin"
    }

    fn description(&self) -> &'static str {
        "Requires test.base"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["test.base"]
    }

    fn on_activate(&self, _ctx: &CoreContext) -> CoreResult<()> {
        self.activations.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn on_deactivate(&self) -> CoreResult<()> {
        self.deactivations.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn as_any_arc(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

#[test]
fn plugin_registry_dependency_and_cascading_lifecycle() {
    let dir = tempdir().unwrap();
    let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();
    let ctx = core.context();

    let base = Arc::new(BaseTestPlugin::default());
    let dep = Arc::new(DependentTestPlugin::default());

    // Register dependent before base; stays inactive until base activates
    core.register_plugin(dep.clone()).unwrap();
    assert!(!core.plugins.is_active("test.dependent"));
    assert_eq!(dep.activations.load(Ordering::SeqCst), 0);

    // Registering base activates both base and dependent in dependency order
    core.register_plugin(base.clone()).unwrap();
    assert!(core.plugins.is_active("test.base"));
    assert!(core.plugins.is_active("test.dependent"));
    assert_eq!(base.activations.load(Ordering::SeqCst), 1);
    assert_eq!(dep.activations.load(Ordering::SeqCst), 1);

    // Downcast active plugin works
    let active_dep = core.plugins.get_active::<DependentTestPlugin>("test.dependent").unwrap();
    assert_eq!(active_dep.id(), "test.dependent");

    // Disabling base cascades deactivation to dependent
    core.plugins.set_enabled("test.base", false, &ctx).unwrap();
    assert!(!core.plugins.is_active("test.base"));
    assert!(!core.plugins.is_active("test.dependent"));
    assert_eq!(base.deactivations.load(Ordering::SeqCst), 1);
    assert_eq!(dep.deactivations.load(Ordering::SeqCst), 1);

    // Accessing disabled plugin yields CoreError::PluginDisabled
    let err = core
        .plugins
        .get_active::<DependentTestPlugin>("test.dependent")
        .err()
        .unwrap();
    assert!(matches!(err, CoreError::PluginDisabled(_)));

    // Enabling dependent while base is disabled fails cleanly
    assert!(core.plugins.set_enabled("test.dependent", true, &ctx).is_err());

    // Re-enabling base automatically re-activates dependent since dependent was not explicitly disabled
    core.plugins.set_enabled("test.base", true, &ctx).unwrap();
    assert!(core.plugins.is_active("test.base"));
    assert!(core.plugins.is_active("test.dependent"));
}

#[derive(Clone)]
struct TestSshServer {
    expected_user: String,
    expected_password: String,
    expected_pubkey_openssh: String,
}

impl server::Server for TestSshServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for TestSshServer {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        if user == self.expected_user && password == self.expected_password {
            Ok(server::Auth::Accept)
        } else {
            Ok(server::Auth::reject())
        }
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> Result<server::Auth, Self::Error> {
        if user == self.expected_user
            && key.public_key.to_openssh().ok().as_deref() == Some(&self.expected_pubkey_openssh)
        {
            Ok(server::Auth::Accept)
        } else {
            Ok(server::Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, b"WELCOME_SSH\r\n".to_vec())?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, data.to_vec())?;
        Ok(())
    }
}

#[tokio::test]
async fn ssh_password_and_key_auth_roundtrip() {
    let server_key = PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let client_key = PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let client_pem = client_key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .unwrap()
        .to_string();
    let client_pub_openssh = client_key.public_key().to_openssh().unwrap();

    let mut srv_cfg = server::Config::default();
    srv_cfg.inactivity_timeout = Some(Duration::from_secs(30));
    srv_cfg.auth_rejection_time = Duration::from_millis(50);
    srv_cfg.keys.push(server_key);
    let srv_cfg = Arc::new(srv_cfg);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let srv_template = TestSshServer {
        expected_user: "tester".to_string(),
        expected_password: "pw123".to_string(),
        expected_pubkey_openssh: client_pub_openssh,
    };

    tokio::spawn(async move {
        while let Ok((stream, peer)) = listener.accept().await {
            let mut template = srv_template.clone();
            let handler = template.new_client(Some(peer));
            let cfg = Arc::clone(&srv_cfg);
            tokio::spawn(async move {
                let _ = server::run_stream(cfg, stream, handler).await;
            });
        }
    });

    let dir = tempdir().unwrap();
    let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();
    let sink = Arc::new(RecordingSink::default());

    // 1. Password auth + SSH PTY session echo
    let pw_host = HostConfig {
        id: "host-pw".to_string(),
        name: "Test PW".to_string(),
        group: "Test".to_string(),
        host: addr.ip().to_string(),
        port: addr.port(),
        username: "tester".to_string(),
        auth: AuthMethod::Password {
            password: Some("pw123".to_string()),
        },
        default_path: None,
        startup_command: None,
        color: None,
        updated_at: 0,
    };

    let sess = core.sessions.create_ssh(&pw_host, 90, 30, sink.clone()).await.unwrap();
    assert_eq!(sess.kind, SessionKind::Ssh);
    core.sessions
        .write_base64(&sess.id, &BASE64.encode(b"PING_SSH"))
        .unwrap();

    let mut echoed = false;
    for _ in 0..40 {
        let txt = sink.output_text(&sess.id);
        if txt.contains("WELCOME_SSH") && txt.contains("PING_SSH") {
            echoed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        echoed,
        "Expected WELCOME_SSH and PING_SSH in SSH output, got: {:?}",
        sink.output_text(&sess.id)
    );
    core.sessions.close(&sess.id).unwrap();

    // 2. Private key (inline PEM + file path) auth
    let key_file = Path::new(dir.path()).join("id_test_ed25519");
    std::fs::write(&key_file, &client_pem).unwrap();

    let key_host = HostConfig {
        id: "host-key".to_string(),
        name: "Test Key".to_string(),
        group: "Test".to_string(),
        host: addr.ip().to_string(),
        port: addr.port(),
        username: "tester".to_string(),
        auth: AuthMethod::PrivateKey {
            key_path: Some(key_file.to_string_lossy().into_owned()),
            private_key_pem: None,
            passphrase: None,
        },
        default_path: None,
        startup_command: None,
        color: None,
        updated_at: 0,
    };

    let handle = connect_host(&key_host).await.unwrap();
    assert!(!handle.is_closed());

    // 3. Inline PEM auth
    let pem_host = HostConfig {
        auth: AuthMethod::PrivateKey {
            key_path: None,
            private_key_pem: Some(client_pem),
            passphrase: None,
        },
        ..key_host
    };
    let handle2 = connect_host(&pem_host).await.unwrap();
    assert!(!handle2.is_closed());

    // 4. Wrong password should fail with AuthFailed
    let bad_host = HostConfig {
        auth: AuthMethod::Password {
            password: Some("wrong".to_string()),
        },
        ..pw_host
    };
    assert!(connect_host(&bad_host).await.is_err());
}
