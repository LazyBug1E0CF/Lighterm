use crate::models::{SessionStatus, SftpTransferProgress};

pub trait CoreEventSink: Send + Sync + 'static {
    fn on_terminal_output(&self, session_id: &str, data_base64: String);
    fn on_terminal_exit(&self, session_id: &str, exit_code: Option<u32>);
    fn on_terminal_status(&self, session_id: &str, status: SessionStatus, message: Option<String>);
    fn on_sftp_progress(&self, progress: SftpTransferProgress);
}

pub struct NoopEventSink;

impl CoreEventSink for NoopEventSink {
    fn on_terminal_output(&self, _session_id: &str, _data_base64: String) {}
    fn on_terminal_exit(&self, _session_id: &str, _exit_code: Option<u32>) {}
    fn on_terminal_status(
        &self,
        _session_id: &str,
        _status: SessionStatus,
        _message: Option<String>,
    ) {
    }
    fn on_sftp_progress(&self, _progress: SftpTransferProgress) {}
}
