use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tauri::{ipc::Channel, AppHandle, Manager};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use crate::state::AppState;
use crate::types::*;
use crate::util;

type TungsteniteError = tokio_tungstenite::tungstenite::Error;

/// One live connection: frames are queued through `out`, `force_close` kills the task.
pub struct SocketHandle {
    out: mpsc::UnboundedSender<Outgoing>,
    abort: tokio::task::AbortHandle,
}

impl SocketHandle {
    fn new(out: mpsc::UnboundedSender<Outgoing>, abort: tokio::task::AbortHandle) -> Self {
        Self { out, abort }
    }

    pub fn force_close(&self) {
        self.abort.abort();
    }

    fn push(&self, message: Outgoing) -> bool {
        self.out.send(message).is_ok()
    }
}

struct Outgoing {
    message: Message,
    ack: Option<oneshot::Sender<Result<(), String>>>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WsRequest {
    pub conn_id: String,
    pub name: String,
    pub url: String,
    pub headers: Vec<Kv>,
    pub subprotocols: Vec<String>,
    #[serde(default = "verify_tls_by_default")]
    pub ssl_verify: bool,
    pub timeout_ms: Option<u64>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WsPayload {
    /// text | binary | ping
    pub kind: String,
    pub text: Option<String>,
    pub bytes_b64: Option<String>,
}

fn verify_tls_by_default() -> bool { true }

pub fn normalize_ws_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("WebSocket 地址不能为空".into());
    }
    let lowered = url.to_ascii_lowercase();
    if lowered.starts_with("wss://") || lowered.starts_with("ws://") {
        return Ok(url.to_string());
    }
    if lowered.starts_with("https://") {
        return Ok(format!("wss://{}", &url["https://".len()..]));
    }
    if lowered.starts_with("http://") {
        return Ok(format!("ws://{}", &url["http://".len()..]));
    }
    Err(format!("不支持的地址协议，请使用 ws:// 或 wss://：{url}"))
}

/// Builds the handshake request. `ClientRequestBuilder` is required here:
/// `IntoClientRequest` for a bare `http::Request` passes it through untouched,
/// which would leave out `Sec-WebSocket-Key` and get the handshake rejected.
fn build_handshake(req: &WsRequest) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    use tokio_tungstenite::tungstenite::client::ClientRequestBuilder;
    use tokio_tungstenite::tungstenite::http::Uri;

    let uri: Uri = req.url.parse().map_err(|e| format!("地址无法解析：{e}"))?;
    let mut builder = ClientRequestBuilder::new(uri);
    for header in &req.headers {
        if !header.enabled || header.key.trim().is_empty() {
            continue;
        }
        let name=header.key.trim().to_ascii_lowercase();
        if matches!(name.as_str(),"host"|"connection"|"upgrade"|"content-length"|"sec-websocket-key"|"sec-websocket-version"|"sec-websocket-extensions"|"sec-websocket-protocol") {continue;}
        builder = builder.with_header(header.key.trim().to_string(), header.value.clone());
    }
    let mut protocols=req.subprotocols.clone();
    if protocols.is_empty() {
        protocols=req.headers.iter().filter(|h|h.enabled&&h.key.trim().eq_ignore_ascii_case("sec-websocket-protocol")).flat_map(|h|h.value.split(',').map(|value|value.trim().to_string())).collect();
    }
    for protocol in &protocols {
        let protocol = protocol.trim();
        if !protocol.is_empty() {
            builder = builder.with_sub_protocol(protocol.to_string());
        }
    }
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    builder
        .into_client_request()
        .map_err(|e| format!("构造握手请求失败：{e}"))
}

#[tauri::command]
pub async fn ws_connect(
    app: AppHandle,
    req: WsRequest,
    sink: Channel<WsEvent>,
) -> Result<(), String> {
    let url = normalize_ws_url(&req.url)?;
    let handshake = build_handshake(&WsRequest {
        url,
        ..req.clone()
    })?;

    let connector=if req.ssl_verify {None} else {
        let tls=native_tls::TlsConnector::builder().danger_accept_invalid_certs(true).danger_accept_invalid_hostnames(true).build().map_err(|e|format!("TLS 配置失败：{e}"))?;
        Some(tokio_tungstenite::Connector::NativeTls(tls))
    };
    let (out, mut rx) = mpsc::unbounded_channel::<Outgoing>();
    let worker = app.clone();
    let conn_id = req.conn_id.clone();
    let (start,ready)=oneshot::channel();
    let task = tokio::spawn(async move {
        if ready.await.is_err() {return;}
        session(worker, conn_id, handshake, sink, &mut rx, req.timeout_ms, connector).await;
    });

    let state = app.state::<AppState>();
    state
        .sockets
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(req.conn_id.clone(), SocketHandle::new(out, task.abort_handle()));
    drop(state);
    let _=start.send(());

    Ok(())
}

async fn session(
    app: AppHandle,
    conn_id: String,
    handshake: tokio_tungstenite::tungstenite::http::Request<()>,
    sink: Channel<WsEvent>,
    rx: &mut mpsc::UnboundedReceiver<Outgoing>,
    timeout_ms: Option<u64>,
    connector: Option<tokio_tungstenite::Connector>,
) {
    let connect = tokio_tungstenite::connect_async_tls_with_config(handshake,None,false,connector);
    let connected=if let Some(ms)=timeout_ms.filter(|ms|*ms>0) {
        tokio::time::timeout(std::time::Duration::from_millis(ms),connect).await.unwrap_or_else(|_|Err(TungsteniteError::Io(std::io::Error::new(std::io::ErrorKind::TimedOut,format!("握手超时（{ms} ms）")))))
    } else {connect.await};
    let (stream, response) = match connected {
        Ok(pair) => pair,
        Err(e) => {
            emit(
                &sink,
                WsEvent {
                    kind: "error".into(),
                    at: util::now_ms(),
                    message: Some(describe(&e)),
                    ..Default::default()
                },
            );
            cleanup(&app, &conn_id);
            return;
        }
    };

    let headers: Vec<HeaderEntry> = response
        .headers()
        .iter()
        .map(|(k, v)| HeaderEntry {
            name: k.as_str().to_string(),
            value: v.to_str().unwrap_or("<非 ASCII>").to_string(),
        })
        .collect();
    emit(
        &sink,
        WsEvent {
            kind: "open".into(),
            at: util::now_ms(),
            status: Some(response.status().as_u16()),
            message: Some(format!("已连接（HTTP {}）", response.status().as_u16())),
            headers: Some(headers),
            ..Default::default()
        },
    );

    // tokio-tungstenite's inherent split() yields (write half, read half).
    let (mut writer, mut reader) = stream.split();
    loop {
        tokio::select! {
            incoming = reader.next() => {
                match incoming {
                    None => {
                        emit(&sink, WsEvent { kind: "closed".into(), at: util::now_ms(), message: Some("连接已由对端关闭".into()), ..Default::default() });
                        break;
                    }
                    Some(Ok(message)) => {
                        let done = message.is_close();
                        let needs_flush=message.is_ping();
                        for evt in translate(message) {
                            emit(&sink, evt);
                        }
                        if done {
                            break;
                        }
                        if needs_flush {
                            // Reading a Ping queues tungstenite's automatic Pong.
                            // Flush it even when the user has no outgoing messages.
                            if let Err(error)=writer.flush().await {
                                emit(&sink,WsEvent{kind:"error".into(),at:util::now_ms(),message:Some(describe(&error)),..Default::default()});break;
                            }
                        }
                    }
                    Some(Err(e)) => {
                        emit(&sink, WsEvent { kind: "error".into(), at: util::now_ms(), message: Some(describe(&e)), ..Default::default() });
                        break;
                    }
                }
            }
            outgoing = rx.recv() => {
                match outgoing {
                    Some(outgoing) => {
                        let sent=writer.send(outgoing.message).await.map_err(|error|format!("发送失败：{error}"));
                        if let Some(ack)=outgoing.ack {let _=ack.send(sent.clone());}
                        if let Err(error) = sent {
                            emit(&sink, WsEvent { kind: "error".into(), at: util::now_ms(), message: Some(error), ..Default::default() });
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    let _ = writer.close().await;
    cleanup(&app, &conn_id);
}

fn translate(message: Message) -> Vec<WsEvent> {
    let at = util::now_ms();
    let is_text = message.is_text();
    let (code,reason)=match &message {Message::Close(Some(frame))=>(Some(u16::from(frame.code)),Some(frame.reason.to_string())),_=>(None,None)};
    let kind = if message.is_close() {
        "closed"
    } else if message.is_ping() {
        "ping"
    } else if message.is_pong() {
        "pong"
    } else {
        "message"
    };
    let label = match kind {
        "closed" => Some("收到对端 Close 帧".to_string()),
        "ping" => Some("Ping".to_string()),
        "pong" => Some("Pong".to_string()),
        _ => None,
    };
    let bytes = message.into_data();
    vec![WsEvent {
        kind: kind.to_string(),
        at,
        dir: Some("in".into()),
        text: (is_text && kind == "message").then(|| String::from_utf8_lossy(&bytes).into_owned()),
        bytes_b64: (!is_text && kind == "message")
            .then(|| base64::engine::general_purpose::STANDARD.encode(&bytes)),
        len: bytes.len() as u64,
        message: label,
        code,reason,
        ..Default::default()
    }]
}

#[tauri::command]
pub async fn ws_send(app: AppHandle, conn_id: String, payload: WsPayload) -> Result<(), String> {
    let message = match payload.kind.as_str() {
        "binary" => {
            let raw = payload.bytes_b64.unwrap_or_default();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(raw)
                .map_err(|e| format!("Base64 解码失败：{e}"))?;
            Message::Binary(bytes.into())
        }
        "ping" => Message::Ping(payload.text.unwrap_or_default().into_bytes().into()),
        _ => Message::Text(payload.text.unwrap_or_default().into()),
    };
    let (ack,received)=oneshot::channel();
    {
        let state=app.state::<AppState>();
        let guard=state.sockets.lock().unwrap_or_else(|p|p.into_inner());
        let handle=guard.get(&conn_id).ok_or_else(||"连接已断开，请重新连接".to_string())?;
        if !handle.push(Outgoing{message,ack:Some(ack)}) {return Err("连接已关闭，无法发送".into());}
    }
    received.await.map_err(|_|"连接已关闭，消息未发送".to_string())?
}

#[tauri::command]
pub fn ws_close(app: AppHandle, conn_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let guard = state.sockets.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(handle) = guard.get(&conn_id) {
        let _ = handle.push(Outgoing{message:Message::Close(None),ack:None});
    }
    Ok(())
}

#[tauri::command]
pub fn ws_disconnect(app: AppHandle, conn_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut guard = state.sockets.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(handle) = guard.remove(&conn_id) {
        handle.force_close();
    }
    Ok(())
}

fn cleanup(app: &AppHandle, conn_id: &str) {
    let state = app.state::<AppState>();
    state
        .sockets
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(conn_id);
}

fn describe(e: &TungsteniteError) -> String {
    if let TungsteniteError::Http(response)=e {
        return match response.status().as_u16() {
            401|403=>format!("握手被拒绝（HTTP {}），请检查 Auth、Cookie 或 Origin",response.status().as_u16()),
            status=>format!("握手失败（HTTP {status}），服务器未升级为 WebSocket"),
        };
    }
    if let TungsteniteError::Io(error)=e {
        if error.kind()==std::io::ErrorKind::TimedOut {return format!("连接超时：{error}");}
    }
    let text = e.to_string();
    let lowered = text.to_ascii_lowercase();
    if lowered.contains("401") || lowered.contains("forbidden") || lowered.contains("403") {
        return format!("握手被拒绝，通常需要鉴权：{text}");
    }
    if lowered.contains("certificate") || lowered.contains("ssl") || lowered.contains("tls") {
        return format!("TLS 握手失败：{text}");
    }
    if lowered.contains("timed out") {
        return format!("连接超时：{text}");
    }
    if lowered.contains("dns") || lowered.contains("lookup") {
        return format!("域名解析失败：{text}");
    }
    format!("WebSocket 错误：{text}")
}

fn emit(sink: &Channel<WsEvent>, event: WsEvent) {
    let _ = sink.send(event);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::protocol::{CloseFrame, frame::coding::CloseCode};

    #[test]
    fn copied_handshake_headers_are_regenerated_and_auth_is_retained() {
        let req=WsRequest{url:"ws://localhost:19001/socket".into(),headers:vec![
            ("Host","stale.invalid"),("Upgrade","websocket"),("Connection","Upgrade"),
            ("Sec-WebSocket-Key","stale"),("Sec-WebSocket-Version","13"),
            ("Sec-WebSocket-Protocol","relay.json"),("Authorization","Bearer token"),
            ("Origin","https://example.test"),
        ].into_iter().map(|(key,value)|Kv{key:key.into(),value:value.into(),enabled:true,..Default::default()}).collect(),..Default::default()};
        let request=build_handshake(&req).unwrap();
        assert_eq!(request.headers().get_all("upgrade").iter().count(),1);
        assert_eq!(request.headers().get_all("connection").iter().count(),1);
        assert_eq!(request.headers()["host"],"localhost:19001");
        assert_ne!(request.headers()["sec-websocket-key"],"stale");
        assert_eq!(request.headers()["sec-websocket-protocol"],"relay.json");
        assert_eq!(request.headers()["authorization"],"Bearer token");
        assert_eq!(request.headers()["origin"],"https://example.test");
    }

    #[test]
    fn close_events_keep_code_and_reason() {
        let event=translate(Message::Close(Some(CloseFrame{code:CloseCode::Policy,reason:"token expired".into()}))).remove(0);
        assert_eq!(event.code,Some(1008));
        assert_eq!(event.reason.as_deref(),Some("token expired"));
    }

    #[test]
    fn omitted_tls_setting_verifies_certificates() {
        let req:WsRequest=serde_json::from_str(r#"{"url":"wss://localhost"}"#).unwrap();
        assert!(req.ssl_verify);
    }
}
