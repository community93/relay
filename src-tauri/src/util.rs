use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn new_id() -> String {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{:x}", now_ms(), n)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Best-effort "is this something we can show as text" decision, mirroring how
/// Postman decides between a pretty viewer and a download prompt.
pub fn is_textual(content_type: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    if ct.is_empty() {
        return true;
    }
    let textish = [
        "text/",
        "application/json",
        "application/xml",
        "+json",
        "+xml",
        "application/javascript",
        "application/x-javascript",
        "application/x-www-form-urlencoded",
        "application/x-ndjson",
        "application/problem+json",
        "image/svg+xml",
        "multipart/mixed",
        "application/graphql",
        "application/ld+json",
        "application/sql",
        "application/yaml",
        "application/x-yaml",
        "application/toml",
        "application/csp-report",
    ];
    if textish.iter().any(|t| ct.contains(t)) {
        return true;
    }
    if ct.starts_with("application/") {
        // application/octet-stream and friends are binary unless they say so
        return ct.contains("xml") || ct.contains("json") || ct.contains("text");
    }
    ct.starts_with("multipart/")
}

/// Rejects control characters except tab/newline/CR, then checks the ratio of
/// printable bytes. Used when the server lies about its content type.
pub fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(4096)];
    if sample.iter().any(|b| *b == 0) {
        return true;
    }
    let weird = sample
        .iter()
        .filter(|b| {
            let c = **b;
            (c < 9) || (c > 13 && c < 32) || c == 127
        })
        .count();
    !sample.is_empty() && weird * 10 > sample.len()
}
