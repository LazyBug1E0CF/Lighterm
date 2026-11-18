use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use parking_lot::Mutex;
use russh::keys::PrivateKey;
use russh::server::{self, Msg, Server as _, Session};
use russh::{Channel, ChannelId, Pty};
use tempfile::tempdir;

use lighterm_core::events::CoreEventSink;
use lighterm_core::models::{AuthMethod, HostConfig, SessionKind, SessionStatus, Snippet};
use lighterm_core::monitor::{parse_remote_probe_output, RemotePrevCounters};
use lighterm_core::sftp::{format_unix_mode, join_remote_path};
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

    fn on_sftp_progress(&self, _progress: lighterm_core::models::SftpTransferProgress) {}
}

#[test]
fn local_pty_spawn_write_resize_close() {
    let dir = tempdir().unwrap();
    let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();
    let sink = Arc::new(RecordingSink::default());

    let info = core
        .sessions
        .create_local(
            80,
            24,
            Some(dir.path().to_string_lossy().into_owned()),
            Some("/bin/sh".to_string()),
            Some("Test Shell".to_string()),
            sink.clone(),
        )
        .unwrap();

    assert_eq!(info.kind, SessionKind::Local);
    assert_eq!(core.sessions.list_sessions().len(), 1);

    let cmd = BASE64.encode(b"printf \"LIGHTERM_OK_%d\\n\" 42\n");
    core.sessions.write_base64(&info.id, &cmd).unwrap();

    let mut found = false;
    for _ in 0..50 {
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

#[test]
fn storage_roundtrip_and_unix_permissions() {
    let dir = tempdir().unwrap();
    let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();

    // Starter snippets and settings seeded automatically
    let snippets = core.storage.list_snippets().unwrap();
    assert!(!snippets.is_empty());

    let new_snip = core
        .storage
        .save_snippet(Snippet {
            id: String::new(),
            title: "Check Memory".to_string(),
            command: "free -h".to_string(),
            category: "System".to_string(),
            description: None,
            auto_execute: true,
            updated_at: 0,
        })
        .unwrap();
    assert_eq!(
        core.storage.list_snippets().unwrap().len(),
        snippets.len() + 1
    );
    core.storage.delete_snippet(&new_snip.id).unwrap();
    assert_eq!(core.storage.list_snippets().unwrap().len(), snippets.len());

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

    // History deduplication & search
    core.storage
        .record_history("ls -la".to_string(), SessionKind::Local, "Local".to_string())
        .unwrap();
    core.storage
        .record_history("uname -a".to_string(), SessionKind::Local, "Local".to_string())
        .unwrap();
    let updated = core
        .storage
        .record_history("ls -la".to_string(), SessionKind::Local, "Local".to_string())
        .unwrap()
        .unwrap();
    assert_eq!(updated.count, 2);
    let filtered = core.storage.list_history(Some("uname"), Some(10)).unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].command, "uname -a");

    // Settings persistence
    let mut settings = core.storage.get_settings().unwrap();
    settings.theme_id = "catppuccin-mocha".to_string();
    settings.background_opacity = 0.85;
    core.storage.save_settings(settings).unwrap();
    let reloaded = core.storage.get_settings().unwrap();
    assert_eq!(reloaded.theme_id, "catppuccin-mocha");
    assert!((reloaded.background_opacity - 0.85).abs() < f32::EPSILON);
}

#[test]
fn sftp_remote_path_and_mode_formatting() {
    assert_eq!(join_remote_path("/var/www", "html"), "/var/www/html");
    assert_eq!(join_remote_path("/var/www/", "../logs"), "/var/logs");
    assert_eq!(join_remote_path("/var/www", "/etc/nginx"), "/etc/nginx");
    assert_eq!(format_unix_mode(0o755, true, false), "drwxr-xr-x");
    assert_eq!(format_unix_mode(0o644, false, false), "-rw-r--r--");
    assert_eq!(format_unix_mode(0o777, false, true), "lrwxrwxrwx");
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

#[test]
fn local_and_remote_monitor_collection() {
    let dir = tempdir().unwrap();
    let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();

    let local = core.monitor.collect_local().unwrap();
    assert_eq!(local.source, SessionKind::Local);
    assert!(local.cpu_cores >= 1);
    assert!(local.mem_total_bytes > 0);
    assert!(!local.top_processes.is_empty());

    let sample_1 = "\
===HOST===
prod-node-01
Linux 6.8.0-45-generic
x86_64
===UPTIME===
123456.78 987654.32
===LOAD===
0.42 0.31 0.25 1/240 1234
===CPU===
4
cpu  1000 0 500 8500 0 0 0 0 0 0
===MEM===
MemTotal:        8192000 kB
MemAvailable:    4096000 kB
SwapTotal:       2048000 kB
SwapFree:        1536000 kB
===NET===
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 10000 100 0 0 0 0 0 0 10000 100 0 0 0 0 0 0
  eth0: 100000 100 0 0 0 0 0 0 50000 80 0 0 0 0 0 0
===DISK===
Filesystem     Type 1B-blocks        Used   Available Capacity Mounted on
/dev/sda1      ext4 107374182400 53687091200 53687091200      50% /
tmpfs          tmpfs 4194304000     1048576  4193255424       1% /run
===PROC===
  101 12.5 102400 nginx
  202  3.2  51200 postgres
";

    let sample_2 = "\
===HOST===
prod-node-01
Linux 6.8.0-45-generic
x86_64
===UPTIME===
123458.78 987656.32
===LOAD===
0.55 0.35 0.27 2/240 1235
===CPU===
4
cpu  1200 0 600 9200 0 0 0 0 0 0
===MEM===
MemTotal:        8192000 kB
MemAvailable:    4096000 kB
SwapTotal:       2048000 kB
SwapFree:        1536000 kB
===NET===
    lo: 10500 102 0 0 0 0 0 0 10500 102 0 0 0 0 0 0
  eth0: 104096 105 0 0 0 0 0 0 52048 84 0 0 0 0 0 0
===DISK===
Filesystem     Type 1B-blocks        Used   Available Capacity Mounted on
/dev/sda1      ext4 107374182400 53687091200 53687091200      50% /
===PROC===
  101 12.5 102400 nginx
  202  3.2  51200 postgres
";

    let t0 = std::time::Instant::now();
    let mut prev = RemotePrevCounters::default();
    let first = parse_remote_probe_output(sample_1, "10.0.0.1", &mut prev, t0);
    assert_eq!(first.hostname, "prod-node-01");
    assert_eq!(first.cpu_cores, 4);
    assert_eq!(first.mem_total_bytes, 8192000 * 1024);
    assert_eq!(first.mem_used_bytes, 4096000 * 1024);
    assert_eq!(first.disks.len(), 1);
    assert_eq!(first.disks[0].mount_point, "/");

    let t1 = t0 + Duration::from_secs(2);
    let second = parse_remote_probe_output(sample_2, "10.0.0.1", &mut prev, t1);
    // delta total = (1200+600+9200) - (1000+500+8500) = 1000, delta idle = 700 => 30%
    assert!((second.cpu_usage_percent - 30.0).abs() < 0.1);
    assert_eq!(second.net_rx_bytes_per_sec, 2048);
    assert_eq!(second.net_tx_bytes_per_sec, 1024);
    assert_eq!(second.top_processes[0].name, "nginx");
}
