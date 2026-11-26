use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;

use crate::auth::require_auth_response;
use crate::state::{ServerState, WsServerEvent};

#[derive(Deserialize)]
#[serde(tag = "type")]
enum WsClientMessage {
    #[serde(rename = "terminal:write", rename_all = "camelCase")]
    TerminalWrite {
        session_id: String,
        data_base64: String,
    },
    #[serde(rename = "terminal:resize", rename_all = "camelCase")]
    TerminalResize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "ping")]
    Ping,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Response {
    if !state.auth.is_authenticated(&headers) {
        return require_auth_response();
    }

    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<ServerState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut event_rx = state.event_tx.subscribe();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Consume the immediate first tick so we don't send a ping right at connect.
    heartbeat.tick().await;

    loop {
        tokio::select! {
            recv_res = event_rx.recv() => {
                match recv_res {
                    Ok(ev) => {
                        if let Ok(json) = serde_json::to_string(&ev) {
                            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(RecvError::Lagged(skipped)) => {
                        tracing::warn!("WebSocket client lagged by {skipped} events");
                    }
                    Err(RecvError::Closed) => break,
                }
            }
            _ = heartbeat.tick() => {
                if ws_tx.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
            inbound = ws_rx.next() => {
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<WsClientMessage>(&text) {
                            Ok(WsClientMessage::TerminalWrite { session_id, data_base64 }) => {
                                if let Err(err) = state.core.sessions.write_base64(&session_id, &data_base64) {
                                    tracing::debug!("WS terminal:write error for {session_id}: {err}");
                                }
                            }
                            Ok(WsClientMessage::TerminalResize { session_id, cols, rows }) => {
                                if let Err(err) = state.core.sessions.resize(&session_id, cols, rows) {
                                    tracing::debug!("WS terminal:resize error for {session_id}: {err}");
                                }
                            }
                            Ok(WsClientMessage::Ping) => {
                                let pong = WsServerEvent {
                                    event: "pong".to_string(),
                                    payload: serde_json::Value::Null,
                                };
                                if let Ok(json) = serde_json::to_string(&pong) {
                                    if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Err(err) => {
                                tracing::debug!("Ignoring malformed WS client message: {err}");
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        if ws_tx.send(Message::Pong(data)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        tracing::debug!("WebSocket read error: {err}");
                        break;
                    }
                }
            }
        }
    }
}
