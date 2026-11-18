use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use parking_lot::Mutex;
use russh::client;
use russh::keys::{decode_secret_key, load_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::ChannelMsg;
use tokio::sync::mpsc;

use crate::error::{CoreError, CoreResult};
use crate::events::CoreEventSink;
use crate::models::{AuthMethod, HostConfig, SessionStatus};

pub struct SshClientHandler;

impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub fn expand_tilde(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    } else if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(trimmed)
}

#[derive(Default)]
pub struct SshConnectionPool {
    handles: Mutex<HashMap<String, Arc<client::Handle<SshClientHandler>>>>,
}

impl SshConnectionPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn invalidate(&self, host_id: &str) {
        self.handles.lock().remove(host_id);
    }

    pub async fn get_or_connect(
        &self,
        host: &HostConfig,
    ) -> CoreResult<Arc<client::Handle<SshClientHandler>>> {
        if let Some(existing) = self.handles.lock().get(&host.id).cloned() {
            if !existing.is_closed() {
                return Ok(existing);
            }
            self.handles.lock().remove(&host.id);
        }

        let handle = connect_host(host).await?;
        self.handles
            .lock()
            .insert(host.id.clone(), Arc::clone(&handle));
        Ok(handle)
    }
}

pub async fn connect_host(host: &HostConfig) -> CoreResult<Arc<client::Handle<SshClientHandler>>> {
    if host.host.trim().is_empty() {
        return Err(CoreError::InvalidInput("Host address cannot be empty".to_string()));
    }
    if host.username.trim().is_empty() {
        return Err(CoreError::InvalidInput("Username cannot be empty".to_string()));
    }
    if host.port == 0 {
        return Err(CoreError::InvalidInput("Port must be greater than 0".to_string()));
    }

    let mut config = client::Config::default();
    config.keepalive_interval = Some(Duration::from_secs(30));
    config.inactivity_timeout = Some(Duration::from_secs(3600));
    let config = Arc::new(config);

    let addr = (host.host.trim(), host.port);
    let mut handle = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(config, addr, SshClientHandler),
    )
    .await
    .map_err(|_| CoreError::SshError(format!("Connection to {}:{} timed out", host.host, host.port)))?
    .map_err(|e| CoreError::SshError(format!("Failed to connect to {}:{}: {e}", host.host, host.port)))?;

    match &host.auth {
        AuthMethod::Password { password } => {
            let pwd = password.as_deref().unwrap_or("");
            let auth_res = handle
                .authenticate_password(host.username.trim(), pwd)
                .await
                .map_err(|e| CoreError::AuthFailed(format!("Password auth error: {e}")))?;

            if !auth_res.success() {
                return Err(CoreError::AuthFailed(
                    "Server rejected username or password".to_string(),
                ));
            }
        }
        AuthMethod::PrivateKey {
            key_path,
            private_key_pem,
            passphrase,
        } => {
            let pass = passphrase.as_deref().filter(|s| !s.is_empty());
            let key = if let Some(pem) = private_key_pem.as_deref().filter(|s| !s.trim().is_empty())
            {
                decode_secret_key(pem, pass)
                    .map_err(|e| CoreError::AuthFailed(format!("Failed to decode private key: {e}")))?
            } else if let Some(path_str) = key_path.as_deref().filter(|s| !s.trim().is_empty()) {
                let expanded = expand_tilde(path_str);
                load_secret_key(&expanded, pass).map_err(|e| {
                    CoreError::AuthFailed(format!(
                        "Failed to load key '{}': {e}",
                        expanded.display()
                    ))
                })?
            } else {
                let default_ed = expand_tilde("~/.ssh/id_ed25519");
                let default_rsa = expand_tilde("~/.ssh/id_rsa");
                if default_ed.exists() {
                    load_secret_key(&default_ed, pass).map_err(|e| {
                        CoreError::AuthFailed(format!("Failed to load ~/.ssh/id_ed25519: {e}"))
                    })?
                } else if default_rsa.exists() {
                    load_secret_key(&default_rsa, pass).map_err(|e| {
                        CoreError::AuthFailed(format!("Failed to load ~/.ssh/id_rsa: {e}"))
                    })?
                } else {
                    return Err(CoreError::InvalidInput(
                        "No private key path or PEM content provided".to_string(),
                    ));
                }
            };

            let rsa_hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|e| CoreError::SshError(format!("RSA hash negotiation failed: {e}")))?
                .flatten();

            let auth_res = handle
                .authenticate_publickey(
                    host.username.trim(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash),
                )
                .await
                .map_err(|e| CoreError::AuthFailed(format!("Public key auth error: {e}")))?;

            if !auth_res.success() {
                return Err(CoreError::AuthFailed(
                    "Server rejected public key authentication".to_string(),
                ));
            }
        }
    }

    Ok(Arc::new(handle))
}

enum SshPtyCommand {
    Write(Vec<u8>),
    Resize(u16, u16),
    Close,
}

pub struct SshPtyHandle {
    tx: mpsc::UnboundedSender<SshPtyCommand>,
}

impl SshPtyHandle {
    pub fn write(&self, data: &[u8]) -> CoreResult<()> {
        self.tx
            .send(SshPtyCommand::Write(data.to_vec()))
            .map_err(|_| CoreError::SshError("SSH session channel closed".to_string()))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> CoreResult<()> {
        let _ = self.tx.send(SshPtyCommand::Resize(cols.max(1), rows.max(1)));
        Ok(())
    }

    pub fn close(&self) -> CoreResult<()> {
        let _ = self.tx.send(SshPtyCommand::Close);
        Ok(())
    }
}

pub async fn spawn_ssh_pty(
    session_id: String,
    pool: Arc<SshConnectionPool>,
    host: &HostConfig,
    cols: u16,
    rows: u16,
    sink: Arc<dyn CoreEventSink>,
) -> CoreResult<SshPtyHandle> {
    sink.on_terminal_status(&session_id, SessionStatus::Connecting, None);

    let handle = match pool.get_or_connect(host).await {
        Ok(h) => h,
        Err(err) => {
            sink.on_terminal_status(&session_id, SessionStatus::Error, Some(err.to_string()));
            return Err(err);
        }
    };

    let channel = match handle.channel_open_session().await {
        Ok(ch) => ch,
        Err(_) => {
            // Connection may have gone stale; invalidate and retry once.
            pool.invalidate(&host.id);
            let fresh = pool.get_or_connect(host).await.map_err(|err| {
                sink.on_terminal_status(&session_id, SessionStatus::Error, Some(err.to_string()));
                err
            })?;
            fresh.channel_open_session().await.map_err(|e| {
                let err = CoreError::SshError(format!("Failed to open SSH channel: {e}"));
                sink.on_terminal_status(&session_id, SessionStatus::Error, Some(err.to_string()));
                err
            })?
        }
    };

    channel
        .request_pty(
            true,
            "xterm-256color",
            cols.max(1) as u32,
            rows.max(1) as u32,
            0,
            0,
            &[],
        )
        .await
        .map_err(|e| {
            let err = CoreError::SshError(format!("Failed to request remote PTY: {e}"));
            sink.on_terminal_status(&session_id, SessionStatus::Error, Some(err.to_string()));
            err
        })?;

    channel.request_shell(true).await.map_err(|e| {
        let err = CoreError::SshError(format!("Failed to request remote shell: {e}"));
        sink.on_terminal_status(&session_id, SessionStatus::Error, Some(err.to_string()));
        err
    })?;

    sink.on_terminal_status(&session_id, SessionStatus::Connected, None);

    if let Some(startup) = host.startup_command.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let cmd_bytes = format!("{startup}\n").into_bytes();
        let _ = channel.data_bytes(cmd_bytes).await;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<SshPtyCommand>();
    let (mut read_half, write_half) = channel.split();
    let sid = session_id.clone();

    tokio::spawn(async move {
        let mut exit_code: Option<u32> = None;
        loop {
            tokio::select! {
                maybe_msg = read_half.wait() => {
                    match maybe_msg {
                        Some(ChannelMsg::Data { data }) => {
                            if !data.is_empty() {
                                sink.on_terminal_output(&sid, BASE64.encode(&data));
                            }
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            if !data.is_empty() {
                                sink.on_terminal_output(&sid, BASE64.encode(&data));
                            }
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            exit_code = Some(exit_status);
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            break;
                        }
                        _ => {}
                    }
                }
                maybe_cmd = rx.recv() => {
                    match maybe_cmd {
                        Some(SshPtyCommand::Write(bytes)) => {
                            if let Err(err) = write_half.data_bytes(bytes).await {
                                tracing::debug!("SSH write error for {sid}: {err}");
                                break;
                            }
                        }
                        Some(SshPtyCommand::Resize(c, r)) => {
                            let _ = write_half.window_change(c as u32, r as u32, 0, 0).await;
                        }
                        Some(SshPtyCommand::Close) | None => {
                            let _ = write_half.eof().await;
                            let _ = write_half.close().await;
                            break;
                        }
                    }
                }
            }
        }

        sink.on_terminal_status(&sid, SessionStatus::Disconnected, None);
        sink.on_terminal_exit(&sid, exit_code);
    });

    Ok(SshPtyHandle { tx })
}
