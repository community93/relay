use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::StreamExt;

use crate::state;
use crate::types::*;
use crate::util;

pub const MAX_INLINE_BYTES: usize = 8 * 1024 * 1024;

pub struct Prepared {
    pub builder: reqwest::RequestBuilder,
    pub url: String,
}

fn qs_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Normalises the URL and folds enabled params into the query string.
pub fn resolve_url(draft: &Draft) -> Result<String, String> {
    let raw = draft.url.trim();
    if raw.is_empty() {
        return Err("URL 不能为空".into());
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let lower = with_scheme.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!("不支持的协议，仅支持 http/https：{with_scheme}"));
    }

    let mut pairs: Vec<String> = Vec::new();
    for p in &draft.params {
        if !p.enabled || p.key.trim().is_empty() {
            continue;
        }
        pairs.push(format!(
            "{}={}",
            qs_encode(p.key.trim()),
            qs_encode(p.value.trim())
        ));
    }
    if pairs.is_empty() {
        return Ok(with_scheme);
    }
    let sep = if with_scheme.contains('?') { '&' } else { '?' };
    Ok(format!("{with_scheme}{sep}{}", pairs.join("&")))
}

fn content_type_for_language(lang: &str) -> &'static str {
    match lang.to_ascii_lowercase().as_str() {
        "json" => "application/json",
        "xml" => "application/xml",
        "html" => "text/html",
        "javascript" => "application/javascript",
        _ => "text/plain",
    }
}

fn has_header(draft: &Draft, name: &str) -> bool {
    draft
        .headers
        .iter()
        .any(|h| h.enabled && h.key.eq_ignore_ascii_case(name))
}

/// `accept` is applied only when the request does not set its own Accept header,
/// which is how SSE streaming gets opted into.
pub fn prepare(
    app: &state::AppState,
    draft: &Draft,
    accept: Option<&str>,
) -> Result<Prepared, String> {
    let s = state::settings_of(draft.settings.as_ref());
    let url = resolve_url(draft)?;
    let client = state::client_for(app, &s)?;

    let method_name = if draft.method.trim().is_empty() {
        "GET"
    } else {
        draft.method.trim()
    };
    let method = reqwest::Method::from_bytes(method_name.to_uppercase().as_bytes())
        .map_err(|e| format!("无法解析 HTTP 方法 {}：{e}", draft.method))?;

    let mut rb = client.request(method, &url);

    for h in &draft.headers {
        if !h.enabled || h.key.trim().is_empty() {
            continue;
        }
        rb = rb.header(h.key.trim(), h.value.as_str());
    }
    if let Some(accept) = accept {
        if !has_header(draft, "accept") {
            rb = rb.header(reqwest::header::ACCEPT, accept);
        }
    }

    let body = draft.body.clone().unwrap_or_default();
    match body.mode.as_str() {
        "raw" => {
            let raw = body.raw.clone().unwrap_or_default();
            if !raw.content.is_empty() && !has_header(draft, "content-type") {
                rb = rb.header(
                    reqwest::header::CONTENT_TYPE,
                    content_type_for_language(&raw.language),
                );
            }
            rb = rb.body(raw.content);
        }
        "urlencoded" => {
            let pairs: Vec<(String, String)> = body
                .urlencoded
                .iter()
                .filter(|e| e.enabled && !e.key.trim().is_empty())
                .map(|e| (e.key.clone(), e.value.clone()))
                .collect();
            rb = rb.form(&pairs);
        }
        "form" => {
            let mut form = reqwest::multipart::Form::new();
            for e in &body.form {
                if !e.enabled || e.key.trim().is_empty() {
                    continue;
                }
                if e.kind == "file" {
                    let bytes = std::fs::read(&e.value)
                        .map_err(|err| format!("读取文件 {} 失败：{err}", e.value))?;
                    let file_name = std::path::Path::new(&e.value)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "blob".into());
                    form = form.part(e.key.clone(), reqwest::multipart::Part::bytes(bytes).file_name(file_name));
                } else {
                    form = form.text(e.key.clone(), e.value.clone());
                }
            }
            rb = rb.multipart(form);
        }
        "file" => {
            let path = body.file.clone().unwrap_or_default();
            let bytes =
                std::fs::read(&path).map_err(|e| format!("读取文件 {path} 失败：{e}"))?;
            if !has_header(draft, "content-type") {
                rb = rb.header(reqwest::header::CONTENT_TYPE, "application/octet-stream");
            }
            rb = rb.body(bytes);
        }
        _ => {}
    }

    if let Some(ms) = s.timeout_ms.filter(|v| *v > 0) {
        rb = rb.timeout(Duration::from_millis(ms));
    }

    Ok(Prepared { builder: rb, url })
}

pub fn headers_vec(map: &reqwest::header::HeaderMap) -> Vec<HeaderEntry> {
    map.iter()
        .map(|(name, value)| HeaderEntry {
            name: name.as_str().to_string(),
            value: value.to_str().unwrap_or("<非 ASCII>").to_string(),
        })
        .collect()
}

pub fn content_type_of(map: &reqwest::header::HeaderMap) -> String {
    map.get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

pub fn set_cookies_of(map: &reqwest::header::HeaderMap) -> Vec<String> {
    map.get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(|v| v.to_string())
        .collect()
}

pub fn status_text(status: u16) -> String {
    reqwest::StatusCode::from_u16(status)
        .ok()
        .and_then(|c| c.canonical_reason().map(|r| r.to_string()))
        .unwrap_or_default()
}

/// Text when the payload is printable, base64 when it is binary. Decoding follows
/// the declared charset, then a BOM, then UTF-8, then the CJK single-byte families
/// (GB18030 covers GBK/GB2312) so intranet APIs that answer in GBK still read.
pub struct Shaped {
    pub is_text: bool,
    pub text: Option<String>,
    pub base64: Option<String>,
    pub charset: Option<String>,
    /// Raw bytes, only sent when we had to transcode, so the UI can offer a
    /// manual "decode as" override without another request.
    pub raw_base64: Option<String>,
    pub lossy: bool,
}

pub fn charset_label(content_type: &str) -> Option<String> {
    let lowered = content_type.to_ascii_lowercase();
    let index = lowered.find("charset=")?;
    let rest = &content_type[index + "charset=".len()..];
    let token = rest
        .split([';', ' ', ','])
        .next()
        .unwrap_or_default()
        .trim_matches(|c| c == '"' || c == '\'');
    if token.is_empty() {
        None
    } else {
        Some(token.to_ascii_lowercase())
    }
}

fn decode_with(bytes: &[u8], label: &str) -> Option<(String, String, bool)> {
    let encoding = encoding_rs::Encoding::for_label(label.as_bytes())?;
    let (cow, used, had_errors) = encoding.decode(bytes);
    Some((
        cow.into_owned(),
        used.name().to_ascii_lowercase(),
        had_errors,
    ))
}

/// Sniffs the encoding when the server did not say (or lied about) one.
pub fn sniff_text(bytes: &[u8]) -> (String, String, bool) {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_string(), "utf-8".to_string(), false);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        if let Some(decoded) = decode_with(bytes, "utf-16") {
            return decoded;
        }
    }
    for label in ["gb18030", "big5", "shift_jis", "windows-1252"] {
        if let Some((text, used, had_errors)) = decode_with(bytes, label) {
            if !had_errors {
                return (text, used, false);
            }
        }
    }
    (
        String::from_utf8_lossy(bytes).into_owned(),
        "utf-8".to_string(),
        true,
    )
}

pub fn shape_body(content_type: &str, bytes: &[u8]) -> Shaped {
    let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    if !(util::is_textual(content_type) && !util::looks_binary(bytes)) {
        return Shaped {
            is_text: false,
            text: None,
            base64: Some(encode(bytes)),
            charset: charset_label(content_type),
            raw_base64: None,
            lossy: false,
        };
    }
    if let Some(label) = charset_label(content_type) {
        if label != "utf-8" && label != "utf8" {
            if let Some((text, used, had_errors)) = decode_with(bytes, &label) {
                let transcoded = used != "utf-8";
                return Shaped {
                    is_text: true,
                    text: Some(text),
                    base64: None,
                    charset: Some(used),
                    raw_base64: transcoded.then(|| encode(bytes)),
                    lossy: had_errors,
                };
            }
        }
        if let Ok(text) = std::str::from_utf8(bytes) {
            return Shaped {
                is_text: true,
                text: Some(text.to_string()),
                base64: None,
                charset: Some("utf-8".to_string()),
                raw_base64: None,
                lossy: false,
            };
        }
    }
    let (text, used, lossy) = sniff_text(bytes);
    let transcoded = used != "utf-8";
    Shaped {
        is_text: true,
        text: Some(text),
        base64: None,
        charset: Some(used),
        raw_base64: (transcoded || lossy).then(|| encode(bytes)),
        lossy,
    }
}

/// Re-decodes a body we already have the raw bytes for (manual charset override).
#[tauri::command]
pub fn redecode(body_base64: String, charset: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body_base64)
        .map_err(|e| format!("Base64 解码失败：{e}"))?;
    decode_with(&bytes, &charset.trim().to_ascii_lowercase())
        .map(|(text, _, _)| text)
        .ok_or_else(|| format!("不支持的编码：{charset}"))
}

/// Same override applied to a whole streamed log at once, so switching charset
/// in the SSE raw view is one round trip rather than one per frame.
#[tauri::command]
pub fn redecode_chunks(bases: Vec<String>, charset: String) -> Result<Vec<Option<String>>, String> {
    let label = charset.trim().to_ascii_lowercase();
    bases
        .iter()
        .map(|base| {
            if base.is_empty() {
                return Ok(None);
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(base)
                .map_err(|e| format!("Base64 解码失败：{e}"))?;
            decode_with(&bytes, &label)
                .map(|(text, _, _)| Some(text))
                .ok_or_else(|| format!("不支持的编码：{charset}"))
        })
        .collect()
}

pub fn encode_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Decode under a declared label, never failing: an unknown or unusable label
/// falls back to the lossy UTF-8 read rather than dropping the payload. Used by
/// the streaming parsers, which cannot ask the server to re-send.
pub fn decode_lossy(bytes: &[u8], label: &str) -> String {
    decode_with(bytes, &label.trim().to_ascii_lowercase())
        .map(|(text, _, _)| text)
        .unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
}

/// Streams the response body with a hard cap so a huge payload cannot exhaust memory.
pub async fn read_capped<E: std::fmt::Display>(
    mut stream: impl futures_util::Stream<Item = Result<bytes::Bytes, E>> + Unpin,
) -> Result<(Vec<u8>, bool), String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取响应体失败：{e}"))?;
        let room = MAX_INLINE_BYTES.saturating_sub(buf.len());
        if chunk.len() > room {
            buf.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    Ok((buf, truncated))
}

pub fn describe_error(e: &reqwest::Error) -> (String, String) {
    let raw = e.to_string();
    let lowered = raw.to_ascii_lowercase();
    if e.is_timeout() {
        return (
            "timeout".into(),
            "请求超时：在设定的超时时间内未收到响应。可在 Settings 中调大 Timeout。".into(),
        );
    }
    if e.is_redirect() {
        return ("redirect".into(), format!("重定向次数过多或循环重定向：{raw}"));
    }
    if e.is_connect() {
        if lowered.contains("certificate") || lowered.contains("ssl") || lowered.contains("tls") {
            return (
                "tls".into(),
                format!("TLS 证书校验失败：{raw}。内网自签证书可在 Settings 关闭 SSL 证书校验。"),
            );
        }
        if lowered.contains("dnsname") || lowered.contains("failed to lookup") {
            return ("dns".into(), format!("域名解析失败：{raw}"));
        }
        return (
            "connect".into(),
            format!("无法建立连接：{raw}。检查主机/端口是否可达、是否需要代理。"),
        );
    }
    if e.is_builder() {
        return ("invalid".into(), format!("请求配置有误：{raw}"));
    }
    ("network".into(), raw)
}

pub fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

pub fn empty_response() -> ExecResponse {
    ExecResponse {
        ok: false,
        status: 0,
        status_text: String::new(),
        time_ms: 0,
        size_bytes: 0,
        header_count: 0,
        headers: Vec::new(),
        set_cookies: Vec::new(),
        content_type: String::new(),
        charset: None,
        is_text: false,
        body_text: None,
        body_base64: None,
        body_raw_base64: None,
        truncated: false,
        final_url: String::new(),
        redirects: 0,
        error: None,
        error_kind: None,
        note: None,
    }
}

