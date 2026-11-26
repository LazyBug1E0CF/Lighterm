use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use bytes::Bytes;
use futures_util::{stream, StreamExt};
use lighterm_core::error::{CoreError, CoreResult};
use lighterm_core::models::HostConfig;
use lighterm_core::LightermCore;
use lighterm_plugin_sftp::SftpPlugin;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::auth::require_auth_response;
use crate::rpc::core_error_response;
use crate::state::ServerState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadQuery {
    pub host_id: String,
    pub remote_path: String,
    pub file_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadQuery {
    pub host_id: String,
    pub remote_path: String,
}

#[derive(Serialize)]
struct UploadOk {
    ok: bool,
}

fn resolve_host(core: &LightermCore, host_id: &str) -> CoreResult<HostConfig> {
    core.storage
        .get_host(host_id)?
        .ok_or_else(|| CoreError::InvalidInput(format!("Host '{host_id}' not found")))
}

fn header_u64(headers: &HeaderMap, name: &str) -> Option<u64> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

fn percent_encode_rfc5987(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        let is_unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'!' | b'#' | b'$' | b'&' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~'
            );
        if is_unreserved {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn ascii_filename_fallback(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn build_content_disposition(file_name: &str) -> String {
    let fallback = ascii_filename_fallback(file_name);
    let encoded = percent_encode_rfc5987(file_name);
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

pub async fn sftp_upload_handler(
    State(state): State<Arc<ServerState>>,
    Query(query): Query<UploadQuery>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !state.auth.is_authenticated(&headers) {
        return require_auth_response();
    }

    let sftp = match state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp") {
        Ok(p) => p,
        Err(err) => return core_error_response(err),
    };
    let host = match resolve_host(&state.core, &query.host_id) {
        Ok(h) => h,
        Err(err) => return core_error_response(err),
    };

    let total_bytes = header_u64(&headers, "x-file-size")
        .or_else(|| header_u64(&headers, "content-length"))
        .unwrap_or(0);

    let file_name = query
        .file_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            query
                .remote_path
                .rsplit('/')
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or("upload")
                .to_string()
        });

    let (tx, rx) = mpsc::channel::<CoreResult<Vec<u8>>>(8);
    let mut data_stream = body.into_data_stream();

    let reader_task = tokio::spawn(async move {
        while let Some(chunk_res) = data_stream.next().await {
            match chunk_res {
                Ok(bytes) => {
                    if !bytes.is_empty() && tx.send(Ok(bytes.to_vec())).await.is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = tx
                        .send(Err(CoreError::PluginError(format!(
                            "HTTP upload stream failed: {err}"
                        ))))
                        .await;
                    break;
                }
            }
        }
    });

    let upload_res = sftp
        .upload_from_stream(
            &host,
            &query.remote_path,
            file_name,
            total_bytes,
            rx,
            state.event_sink.as_ref(),
        )
        .await;

    reader_task.abort();

    match upload_res {
        Ok(()) => (StatusCode::OK, Json(UploadOk { ok: true })).into_response(),
        Err(err) => core_error_response(err),
    }
}

pub async fn sftp_download_handler(
    State(state): State<Arc<ServerState>>,
    Query(query): Query<DownloadQuery>,
    headers: HeaderMap,
) -> Response {
    if !state.auth.is_authenticated(&headers) {
        return require_auth_response();
    }

    let sftp = match state.core.plugins.get_active::<SftpPlugin>("lighterm.sftp") {
        Ok(p) => p,
        Err(err) => return core_error_response(err),
    };
    let host = match resolve_host(&state.core, &query.host_id) {
        Ok(h) => h,
        Err(err) => return core_error_response(err),
    };

    let (total_bytes, rx) = match sftp
        .open_download_stream(&host, &query.remote_path, Arc::clone(&state.event_sink))
        .await
    {
        Ok(res) => res,
        Err(err) => return core_error_response(err),
    };

    let file_name = query
        .remote_path
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("download");

    let byte_stream = stream::unfold(rx, |mut rx| async move {
        match rx.recv().await {
            Some(Ok(bytes)) => Some((Ok::<Bytes, std::io::Error>(Bytes::from(bytes)), rx)),
            Some(Err(err)) => Some((
                Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    err.to_string(),
                )),
                rx,
            )),
            None => None,
        }
    });

    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        )
        .header(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        );

    if let Ok(cd) = HeaderValue::from_str(&build_content_disposition(file_name)) {
        resp = resp.header(header::CONTENT_DISPOSITION, cd);
    }

    if total_bytes > 0 {
        if let Ok(len_val) = HeaderValue::from_str(&total_bytes.to_string()) {
            resp = resp.header(header::CONTENT_LENGTH, len_val);
        }
    }

    resp.body(Body::from_stream(byte_stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
