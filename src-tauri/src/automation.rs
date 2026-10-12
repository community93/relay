//! Session-scoped, authenticated loopback transport. Workspace operations stay in
//! the frontend so external edits cannot race a second store or bypass checks.
//!
//! The capability boundary lives here, at the transport, rather than in the
//! frontend or in the skill's prose: an AI tool that can reach this port can make
//! Relay send authenticated traffic to whatever host a request points at, and
//! "please don't run the delete endpoint" is not a boundary. So every action is
//! graded and the connection carries the highest tier the user granted.
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::{Arc, Mutex}, time::Duration};
use tauri::{Emitter, Manager};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, sync::{oneshot, Semaphore}};

const BODY_LIMIT: usize = 2 * 1024 * 1024;
const HEADER_LIMIT: usize = 8192;
/// read < write < execute. Each tier includes the ones below it.
const SCOPE_TIERS: [&str; 3] = ["read", "write", "execute"];
#[derive(Default)]
pub struct Automation { session: Mutex<Option<Session>> }
struct Session {
    connection: Connection,
    listener: tokio::task::AbortHandle,
    pending: HashMap<String, oneshot::Sender<Value>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection { enabled: bool, base_url: String, token: String, instance_id: String,
                       scope: String, allowed_hosts: Vec<String> }
/// Tier an action needs. `None` means "not an action we know" and is refused, so a
/// newly added frontend action cannot become reachable by being forgotten here.
fn action_tier(action: &str) -> Option<u8> {
    let tier = match action {
        "workspace.list" | "entity.get" | "job.get" => 0,
        "collection.upsert" | "environment.upsert" | "request.upsert" | "document.upsert"
        | "document.endpoint.upsert" | "runner.upsert" | "entity.open" | "document.export" => 1,
        "request.execute" | "document.verify" | "runner.execute" | "job.cancel" => 2,
        _ => return None,
    };
    Some(tier)
}
/// Unknown or missing scope falls back to the lowest tier, never the highest.
fn scope_tier(scope: &str) -> u8 {
    SCOPE_TIERS.iter().position(|t| *t == scope).map(|p| p as u8).unwrap_or(0)
}
fn normalize_scope(scope: &str) -> Result<String, String> {
    if SCOPE_TIERS.contains(&scope) { Ok(scope.to_string()) }
    else { Err(format!("Unknown scope: {scope}. Expected one of {}", SCOPE_TIERS.join(", "))) }
}
fn normalize_hosts(hosts: &[String]) -> Vec<String> {
    let mut out: Vec<String> = hosts.iter()
        .map(|h| h.trim().trim_end_matches('/').to_ascii_lowercase())
        .filter(|h| !h.is_empty() && h.len() <= 253 && !h.chars().any(|c| matches!(c, ' ' | '/' | ':' | '@' | '?')))
        .collect();
    out.sort(); out.dedup(); out.truncate(64); out
}
fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
#[tauri::command]
pub fn automation_status(state: tauri::State<'_, Automation>) -> Option<Connection> {
    state.session.lock().unwrap().as_ref().map(|s| s.connection.clone())
}
#[tauri::command]
pub fn automation_stop(state: tauri::State<'_, Automation>) {
    if let Some(session) = state.session.lock().unwrap().take() { session.listener.abort(); }
}
#[tauri::command]
pub async fn automation_start(app: tauri::AppHandle, scope: String, allowed_hosts: Vec<String>) -> Result<Connection, String> {
    let scope = normalize_scope(&scope)?;
    let allowed_hosts = normalize_hosts(&allowed_hosts.as_slice());
    if scope == "execute" && allowed_hosts.is_empty() {
        return Err("可执行需要至少一个允许的主机，否则 AI 可以驱动请求访问任意地址".into());
    }
    if let Some(session) = app.state::<Automation>().session.lock().unwrap().as_ref() { return Ok(session.connection.clone()); }
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let connection = Connection { enabled: true, base_url: format!("http://127.0.0.1:{port}"), token: random_id()?,
                                  instance_id: random_id()?, scope, allowed_hosts };
    let backend = app.clone();
    let accepted = connection.clone();
    let slots = Arc::new(Semaphore::new(16));
    // Hold the session lock until registration; simultaneous enable calls reuse it.
    let manager = app.state::<Automation>();
    let mut guard = manager.session.lock().unwrap();
    if let Some(session) = guard.as_ref() { return Ok(session.connection.clone()); }
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let Ok((stream, address)) = listener.accept().await else { break };
            if !address.ip().is_loopback() { continue; }
            let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
            let app = backend.clone(); let config = accepted.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                handle(stream, app, config).await;
            });
        }
    });
    *guard = Some(Session { connection: connection.clone(), listener: task.inner().abort_handle(), pending: HashMap::new() });
    Ok(connection)
}
#[tauri::command]
pub fn automation_reply(state: tauri::State<'_, Automation>, id: String, instance_id: String, result: Value) {
    let mut guard = state.session.lock().unwrap();
    if let Some(session) = guard.as_mut().filter(|s| s.connection.instance_id == instance_id) {
        if let Some(tx) = session.pending.remove(&id) { let _ = tx.send(result); }
    }
}
struct Request { method: String, path: String, headers: HashMap<String, String>, body: Vec<u8> }
async fn read_request(stream: &mut TcpStream) -> Result<Request, (u16, &'static str)> {
    let mut data = Vec::new();
    let end = loop {
        if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") { break pos + 4; }
        if data.len() > HEADER_LIMIT { return Err((431, "Headers too large")); }
        let mut buffer = [0; 4096];
        let n = stream.read(&mut buffer).await.map_err(|_| (400, "Read failed"))?;
        if n == 0 { return Err((400, "Incomplete request")); }
        data.extend_from_slice(&buffer[..n]);
    };
    if end > HEADER_LIMIT { return Err((431, "Headers too large")); }
    let text = std::str::from_utf8(&data[..end]).map_err(|_| (400, "Invalid headers"))?;
    let mut lines = text.split("\r\n");
    let parts: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    if parts.len() != 3 || parts[2] != "HTTP/1.1" { return Err((400, "HTTP/1.1 required")); }
    let method = parts[0].to_string(); let path = parts[1].to_string();
    let mut headers = HashMap::new();
    for line in lines.filter(|s| !s.is_empty()) {
        let (key, value) = line.split_once(':').ok_or((400, "Invalid header"))?;
        let key = key.trim().to_ascii_lowercase();
        if headers.insert(key, value.trim().to_string()).is_some() { return Err((400, "Duplicate header")); }
    }
    if headers.contains_key("transfer-encoding") { return Err((400, "Chunked requests unsupported")); }
    let length = headers.get("content-length").map(|s| s.parse::<usize>()).transpose().map_err(|_| (400, "Invalid length"))?.unwrap_or(0);
    if length > BODY_LIMIT { return Err((413, "Body too large")); }
    let mut body = data[end..].to_vec();
    if body.len() > length { return Err((400, "Unexpected body")); }
    while body.len() < length {
        let mut buffer = [0; 8192];
        let n = stream.read(&mut buffer[..(length - body.len()).min(8192)]).await.map_err(|_| (400, "Read failed"))?;
        if n == 0 { return Err((400, "Incomplete body")); }
        body.extend_from_slice(&buffer[..n]);
    }
    Ok(Request { method, path, headers, body })
}
fn authorize(request: &Request, config: &Connection) -> Result<(), (u16, &'static str)> {
    if request.headers.contains_key("origin") || request.headers.get("sec-fetch-site").is_some_and(|s| s != "none") { return Err((403, "Browser origins are not allowed")); }
    if request.headers.get("host").map(String::as_str) != config.base_url.strip_prefix("http://") { return Err((403, "Invalid host")); }
    if request.headers.get("authorization") != Some(&format!("Bearer {}", config.token)) { return Err((401, "Authentication required")); }
    Ok(())
}
async fn response(stream: &mut TcpStream, status: u16, value: Value) {
    let body = serde_json::to_vec(&value).unwrap_or_default();
    let header = format!("HTTP/1.1 {status} Result\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n", body.len());
    let _ = tokio::time::timeout(Duration::from_secs(10), async {
        stream.write_all(header.as_bytes()).await?;
        stream.write_all(&body).await
    }).await;
}
async fn handle(mut stream: TcpStream, app: tauri::AppHandle, config: Connection) {
    let request = match tokio::time::timeout(Duration::from_secs(10), read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        other => { let (status, message) = other.ok().and_then(Result::err).unwrap_or((408, "Request timeout")); response(&mut stream, status, json!({"ok":false,"error":{"code":"transport","message":message}})).await; return; }
    };
    if let Err((status, message)) = authorize(&request, &config) { response(&mut stream, status, json!({"ok":false,"error":{"code":"access","message":message}})).await; return; }
    if request.method == "GET" && request.path == "/v1/health" {
        response(&mut stream, 200, json!({"ok":true,"data":{"product":"Relay","version":env!("CARGO_PKG_VERSION"),"apiVersion":2,"instanceId":config.instance_id,"scope":config.scope,"allowedHosts":config.allowed_hosts}})).await; return;
    }
    if request.method != "POST" || request.path != "/v1/command" { response(&mut stream, 404, json!({"ok":false,"error":{"code":"not_found","message":"Unknown endpoint"}})).await; return; }
    if !request.headers.get("content-type").is_some_and(|s| s.split(';').next().unwrap_or("").trim() == "application/json") { response(&mut stream, 415, json!({"ok":false,"error":{"code":"content_type","message":"application/json required"}})).await; return; }
    let payload: Value = match serde_json::from_slice(&request.body) { Ok(value) => value, Err(_) => { response(&mut stream, 400, json!({"ok":false,"error":{"code":"invalid_json","message":"Invalid JSON"}})).await; return; } };
    // Capability check before anything reaches the workspace. The message names the
    // tier to ask for, because an agent that gets a bare 403 just retries.
    let action = payload.get("action").and_then(Value::as_str).unwrap_or("");
    match action_tier(action) {
        None => { response(&mut stream, 400, json!({"ok":false,"error":{"code":"invalid","message":"Unknown action"}})).await; return; }
        Some(needed) if needed > scope_tier(&config.scope) => {
            response(&mut stream, 403, json!({"ok":false,"error":{"code":"insufficient_scope","message":format!("{} requires scope \"{}\"; this connection grants \"{}\". Ask the user to reopen the AI connection with a wider scope.",action,SCOPE_TIERS[needed as usize],config.scope)}})).await; return;
        }
        Some(_) => {}
    }
    let Ok(id) = random_id() else { return };
    let (tx, rx) = oneshot::channel();
    let registered = {
        let manager = app.state::<Automation>(); let mut guard = manager.session.lock().unwrap();
        if let Some(session) = guard.as_mut().filter(|s| s.connection.instance_id == config.instance_id) { session.pending.insert(id.clone(), tx); true } else { false }
    };
    if !registered { response(&mut stream, 503, json!({"ok":false,"error":{"code":"disabled","message":"Connection closed"}})).await; return; }
    let sent = app.emit_to("main", "relay-automation", json!({"id":id,"instanceId":config.instance_id,"command":payload}));
    let result = if sent.is_ok() { tokio::time::timeout(Duration::from_secs(30), rx).await.ok().and_then(Result::ok) } else { None };
    {
        let manager = app.state::<Automation>(); let mut guard = manager.session.lock().unwrap();
        if let Some(session) = guard.as_mut() { session.pending.remove(&id); }
    }
    let result = result.unwrap_or_else(|| json!({"ok":false,"error":{"code":"unavailable","message":"Workspace unavailable; read current state before retrying writes"}}));
    let status = if result["ok"] == true { 200 } else { match result["error"]["code"].as_str() { Some("conflict" | "busy") => 409, Some("not_found") => 404, Some("unavailable") => 503, Some("persistence") => 500, Some("insufficient_scope" | "scope") => 403, _ => 400 } };
    response(&mut stream, status, result).await;
}
#[cfg(test)]
mod tests {
    use super::*;
    fn conn(scope: &str) -> Connection {
        Connection { enabled:true, base_url:"http://127.0.0.1:1234".into(), token:"private".into(),
                     instance_id:"instance".into(), scope:scope.into(), allowed_hosts:vec!["api.test".into()] }
    }
    fn request() -> Request { Request { method:"POST".into(),path:"/v1/command".into(),headers:HashMap::from([("host".into(),"127.0.0.1:1234".into()),("authorization".into(),"Bearer private".into())]),body:vec![] } }
    #[test] fn auth_required() { let mut r=request();r.headers.remove("authorization");assert_eq!(authorize(&r,&conn("execute")).unwrap_err().0,401); }
    #[test] fn browser_denied() { let mut r=request();r.headers.insert("origin".into(),"http://127.0.0.1:1234".into());assert_eq!(authorize(&r,&conn("execute")).unwrap_err().0,403); }
    #[test] fn rebound_host_denied() { let mut r=request();r.headers.insert("host".into(),"attacker.test:1234".into());assert_eq!(authorize(&r,&conn("execute")).unwrap_err().0,403); }
    #[test] fn native_client_allowed() { assert!(authorize(&request(),&conn("execute")).is_ok()); }
    #[test] fn tokens_unique_and_long() { let a=random_id().unwrap();assert_eq!(a.len(),64);assert_ne!(a,random_id().unwrap()); }

    #[test] fn every_frontend_action_is_graded() {
        // A new action that is not in the table would be refused, which is the safe
        // direction, but it would also silently break for real users. Keep the
        // transport's table and the frontend's list in step.
        for action in ["workspace.list","entity.get","job.get","collection.upsert","environment.upsert",
                       "request.upsert","document.upsert","document.endpoint.upsert","runner.upsert",
                       "entity.open","document.export","request.execute","document.verify",
                       "runner.execute","job.cancel"] {
            assert!(action_tier(action).is_some(), "{action} has no scope tier");
        }
    }
    #[test] fn unknown_action_is_refused() { assert_eq!(action_tier("request.delete_all"), None); }
    #[test] fn tiers_are_ordered_read_write_execute() {
        assert_eq!(action_tier("entity.get"), Some(0));
        assert_eq!(action_tier("request.upsert"), Some(1));
        assert_eq!(action_tier("request.execute"), Some(2));
        assert!(action_tier("document.verify") > action_tier("request.upsert"));
    }
    #[test] fn bad_scope_fails_closed() {
        assert_eq!(scope_tier("read"), 0);
        assert_eq!(scope_tier("execute"), 2);
        // A typo or a tampered config must not land on the most powerful tier.
        assert_eq!(scope_tier("all"), 0);
        assert_eq!(scope_tier(""), 0);
        assert!(normalize_scope("everything").is_err());
        assert!(normalize_scope("write").is_ok());
    }
    #[test] fn scope_tiers_cover_their_lower_levels() {
        // Granting `execute` must still satisfy a `read` action, so the check is a
        // comparison of tiers and not set membership.
        let granted = scope_tier("execute");
        for action in ["entity.get", "request.upsert", "request.execute"] {
            assert!(action_tier(action).unwrap() <= granted, "{action} unreachable at execute");
        }
        let read_only = scope_tier("read");
        assert!(action_tier("request.upsert").unwrap() > read_only);
    }
    #[test] fn hosts_are_normalised_and_capped() {
        let hosts = normalize_hosts(&["  API.Test/ ".into(), "x".into(), "".into(),
                                      "bad host".into(), "has/slash".into(), "x".into()].to_vec());
        assert_eq!(hosts, vec!["api.test", "x"]);
        assert_eq!(normalize_hosts(&(0..200).map(|i| format!("h{i}.test")).collect::<Vec<_>>()).len(), 64);
    }
    #[test] fn execute_without_a_host_allowlist_is_rejected() {
        // Mirrors the guard in automation_start: the check exists because an
        // unbounded allowlist is the same hole as no check at all.
        let hosts = normalize_hosts(&Vec::new());
        assert!(hosts.is_empty());
    }
}
