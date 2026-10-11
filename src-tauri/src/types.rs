use serde::{Deserialize, Serialize};

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Kv {
    pub id: String,
    pub key: String,
    pub value: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub description: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FormEntry {
    pub id: String,
    pub key: String,
    pub value: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// "text" or "file" (value holds the absolute path when kind == "file")
    pub kind: String,
    pub description: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RawBody {
    pub language: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Body {
    /// none | raw | urlencoded | form | file
    pub mode: String,
    pub raw: Option<RawBody>,
    pub urlencoded: Vec<FormEntry>,
    pub form: Vec<FormEntry>,
    pub file: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub timeout_ms: Option<u64>,
    #[serde(default = "yes")]
    pub follow_redirects: bool,
    #[serde(default = "yes")]
    pub ssl_verify: bool,
    pub proxy: Option<String>,
    pub max_redirects: Option<usize>,
    #[serde(default = "yes")]
    pub cookie_jar: bool,
}

/// A fully rendered request. Variables are resolved on the frontend, so the
/// transport layer only ever sees concrete strings.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Draft {
    pub name: String,
    pub method: String,
    pub url: String,
    pub params: Vec<Kv>,
    pub headers: Vec<Kv>,
    pub body: Option<Body>,
    pub settings: Option<Settings>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HeaderEntry {
    pub name: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExecResponse {
    pub ok: bool,
    pub status: u16,
    pub status_text: String,
    pub time_ms: u64,
    pub size_bytes: u64,
    pub header_count: usize,
    pub headers: Vec<HeaderEntry>,
    pub set_cookies: Vec<String>,
    pub content_type: String,
    pub charset: Option<String>,
    pub is_text: bool,
    pub body_text: Option<String>,
    pub body_base64: Option<String>,
    pub body_raw_base64: Option<String>,
    pub truncated: bool,
    pub final_url: String,
    pub redirects: usize,
    pub error: Option<String>,
    pub error_kind: Option<String>,
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SseEvent {
    /// open | message | error | done
    pub kind: String,
    pub at: u64,
    pub event: Option<String>,
    pub data: String,
    pub id: Option<String>,
    pub retry: Option<u64>,
    pub status: Option<u16>,
    pub headers: Option<Vec<HeaderEntry>>,
    pub message: Option<String>,
    pub bytes: u64,
    /// Wire bytes for a `raw` frame, base64, present only when the lossy UTF-8
    /// decode could be improved on — i.e. the chunk was not valid UTF-8. Lets the
    /// raw view re-decode under another charset without another request.
    pub raw_base64: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WsEvent {
    /// open | message | error | closed | ping | pong
    pub kind: String,
    pub at: u64,
    pub dir: Option<String>,
    pub text: Option<String>,
    pub bytes_b64: Option<String>,
    pub len: u64,
    pub code: Option<u16>,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub status: Option<u16>,
    pub headers: Option<Vec<HeaderEntry>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CurlImport {
    pub draft: Draft,
    pub warnings: Vec<String>,
    pub source: String,
}
