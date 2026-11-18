use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("PTY error: {0}")]
    PtyError(String),

    #[error("SSH error: {0}")]
    SshError(String),

    #[error("Authentication failed: {0}")]
    AuthFailed(String),

    #[error("SFTP error: {0}")]
    SftpError(String),

    #[error("Storage error: {0}")]
    StorageError(String),

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),
}

#[derive(Debug, Serialize)]
struct SerializedError<'a> {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
}

impl CoreError {
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::PtyError(_) => "PTY_ERROR",
            CoreError::SshError(_) => "SSH_ERROR",
            CoreError::AuthFailed(_) => "AUTH_FAILED",
            CoreError::SftpError(_) => "SFTP_ERROR",
            CoreError::StorageError(_) => "STORAGE_ERROR",
            CoreError::SessionNotFound(_) => "SESSION_NOT_FOUND",
            CoreError::InvalidInput(_) => "INVALID_INPUT",
        }
    }
}

impl Serialize for CoreError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let payload = SerializedError {
            code: self.code(),
            message: self.to_string(),
            detail: None,
        };
        payload.serialize(serializer)
    }
}

pub type CoreResult<T> = Result<T, CoreError>;
