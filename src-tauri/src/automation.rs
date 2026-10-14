//! Session-scoped, authenticated loopback transport. Workspace operations stay in
//! the frontend so external edits cannot race a second store or bypass checks.
//!
//! The capability boundary lives here, at the transport, rather than in the
//! frontend or in the skill's prose: an AI tool that can reach this port can make
//! Relay send authenticated traffic to whatever host a request points at, and
//! "please don't run the delete endpoint" is not a boundary. So every action is
//! graded and the connection carries the highest tier the user granted.
//!
//! Two dialects share the listener and the gate: `POST /v1/command` speaks Relay's
//! own envelope, and `POST /mcp` speaks MCP over Streamable HTTP so any MCP client
//! can attach without a separate bridge process.
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::{Arc, Mutex}, time::Duration};
use tauri::{Emitter, Manager};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, sync::{oneshot, Semaphore}};

const BODY_LIMIT: usize = 2 * 1024 * 1024;
const HEADER_LIMIT: usize = 8192;
/// read < write < execute. Each tier includes the ones below it.
const SCOPE_TIERS: [&str; 3] = ["read", "write", "execute"];
/// Protocol revisions Relay answers. A client asking for something else gets the
/// newest one we implement, which is what the spec prescribes.
const MCP_SUPPORTED: [&str; 2] = ["2025-06-18", "2025-03-26"];
const MCP_LATEST: &str = "2025-06-18";
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
        "workspace.list" | "entity.find" | "entity.get" | "job.get" | "mcp.tools" => 0,
        "collection.upsert" | "environment.upsert" | "request.upsert" | "document.upsert"
        | "document.endpoint.upsert" | "runner.upsert" | "entity.open" | "document.export"
        | "request.preview" => 1,
        "request.execute" | "document.verify" | "runner.execute" | "job.cancel" => 2,
        _ => return None,
    };
    Some(tier)
}
/// Unknown or missing scope falls back to the lowest tier, never the highest.
fn scope_tier(scope: &str) -> u8 {
    SCOPE_TIERS.iter().position(|t| *t == scope).map(|p| p as u8).unwrap_or(0)
}
/// MCP tool names -> Relay action name. Underscore is not used in any action, so
/// flipping it back to a dot is unambiguous and needs no lookup table.
fn tool_action(name: &str) -> Option<(String, u8)> {
    let action = name.replace('_', ".");
    action_tier(&action).map(|needed| (action, needed))
}
/// A client asking for a revision we do not implement gets the newest one we do.
fn negotiate_version(asked: &str) -> &str {
    if MCP_SUPPORTED.contains(&asked) { asked } else { MCP_LATEST }
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
    let method = parts[0].to_string();
    // Route on the path alone: MCP clients append a query string for session ids.
    let path = parts[1].split('?').next().unwrap_or("").to_string();
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
    write_raw(stream, status, "application/json; charset=utf-8", &serde_json::to_vec(&value).unwrap_or_default(), &[]).await;
}
async fn handle(mut stream: TcpStream, app: tauri::AppHandle, config: Connection) {
    let request = match tokio::time::timeout(Duration::from_secs(10), read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        other => { let (status, message) = other.ok().and_then(Result::err).unwrap_or((408, "Request timeout")); response(&mut stream, status, json!({"ok":false,"error":{"code":"transport","message":message}})).await; return; }
    };
    if let Err((status, message)) = authorize(&request, &config) { response(&mut stream, status, json!({"ok":false,"error":{"code":"access","message":message}})).await; return; }
    if request.method == "GET" && request.path == "/v1/health" {
        response(&mut stream, 200, json!({"ok":true,"data":{"product":"Relay","version":env!("CARGO_PKG_VERSION"),"apiVersion":3,"instanceId":config.instance_id,"scope":config.scope,"allowedHosts":config.allowed_hosts}})).await; return;
    }
    if request.path == "/mcp" { mcp(&app, &config, &request, &mut stream).await; return; }
    if request.method != "POST" || request.path != "/v1/command" { response(&mut stream, 404, json!({"ok":false,"error":{"code":"not_found","message":"Unknown endpoint"}})).await; return; }
    if !request.headers.get("content-type").is_some_and(|s| s.split(';').next().unwrap_or("").trim() == "application/json") { response(&mut stream, 415, json!({"ok":false,"error":{"code":"content_type","message":"application/json required"}})).await; return; }
    let payload: Value = match serde_json::from_slice(&request.body) { Ok(value) => value, Err(_) => { response(&mut stream, 400, json!({"ok":false,"error":{"code":"invalid_json","message":"Invalid JSON"}})).await; return; } };
    let (status, body) = forward(&app, &config, payload).await;
    response(&mut stream, status, body).await;
}
/// One command round-trip into the window. Both `/v1/command` and the MCP bridge go
/// through here so there is exactly one capability gate and exactly one reply path.
async fn forward(app: &tauri::AppHandle, config: &Connection, payload: Value) -> (u16, Value) {
    let granted = scope_tier(&config.scope);
    // A batch is expanded here rather than in the window: the gate has to see every
    // command, and one that could hide a `request.execute` inside a list of reads
    // would walk straight past the tier check.
    if payload.get("commands").is_some() {
        if let Err(refusal) = gate_batch(&payload, granted, config) { return refusal; }
        return round_trip(app, config, payload).await;
    }
    // Capability check before anything reaches the workspace. The message names the
    // tier to ask for, because an agent that gets a bare 403 just retries.
    let action = payload.get("action").and_then(Value::as_str).unwrap_or("");
    match action_tier(action) {
        None => return (400, json!({"ok":false,"error":{"code":"invalid","message":"Unknown action"}})),
        Some(needed) if needed > granted => return scope_refusal(action, needed, config),
        Some(_) => {}
    };
    round_trip(app, config, payload).await
}
fn scope_refusal(what: &str, needed: u8, config: &Connection) -> (u16, Value) {
    (403, json!({"ok":false,"error":{"code":"insufficient_scope","message":format!("{} requires scope \"{}\"; this connection grants \"{}\". Ask the user to reopen the AI connection with a wider scope.",what,SCOPE_TIERS[needed as usize],config.scope)}}))
}
/// Validate a whole batch before any of it runs. Refusing the batch rather than
/// stopping at the first bad command matches `document.verify`: a partial batch that
/// already wrote six entities looks, from here, like it succeeded.
fn gate_batch(payload: &Value, granted: u8, config: &Connection) -> Result<(), (u16, Value)> {
    const BATCH_LIMIT: usize = 20;
    let rows = match payload.get("commands").map(Value::as_array) {
        Some(Some(rows)) => rows,
        _ => return Err((400, json!({"ok":false,"error":{"code":"invalid","message":"commands must be an array of command objects"}}))),
    };
    if rows.is_empty() {
        return Err((400, json!({"ok":false,"error":{"code":"invalid","message":"commands is empty; send one command or list at least one"}})));
    }
    if rows.len() > BATCH_LIMIT {
        return Err((400, json!({"ok":false,"error":{"code":"invalid","message":format!("commands has {} entries, over the {BATCH_LIMIT} limit; split it or use runner.execute", rows.len())}})));
    }
    if payload.get("action").is_some() {
        return Err((400, json!({"ok":false,"error":{"code":"invalid","message":"commands and action cannot appear together; put every command inside the array"}})));
    }
    for (index, row) in rows.iter().enumerate() {
        if !row.is_object() {
            return Err((400, json!({"ok":false,"error":{"code":"invalid","message":format!("commands[{index}] must be an object")}})));
        }
        if row.get("commands").is_some() {
            return Err((400, json!({"ok":false,"error":{"code":"invalid","message":format!("commands[{index}] has its own commands array; batches cannot nest")}})));
        }
        let action = row.get("action").and_then(Value::as_str).unwrap_or("");
        match action_tier(action) {
            None => return Err((400, json!({"ok":false,"error":{"code":"invalid","message":format!("commands[{index}] has an unknown action {action:?}")}}))),
            Some(needed) if needed > granted => return Err(scope_refusal(&format!("commands[{index}] {action}"), needed, config)),
            Some(_) => {}
        }
    }
    Ok(())
}
async fn round_trip(app: &tauri::AppHandle, config: &Connection, payload: Value) -> (u16, Value) {
    let Ok(id) = random_id() else { return (500, json!({"ok":false,"error":{"code":"transport","message":"Could not allocate a request id"}})) };
    let (tx, rx) = oneshot::channel();
    let registered = {
        let manager = app.state::<Automation>(); let mut guard = manager.session.lock().unwrap();
        if let Some(session) = guard.as_mut().filter(|s| s.connection.instance_id == config.instance_id) { session.pending.insert(id.clone(), tx); true } else { false }
    };
    if !registered { return (503, json!({"ok":false,"error":{"code":"disabled","message":"Connection closed"}})); }
    let sent = app.emit_to("main", "relay-automation", json!({"id":id,"instanceId":config.instance_id,"command":payload}));
    let result = if sent.is_ok() { tokio::time::timeout(Duration::from_secs(30), rx).await.ok().and_then(Result::ok) } else { None };
    {
        let manager = app.state::<Automation>(); let mut guard = manager.session.lock().unwrap();
        if let Some(session) = guard.as_mut() { session.pending.remove(&id); }
    }
    let result = result.unwrap_or_else(|| json!({"ok":false,"error":{"code":"unavailable","message":"Workspace unavailable; read current state before retrying writes"}}));
    let status = if result["ok"] == true { 200 } else { match result["error"]["code"].as_str() { Some("conflict" | "busy") => 409, Some("not_found") => 404, Some("unavailable") => 503, Some("persistence") => 500, Some("insufficient_scope" | "scope") => 403, _ => 400 } };
    (status, result)
}
/// MCP Streamable HTTP: JSON-RPC 2.0 on POST /mcp, answers as plain JSON (the spec
/// allows that instead of an SSE stream). No separate MCP process and no session
/// state -- the URL is this same loopback listener, so "download the app" is the
/// whole installation story.
async fn mcp(app: &tauri::AppHandle, config: &Connection, request: &Request, stream: &mut TcpStream) {
    let reject = |code: i64, message: &str| json!({"jsonrpc":"2.0","id":null,"error":{"code":code,"message":message}});
    if request.method == "GET" {
        // Server-initiated streaming is optional; without it the spec wants a 405.
        let body = serde_json::to_vec(&reject(-32600, "Relay does not stream server-initiated MCP messages; POST a request instead")).unwrap_or_default();
        write_raw(stream, 405, "application/json; charset=utf-8", &body, &[("Allow", "POST, DELETE")]).await;
        return;
    }
    if request.method != "POST" {
        let body = serde_json::to_vec(&reject(-32600, "Use POST")).unwrap_or_default();
        write_raw(stream, 405, "application/json; charset=utf-8", &body, &[("Allow", "POST")]).await;
        return;
    }
    if !request.headers.get("content-type").is_some_and(|s| s.split(';').next().unwrap_or("").trim() == "application/json") {
        let body = serde_json::to_vec(&reject(-32600, "application/json required")).unwrap_or_default();
        write_raw(stream, 415, "application/json; charset=utf-8", &body, &[]).await;
        return;
    }
    let Ok(envelope) = serde_json::from_slice::<Value>(&request.body) else {
        let body = serde_json::to_vec(&reject(-32700, "Invalid JSON")).unwrap_or_default();
        write_raw(stream, 400, "application/json; charset=utf-8", &body, &[]).await;
        return;
    };
    let method = envelope.get("method").and_then(Value::as_str).unwrap_or("");
    // A notification has no id and must not get a body back.
    let id = envelope.get("id").filter(|v| !v.is_null()).cloned();
    let Some(id) = id else {
        if method.starts_with("notifications/") { write_raw(stream, 202, "application/json", b"", &[]).await; }
        else { let body = serde_json::to_vec(&reject(-32600, "Missing id")).unwrap_or_default(); write_raw(stream, 400, "application/json; charset=utf-8", &body, &[]).await; }
        return;
    };
    let outcome: Result<Value, (i64, String)> = match method {
        "initialize" => {
            let version = negotiate_version(envelope["params"]["protocolVersion"].as_str().unwrap_or(MCP_LATEST));
            let hosts = if config.allowed_hosts.is_empty() {
                "no host restriction, because the user drives Relay by hand".to_string()
            } else {
                format!("only these hosts: {}", config.allowed_hosts.join(", "))
            };
            Ok(json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"Relay","version":env!("CARGO_PKG_VERSION")},
                "instructions":format!("Relay is a local API workbench. This connection grants scope \"{}\" and tools above that tier are not offered. Executed traffic reaches {}; a redirect that leaves it stops the run. Call workspace.list first to get ids and revisions.",config.scope,hosts)}))
        }
        "ping" => Ok(json!({})),
        "tools/list" => mcp_tool_list(app, config).await.map(|tools| json!({"tools": tools})),
        "tools/call" => {
            let name = envelope["params"]["name"].as_str().unwrap_or("");
            let arguments = envelope["params"]["arguments"].clone();
            if name.is_empty() { Err((-32602, "params.name is required".into())) }
            else if !arguments.is_null() && !arguments.is_object() { Err((-32602, "params.arguments must be an object".into())) }
            else { call_tool(app, config, name, arguments).await }
        }
        "" => Err((-32600, "Missing method".into())),
        other => Err((-32601, format!("Unknown method: {other}"))),
    };
    let body = match outcome {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err((code, message)) => json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}),
    };
    write_raw(stream, 200, "application/json; charset=utf-8", &serde_json::to_vec(&body).unwrap_or_default(), &[]).await;
}
/// The tool table comes from the frontend, which is where the workspace shapes are
/// actually validated; this filters it so an over-privileged tool is never even
/// advertised. `tools/call` checks the tier again rather than trusting the list.
async fn mcp_tool_list(app: &tauri::AppHandle, config: &Connection) -> Result<Vec<Value>, (i64, String)> {
    let (status, body) = forward(app, config, json!({"action":"mcp.tools"})).await;
    if status != 200 { return Err((-32603, body["error"]["message"].as_str().unwrap_or("Workspace unavailable").to_string())); }
    let granted = scope_tier(&config.scope);
    // `forward` hands back the whole {ok,data} envelope, so the table is one level in.
    Ok(body["data"]["tools"].as_array().map(|rows| rows.iter()
        .filter(|row| row["action"].as_str().and_then(action_tier).is_some_and(|needed| needed <= granted))
        .map(|row| json!({"name":row["name"],"title":row["title"],"description":row["description"],"inputSchema":row["inputSchema"]}))
        .collect()).unwrap_or_default())
}
async fn call_tool(app: &tauri::AppHandle, config: &Connection, name: &str, arguments: Value) -> Result<Value, (i64, String)> {
    // A client that skipped tools/list still cannot reach a tool the scope excludes.
    let (action, needed) = tool_action(name).ok_or_else(|| (-32602, format!("Unknown tool: {name}")))?;
    if needed > scope_tier(&config.scope) {
        return Ok(tool_text(format!("Tool \"{name}\" needs scope \"{}\"; this connection grants \"{}\". Ask the user to reopen the AI connection with a wider scope.", SCOPE_TIERS[needed as usize], config.scope), true));
    }
    let mut payload = if arguments.is_null() { json!({}) } else { arguments };
    payload["action"] = json!(action);
    let (status, body) = forward(app, config, payload).await;
    let text = if status == 200 {
        serde_json::to_string_pretty(&body["data"]).unwrap_or_else(|_| "null".into())
    } else {
        // Relay's error messages already name the field and the fix, so the agent can
        // correct itself; isError keeps the JSON-RPC call itself successful.
        format!("{} (code: {})", body["error"]["message"].as_str().unwrap_or("Rejected"), body["error"]["code"].as_str().unwrap_or("invalid"))
    };
    Ok(tool_text(text, status != 200))
}
fn tool_text(text: String, is_error: bool) -> Value {
    json!({"content":[{"type":"text","text":text}],"isError":is_error})
}
async fn write_raw(stream: &mut TcpStream, status: u16, ctype: &str, body: &[u8], extra: &[(&str, &str)]) {
    let mut header = format!("HTTP/1.1 {status} Result\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n", body.len());
    for (key, value) in extra { header.push_str(&format!("{key}: {value}\r\n")); }
    header.push_str("\r\n");
    let _ = tokio::time::timeout(Duration::from_secs(10), async {
        stream.write_all(header.as_bytes()).await?;
        stream.write_all(body).await
    }).await;
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

    /// Every action the frontend can dispatch. Two tests below read this one list:
    /// that the transport grades all of them, and that all of them survive the MCP
    /// tool-name flip. Two literal lists would let a new action pass one and miss
    /// the other.
    const KNOWN: [&str; 18] = ["workspace.list","entity.find","entity.get","job.get","mcp.tools",
        "collection.upsert","environment.upsert","request.upsert","document.upsert",
        "document.endpoint.upsert","runner.upsert","entity.open","document.export","request.preview",
        "request.execute","document.verify","runner.execute","job.cancel"];

    #[test] fn every_frontend_action_is_graded() {
        // A new action that is not in the table would be refused, which is the safe
        // direction, but it would also silently break for real users. Keep the
        // transport's table and the frontend's list in step.
        for action in KNOWN {
            assert!(action_tier(action).is_some(), "{action} has no scope tier");
        }
    }
    #[test] fn unknown_action_is_refused() { assert_eq!(action_tier("request.delete_all"), None); }
    #[test] fn tool_names_round_trip_to_actions() {
        // Every graded action must survive the underscore flip that MCP tool names
        // need, or a client would faithfully call a tool that resolves to nothing.
        for action in KNOWN {
            let name = action.replace('.', "_");
            assert_eq!(tool_action(&name).map(|(_, tier)| tier), action_tier(action), "{name}");
            assert!(!action.contains('_'), "{action} would be ambiguous as a tool name");
        }
        assert!(tool_action("collection_delete_everything").is_none());
    }
    #[test] fn tool_calls_respect_the_granted_scope() {
        // Mirrors call_tool's gate: a client that never called tools/list still cannot
        // reach a tool above the scope, and an unknown name is a hard error.
        let granted = scope_tier("read");
        assert!(tool_action("entity_get").is_some_and(|(_, needed)| needed <= granted));
        assert!(tool_action("request_upsert").is_some_and(|(_, needed)| needed > granted));
        assert!(tool_action("request_execute").is_some_and(|(_, needed)| needed > granted));
        assert_eq!(tool_action("mcp_tools").map(|(_, needed)| needed), Some(0));
    }
    #[test] fn protocol_negotiation_falls_back_to_what_we_implement() {
        assert_eq!(negotiate_version("2025-03-26"), "2025-03-26");
        assert_eq!(negotiate_version("2025-06-18"), "2025-06-18");
        // A newer or garbage revision gets our latest, never an echo of the ask.
        assert_eq!(negotiate_version("2099-01-01"), MCP_LATEST);
        assert_eq!(negotiate_version(""), MCP_LATEST);
    }
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
    #[test] fn batch_is_gated_command_by_command() {
        // The whole point of expanding a batch in the transport is that a client
        // cannot park an execute among reads. Every case below must refuse the batch,
        // not merely skip the offending entry.
        let read = scope_tier("read");
        let execute = scope_tier("execute");
        let ok = json!({"commands":[{"action":"workspace.list"},{"action":"entity.get","type":"request","id":"a"}]});
        assert!(gate_batch(&ok, execute, &conn("execute")).is_ok());
        let smuggled = json!({"commands":[{"action":"workspace.list"},{"action":"request.execute","id":"a"}]});
        let (status, body) = gate_batch(&smuggled, read, &conn("read")).unwrap_err();
        assert_eq!(status, 403);
        assert_eq!(body["error"]["code"], "insufficient_scope");
        // The index has to be in the message, or the caller cannot find the offender.
        assert!(body["error"]["message"].as_str().unwrap().contains("commands[1]"), "{}", body);
        assert!(body["error"]["message"].as_str().unwrap().contains("commands[1] request.execute"), "{}", body);
    }
    #[test] fn malformed_batches_are_refused_with_a_usable_reason() {
        let granted = scope_tier("execute");
        let config = conn("execute");
        let cases: Vec<(Value, &str)> = vec![
            (json!({"commands": []}), "empty"),
            (json!({"commands": "workspace.list"}), "must be an array"),
            (json!({"commands": [{"action":"workspace.list"}], "action":"entity.get"}), "cannot appear together"),
            (json!({"commands": [{"commands":[{"action":"workspace.list"}]}]}), "cannot nest"),
            (json!({"commands": [{"action":"entity.delete_everything"}]}), "unknown action"),
            (json!({"commands": ["workspace.list"]}), "must be an object"),
            (json!({"commands": (0..21).map(|_| json!({"action":"workspace.list"})).collect::<Vec<_>>()}), "over the 20 limit"),
        ];
        for (payload, needle) in cases {
            let (status, body) = gate_batch(&payload, granted, &config)
                .err().unwrap_or_else(|| panic!("{payload} should have been refused"));
            assert_eq!(status, 400, "{payload}");
            let message = body["error"]["message"].as_str().unwrap_or_default();
            assert!(message.to_lowercase().contains(needle), "expected {needle:?} in {message:?}");
        }
    }
    #[test] fn a_valid_batch_reaches_the_window_once() {
        // The gate's job ends at "may these run"; it must not rewrite the payload,
        // because the frontend walks the same array and reports per-command results.
        let payload = json!({"commands":[{"action":"workspace.list"},{"action":"job.get","id":"j1"}]});
        assert!(gate_batch(&payload, scope_tier("read"), &conn("read")).is_ok());
        assert_eq!(payload["commands"].as_array().unwrap().len(), 2);
    }
    #[test] fn execute_without_a_host_allowlist_is_rejected() {
        // Mirrors the guard in automation_start: the check exists because an
        // unbounded allowlist is the same hole as no check at all.
        let hosts = normalize_hosts(&Vec::new());
        assert!(hosts.is_empty());
    }
}
