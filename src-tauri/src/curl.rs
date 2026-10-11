use std::collections::VecDeque;

use base64::Engine;

use crate::types::*;
use crate::util;

#[derive(Clone, Copy, PartialEq)]
enum DataKind {
    Raw,
    UrlEncoded,
}

struct Ctx {
    method: Option<String>,
    url: Option<String>,
    headers: Vec<(String, String)>,
    data: Vec<(String, DataKind)>,
    form: Vec<FormEntry>,
    user: Option<String>,
    cookies: Vec<String>,
    warnings: Vec<String>,
    force_get: bool,
    ssl_verify: bool,
    follow_redirects: bool,
    proxy: Option<String>,
    timeout_ms: Option<u64>,
    max_redirects: Option<usize>,
}

impl Ctx {
    fn new() -> Self {
        Ctx {
            method: None,
            url: None,
            headers: Vec::new(),
            data: Vec::new(),
            form: Vec::new(),
            user: None,
            cookies: Vec::new(),
            warnings: Vec::new(),
            force_get: false,
            ssl_verify: true,
            follow_redirects: false,
            proxy: None,
            timeout_ms: None,
            max_redirects: None,
        }
    }

    fn warn(&mut self, msg: impl Into<String>) {
        self.warnings.push(msg.into());
    }

    fn header(&mut self, name: &str, value: &str) {
        let lowered = name.to_ascii_lowercase();
        // The HTTP stack computes these; a copied-over stale value breaks requests.
        if matches!(lowered.as_str(), "content-length" | "host" | "connection") {
            self.warn(format!("已忽略 {name} 头（由客户端自动计算）"));
            return;
        }
        self.headers.push((name.trim().to_string(), value.to_string()));
    }
}

struct Reader {
    items: VecDeque<String>,
}

impl Reader {
    fn next(&mut self) -> Option<String> {
        self.items.pop_front()
    }
}

fn takes_value(short: char) -> bool {
    matches!(
        short,
        'X' | 'H' | 'd' | 'b' | 'm' | 'x' | 'u' | 'A' | 'e' | 'F' | 'o' | 'T' | 't' | 'r' | 'p' | 'c'
    )
}

/// Every flag that consumes a following argument, used to decide whether a
/// bundled short-flag token such as `-sS` can keep going.
fn takes_value_str(flag: &str) -> bool {
    matches!(
        flag,
        "-X" | "--request"
            | "-H" | "--header"
            | "-d" | "--data" | "--data-raw" | "--data-binary" | "--data-ascii" | "--data-urlencode"
            | "--json"
            | "-F" | "--form" | "--form-string"
            | "-u" | "--user"
            | "-b" | "--cookie"
            | "-A" | "--user-agent"
            | "-e" | "--referer"
            | "-x" | "--proxy"
            | "-m" | "--max-time" | "--connect-timeout" | "--max-redirs"
            | "--url"
            | "-o" | "--output" | "-O" | "--remote-name"
            | "-c" | "--cookie-jar"
            | "--resolve" | "--cacert" | "--capath" | "--cert" | "--key"
            | "--tls-max" | "--ciphers" | "--proxy-user"
    )
}

/// Splits a pasted blob into individual curl commands: newline separated, `;`
/// separated or several on one line. Quote aware, so a URL containing "curl"
/// is not mistaken for a new command.
fn split_commands(text: &str) -> Vec<String> {
    let cleaned = strip_continuations(text);
    let chars: Vec<char> = cleaned.chars().collect();
    let mut starts: Vec<usize> = Vec::new();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match quote {
            Some('\'') => {
                if c == '\'' {
                    quote = None;
                }
            }
            Some('"') => {
                if c == '"' {
                    quote = None;
                } else if c == '\\' {
                    i += 1;
                }
            }
            _ => {
                if c == '\'' || c == '"' {
                    quote = Some(c);
                } else if c == '#' && starts.is_empty() {
                    while i < chars.len() && chars[i] != '\n' {
                        i += 1;
                    }
                } else if c == 'c'
                    && starts_with_at(&chars, i, "curl")
                    && at_command_boundary(&chars, i)
                {
                    starts.push(i);
                }
            }
        }
        i += 1;
    }

    let mut out = Vec::new();
    for (idx, start) in starts.iter().enumerate() {
        let end = *starts.get(idx + 1).unwrap_or(&chars.len());
        let chunk: String = chars[*start..end].iter().collect();
        let chunk = chunk.trim().trim_end_matches([';', '&']).trim().to_string();
        if !chunk.is_empty() {
            out.push(chunk);
        }
    }
    if out.is_empty() {
        let rest = cleaned.trim();
        if !rest.is_empty() && !rest.starts_with("curl") {
            out.push(rest.to_string());
        }
    }
    out
}

fn strip_continuations(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed.ends_with('\\') || trimmed.ends_with('^') {
            out.push_str(trimmed[..trimmed.len() - 1].trim_end());
            out.push(' ');
        } else {
            out.push_str(trimmed);
            out.push('\n');
        }
    }
    out
}

fn starts_with_at(chars: &[char], at: usize, word: &str) -> bool {
    let mut idx = at;
    for expected in word.chars() {
        match chars.get(idx) {
            Some(c) if *c == expected => idx += 1,
            _ => return false,
        }
    }
    !matches!(
        chars.get(idx),
        Some(c) if c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '/'
    )
}

fn at_command_boundary(chars: &[char], at: usize) -> bool {
    if at == 0 {
        return true;
    }
    let mut j = at - 1;
    loop {
        let c = chars[j];
        match c {
            ';' | '\n' | '\r' | '|' => return true,
            '&' => return j == 0 || chars[j - 1] != '&',
            ' ' | '\t' => {}
            _ => return false,
        }
        if j == 0 {
            return true;
        }
        j -= 1;
    }
}

fn tokenize(input: &str) -> Vec<String> {
    let chars: Vec<char> = input.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            ' ' | '\t' | '\n' | '\r' => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
                i += 1;
            }
            '\'' => {
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    cur.push(chars[i]);
                    i += 1;
                }
                i += 1;
                has = true;
            }
            '"' => {
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        i += 1;
                    }
                    cur.push(chars[i]);
                    i += 1;
                }
                i += 1;
                has = true;
            }
            '\\' if i + 1 < chars.len() => {
                i += 1;
                cur.push(chars[i]);
                i += 1;
                has = true;
            }
            c => {
                cur.push(c);
                i += 1;
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

#[tauri::command]
pub fn parse_curl(text: String) -> Result<Vec<CurlImport>, String> {
    let commands = split_commands(&text);
    if commands.is_empty() {
        return Err("没有识别到 curl 命令，请检查粘贴内容是否以 curl 开头".into());
    }
    let mut out = Vec::with_capacity(commands.len());
    for (idx, command) in commands.iter().enumerate() {
        match parse_command(command) {
            Ok(import) => out.push(import),
            Err(e) => {
                if commands.len() == 1 {
                    return Err(e);
                }
                out.push(CurlImport {
                    source: command.clone(),
                    warnings: vec![format!("第 {} 条解析失败：{e}", idx + 1)],
                    draft: Draft {
                        name: format!("解析失败 #{}/{}", idx + 1, commands.len()),
                        ..Default::default()
                    },
                });
            }
        }
    }
    Ok(out)
}

fn parse_command(command: &str) -> Result<CurlImport, String> {
    let mut ctx = Ctx::new();
    let mut reader = Reader {
        items: tokenize(command).into_iter().collect(),
    };
    let mut positional_url: Option<String> = None;

    while let Some(token) = reader.next() {
        if token.is_empty() || token == "curl" {
            continue;
        }

        if !token.starts_with('-') {
            if positional_url.is_none() {
                positional_url = Some(token);
            } else {
                ctx.warn(format!("忽略了多余的参数：{token}"));
            }
            continue;
        }

        // Long flags may carry `=value`; short flags may be bundled (-sS) or
        // glued to their value (-d'{"a":1}').
        if token.starts_with("--") {
            let (flag, glued) = match token.split_once('=') {
                Some((f, v)) => (f.to_string(), Some(v.to_string())),
                None => (token.clone(), None),
            };
            handle_flag(&mut ctx, &mut reader, &flag, glued)?;
        } else {
            let chars: Vec<char> = token.chars().skip(1).collect();
            let mut idx = 0;
            while idx < chars.len() {
                let c = chars[idx];
                let flag = format!("-{c}");
                let remainder: String = chars[idx + 1..].iter().collect();
                let glued = if takes_value(c) && !remainder.is_empty() {
                    Some(remainder)
                } else {
                    None
                };
                let keep_bundling = handle_flag(&mut ctx, &mut reader, &flag, glued.clone())?;
                idx += 1;
                if !keep_bundling || takes_value(c) {
                    break;
                }
            }
        }
    }

    let url = ctx.url.clone().or(positional_url).ok_or("curl 命令里没有 URL")?;
    let content_type = ctx
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.to_ascii_lowercase())
        .unwrap_or_default();

    let mut base = url.clone();
    let mut params: Vec<Kv> = Vec::new();
    if let Some((head, query)) = url.split_once('?') {
        base = head.to_string();
        push_pairs(query, &mut params);
    }
    // `-G` is curl's "the --data belongs in the URL, not in a body" — fold it into
    // the same table the query string uses and drop the payload.
    if ctx.force_get && !ctx.data.is_empty() {
        for (value, _) in &ctx.data {
            push_pairs(value, &mut params);
        }
        ctx.data.clear();
    }

    if let Some(user) = ctx.user.clone() {
        let token = base64::engine::general_purpose::STANDARD.encode(user);
        ctx.header("Authorization", &format!("Basic {token}"));
    }
    if !ctx.cookies.is_empty() {
        let joined = ctx.cookies.join("; ");
        ctx.header("Cookie", &joined);
    }

    let has_payload = !ctx.data.is_empty() || !ctx.form.is_empty();
    let method = if ctx.force_get {
        "GET".to_string()
    } else {
        ctx.method
            .clone()
            .unwrap_or_else(|| if has_payload { "POST".into() } else { "GET".into() })
    };
    let body = build_body(&ctx, &content_type);
    let headers = ctx
        .headers
        .iter()
        .map(|(k, v)| Kv {
            id: util::new_id(),
            key: k.clone(),
            value: v.clone(),
            enabled: true,
            description: String::new(),
        })
        .collect();

    let draft = Draft {
        name: request_name(&method, &base),
        method,
        url: base,
        params,
        headers,
        body,
        settings: Some(Settings {
            timeout_ms: ctx.timeout_ms,
            follow_redirects: ctx.follow_redirects,
            ssl_verify: ctx.ssl_verify,
            proxy: ctx.proxy,
            max_redirects: ctx.max_redirects,
            cookie_jar: true,
        }),
    };

    Ok(CurlImport {
        draft,
        warnings: ctx.warnings,
        source: command.to_string(),
    })
}

/// Returns `true` when the flag consumed no argument, i.e. a bundled short-flag
/// token such as `-sS` may continue with the next character.
fn handle_flag(
    ctx: &mut Ctx,
    reader: &mut Reader,
    flag: &str,
    glued: Option<String>,
) -> Result<bool, String> {
    let mut value = || match glued.clone() {
        Some(v) => Some(v),
        None => reader.next(),
    };

    match flag {
        "-X" | "--request" => {
            if let Some(v) = value() {
                ctx.method = Some(v.trim().to_uppercase());
            }
        }
        "-H" | "--header" => {
            if let Some(v) = value() {
                match v.split_once(':') {
                    Some((name, header_value)) => ctx.header(name, header_value),
                    None => ctx.warn(format!("无法解析请求头（缺少冒号）：{v}")),
                }
            }
        }
        "-d" | "--data" | "--data-raw" | "--data-binary" | "--data-ascii" => {
            if let Some(v) = value() {
                ctx.data.push((v, DataKind::Raw));
            }
        }
        "--data-urlencode" => {
            if let Some(v) = value() {
                ctx.data.push((v, DataKind::UrlEncoded));
            }
        }
        "--json" => {
            if let Some(v) = value() {
                ctx.data.push((v, DataKind::Raw));
                ctx.header("Content-Type", "application/json");
                ctx.header("Accept", "application/json");
                ctx.method.get_or_insert_with(|| "POST".into());
            }
        }
        "-F" | "--form" | "--form-string" => {
            if let Some(v) = value() {
                match v.split_once('=') {
                    Some((key, field_value)) => {
                        let is_file = flag != "--form-string" && field_value.starts_with('@');
                        ctx.form.push(FormEntry {
                            id: util::new_id(),
                            key: key.to_string(),
                            value: if is_file {
                                field_value[1..].to_string()
                            } else {
                                field_value.to_string()
                            },
                            enabled: true,
                            kind: if is_file { "file".into() } else { "text".into() },
                            description: String::new(),
                        });
                    }
                    None => ctx.warn(format!("无法解析表单字段：{v}")),
                }
            }
        }
        "-u" | "--user" => {
            if let Some(v) = value() {
                ctx.user = Some(v);
            }
        }
        "-b" | "--cookie" => {
            if let Some(v) = value() {
                if v.contains('=') {
                    ctx.cookies.push(v);
                } else {
                    ctx.warn("忽略 -b：从 Cookie 文件读取暂不支持".to_string());
                }
            }
        }
        "-A" | "--user-agent" => {
            if let Some(v) = value() {
                ctx.header("User-Agent", &v);
            }
        }
        "-e" | "--referer" => {
            if let Some(v) = value() {
                ctx.header("Referer", &v);
            }
        }
        "-x" | "--proxy" => {
            if let Some(v) = value() {
                ctx.proxy = Some(v);
            }
        }
        "-m" | "--max-time" => {
            if let Some(v) = value() {
                let seconds: f64 = v.trim().parse().unwrap_or(0.0);
                if seconds > 0.0 {
                    ctx.timeout_ms = Some((seconds * 1000.0).round() as u64);
                }
            }
        }
        "--connect-timeout" => {
            value();
            ctx.warn("忽略 --connect-timeout（统一使用请求超时）".to_string());
        }
        "--max-redirs" => {
            if let Some(v) = value() {
                ctx.max_redirects = v.trim().parse().ok();
            }
        }
        "--url" => {
            if let Some(v) = value() {
                ctx.url = Some(v);
            }
        }
        "-k" | "--insecure" => ctx.ssl_verify = false,
        "-L" | "--location" | "--location-trusted" => ctx.follow_redirects = true,
        "-G" | "--get" => {
            ctx.force_get = true;
            ctx.method = None;
        }
        "-I" | "--head" => ctx.method = Some("HEAD".into()),
        "-o" | "--output" => {
            value();
            ctx.warn(format!("忽略 {flag}：响应直接在界面展示，不写文件"));
        }
        "-O" | "--remote-name" | "--remote-header-name" => {
            ctx.warn(format!("忽略 {flag}：响应直接在界面展示，不写文件"));
        }
        "--resolve" | "--cacert" | "--capath" | "--cert" | "--key" | "--cookie-jar"
        | "--tls-max" | "--ciphers" | "--proxy-user" | "--digest" | "--negotiate" => {
            value();
            ctx.warn(format!("暂不支持 {flag}，已忽略"));
        }
        "-s" | "--silent" | "-S" | "--show-error" | "-v" | "--verbose" | "-N" | "--no-buffer"
        | "--compressed" | "--http1.1" | "--http2" | "--http2-prior-knowledge" | "-f" | "--fail"
        | "--basic" | "--anyauth" | "-#" | "--progress-bar" | "-g" | "--globoff" | "-i" => {
            // Accepted and dropped: they do not change what Relay sends.
        }
        _ => {
            ctx.warn(format!("未识别的参数 {flag}，已忽略"));
            return Ok(!takes_value_str(flag));
        }
    }
    Ok(!takes_value_str(flag))
}

/// Split an `a=1&b=2` string into table rows. Wire values arrive percent-encoded,
/// so they are decoded once here and re-encoded again by the sender.
fn push_pairs(query: &str, into: &mut Vec<Kv>) {
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        into.push(Kv {
            id: util::new_id(),
            key: qs_decode(k),
            value: qs_decode(v),
            enabled: true,
            description: String::new(),
        });
    }
}

fn build_body(ctx: &Ctx, content_type: &str) -> Option<Body> {
    if !ctx.form.is_empty() {
        return Some(Body {
            mode: "form".into(),
            form: ctx.form.clone(),
            ..Default::default()
        });
    }
    if ctx.data.is_empty() {
        return None;
    }
    let parts: Vec<String> = ctx
        .data
        .iter()
        .map(|(value, kind)| match kind {
            DataKind::Raw => value.clone(),
            DataKind::UrlEncoded => match value.split_once('=') {
                Some((k, v)) => format!("{}={}", qs_encode(k), qs_encode(v)),
                None => qs_encode(value),
            },
        })
        .collect();
    let text = parts.join("&");

    if content_type.contains("json") || looks_like_json(&text) {
        return Some(Body {
            mode: "raw".into(),
            raw: Some(RawBody {
                language: "json".into(),
                content: text,
            }),
            ..Default::default()
        });
    }
    let all_pairs = parts.iter().all(|p| is_pair(p));
    if all_pairs && !parts.is_empty() {
        let rows: Vec<FormEntry> = parts
            .iter()
            .filter_map(|p| p.split_once('='))
            .map(|(k, v)| FormEntry {
                id: util::new_id(),
                key: qs_decode(k),
                value: qs_decode(v),
                enabled: true,
                kind: "text".into(),
                description: String::new(),
            })
            .collect();
        if !rows.is_empty() {
            let mode = if content_type.contains("multipart/form-data") {
                "form"
            } else {
                "urlencoded"
            };
            return Some(Body {
                mode: mode.into(),
                urlencoded: if mode == "urlencoded" { rows.clone() } else { Vec::new() },
                form: if mode == "form" { rows } else { Vec::new() },
                ..Default::default()
            });
        }
    }
    Some(Body {
        mode: "raw".into(),
        raw: Some(RawBody {
            language: if content_type.contains("xml") {
                "xml".into()
            } else if content_type.contains("html") {
                "html".into()
            } else {
                "text".into()
            },
            content: text,
        }),
        ..Default::default()
    })
}

fn is_pair(part: &str) -> bool {
    !part.is_empty()
        && part.contains('=')
        && !part.starts_with('{')
        && !part.starts_with('[')
        && !part.contains('\n')
}

fn looks_like_json(text: &str) -> bool {
    let trimmed = text.trim();
    (trimmed.starts_with('{') || trimmed.starts_with('['))
        && serde_json::from_str::<serde_json::Value>(trimmed).is_ok()
}

fn qs_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn qs_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = &bytes[i + 1..i + 3];
                match std::str::from_utf8(hex)
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
                {
                    Some(v) => {
                        out.push(v);
                        i += 3;
                    }
                    None => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn request_name(method: &str, url: &str) -> String {
    let without_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let mut parts = without_scheme.splitn(2, '/');
    let host = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let tail = path.rsplit('/').next().unwrap_or("");
    let label = if tail.is_empty() {
        host.to_string()
    } else {
        format!("{host}/{tail}")
    };
    format!("{method} {label}")
}
