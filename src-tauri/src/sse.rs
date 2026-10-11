use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tauri::{ipc::Channel, AppHandle, Manager};

use crate::execute::{register, unregister};
use crate::http;
use crate::state::AppState;
use crate::types::*;
use crate::util;

/// Read a wire line under the charset the server declared, when it declared one
/// we can act on. Without a label the lossy UTF-8 read stays — a stream that
/// never says is treated as UTF-8, exactly as before.
fn read_text(bytes: &[u8], charset: &Option<String>) -> String {
    match charset {
        Some(label) => http::decode_lossy(bytes, label),
        None => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// A declared UTF-8 (or ASCII) stream needs no transcoding step at all.
fn usable_label(content_type: &str) -> Option<String> {
    let label = http::charset_label(content_type)?;
    let lowered = label.trim().to_ascii_lowercase();
    if matches!(lowered.as_str(), "utf-8" | "utf8" | "us-ascii" | "ascii") {
        return None;
    }
    Some(lowered)
}

/// Incremental `text/event-stream` decoder. Fed with raw bytes so that frames
/// split across network chunks — including a `\r\n` cut in half — still parse.
#[derive(Default)]
pub(crate) struct SseParser {
    pending: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
    id: Option<String>,
    retry: Option<u64>,
    charset: Option<String>,
}

impl SseParser {
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        let mut out = Vec::new();
        self.pending.extend_from_slice(bytes);
        while let Some((line, _)) = take_line(&mut self.pending, false) {
            if let Some(evt) = self.process_line(&line) {
                out.push(evt);
            }
        }
        out
    }

    /// Called once the stream ended; a final frame with no trailing blank line
    /// is still worth showing to the user.
    pub(crate) fn finish(&mut self) -> Vec<SseEvent> {
        let mut out = Vec::new();
        while let Some((line, _)) = take_line(&mut self.pending, true) {
            if let Some(evt) = self.process_line(&line) {
                out.push(evt);
            }
            break;
        }
        if !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            if let Some(evt) = self.process_line(&line) {
                out.push(evt);
            }
        }
        if let Some(evt) = self.dispatch() {
            out.push(evt);
        }
        out
    }

    fn process_line(&mut self, line: &[u8]) -> Option<SseEvent> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line[0] == b':' {
            return None;
        }
        let text = read_text(line, &self.charset);
        let (field, value) = match text.split_once(':') {
            Some((f, v)) => (f.trim(), v.strip_prefix(' ').unwrap_or(v)),
            None => (text.trim(), ""),
        };
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            "id" => {
                if !value.contains('\0') {
                    self.id = Some(value.to_string());
                }
            }
            "retry" => self.retry = value.trim().parse::<u64>().ok(),
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseEvent> {
        if self.data.is_empty() {
            self.event = None;
            return None;
        }
        // Take the buffer: leaving it in place would make every later frame
        // re-dispatch all of the data seen so far.
        let data = std::mem::take(&mut self.data).join("\n");
        Some(SseEvent {
            kind: "message".into(),
            at: util::now_ms(),
            event: self.event.take(),
            data,
            id: self.id.take(),
            retry: self.retry.take(),
            status: None,
            headers: None,
            message: None,
            bytes: 0,
            raw_base64: None,
        })
    }
}

/// Pops one line off the front of `buf`. A trailing lone `\r` is treated as
/// incomplete so a `\r\n` split across chunks is not mistaken for two lines.
fn take_line(buf: &mut Vec<u8>, at_eof: bool) -> Option<(Vec<u8>, usize)> {
    let idx = buf.iter().position(|b| *b == b'\n' || *b == b'\r')?;
    if !at_eof && buf[idx] == b'\r' && idx + 1 == buf.len() {
        return None;
    }
    let line = buf[..idx].to_vec();
    let mut consume = idx + 1;
    if buf[idx] == b'\r' && buf.get(idx + 1) == Some(&b'\n') {
        consume = idx + 2;
    }
    buf.drain(..consume);
    Some((line, consume))
}

/// Wraps the concrete frame decoder so the caller can ask for SSE, NDJSON or raw
/// text, or let us decide from the first complete line that arrives.
pub enum StreamParser {
    Sse(SseParser),
    Lines {
        pending: Vec<u8>,
        label: String,
        charset: Option<String>,
    },
    Text {
        charset: Option<String>,
    },
    Auto {
        pending: Vec<u8>,
        charset: Option<String>,
    },
}

impl StreamParser {
    /// `content_type` is only consulted in auto mode: a server that says
    /// `text/event-stream` or `application/x-ndjson` does not need sniffing.
    /// Its `charset=` is honoured in every mode — a GBK stream that says so
    /// should not need the user to pick a codepage by hand.
    pub fn new(format: &str, content_type: &str) -> Self {
        let ct = content_type.to_ascii_lowercase();
        let charset = usable_label(&ct);
        match format {
            "ndjson" => StreamParser::lines(charset),
            "text" => StreamParser::Text { charset },
            "sse" => StreamParser::Sse(SseParser {
                charset,
                ..Default::default()
            }),
            _ => {
                if ct.contains("event-stream") {
                    StreamParser::Sse(SseParser {
                        charset,
                        ..Default::default()
                    })
                } else if ct.contains("ndjson") || ct.contains("jsonl") {
                    StreamParser::lines(charset)
                } else if ct.starts_with("text/plain") || ct.starts_with("text/html") {
                    StreamParser::Text { charset }
                } else {
                    StreamParser::Auto {
                        pending: Vec::new(),
                        charset,
                    }
                }
            }
        }
    }

    fn lines(charset: Option<String>) -> Self {
        StreamParser::Lines {
            pending: Vec::new(),
            label: "json".into(),
            charset,
        }
    }

    /// The sniffing path decides a parser mid-stream; the declared charset has to
    /// survive that handover.
    fn set_charset(&mut self, charset: &Option<String>) {
        match self {
            StreamParser::Sse(parser) => parser.charset = charset.clone(),
            StreamParser::Lines { charset: slot, .. } => *slot = charset.clone(),
            StreamParser::Text { charset: slot } => *slot = charset.clone(),
            StreamParser::Auto { charset: slot, .. } => *slot = charset.clone(),
        }
    }

    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        match self {
            StreamParser::Sse(parser) => parser.feed(bytes),
            StreamParser::Text { charset } => vec![chunk_event("chunk", &read_text(bytes, charset))],
            StreamParser::Lines {
                pending,
                label,
                charset,
            } => {
                let mut out = Vec::new();
                pending.extend_from_slice(bytes);
                while let Some((line, _)) = take_line(pending, false) {
                    if !line.iter().any(|b| !b.is_ascii_whitespace()) {
                        continue;
                    }
                    out.push(chunk_event(label, &read_text(&line, charset)));
                }
                out
            }
            StreamParser::Auto { pending, charset } => {
                pending.extend_from_slice(bytes);
                let decided = match classify_head(pending) {
                    Some(parser) => parser,
                    // No line boundary yet and nothing conclusive: keep buffering,
                    // but never hold a runaway stream hostage.
                    None if pending.len() < 65_536 => return Vec::new(),
                    None => StreamParser::Text {
                        charset: charset.clone(),
                    },
                };
                let buffered = std::mem::take(pending);
                let declared = charset.clone();
                *self = decided;
                self.set_charset(&declared);
                self.feed(&buffered)
            }
        }
    }

    pub(crate) fn finish(&mut self) -> Vec<SseEvent> {
        match self {
            StreamParser::Sse(parser) => parser.finish(),
            StreamParser::Lines {
                pending,
                label,
                charset,
            } => {
                let mut out = Vec::new();
                if pending.iter().any(|b| !b.is_ascii_whitespace()) {
                    out.push(chunk_event(label, &read_text(pending, charset)));
                }
                pending.clear();
                out
            }
            StreamParser::Text { .. } => Vec::new(),
            StreamParser::Auto { pending, charset } => {
                if pending.is_empty() {
                    return Vec::new();
                }
                let buffered = std::mem::take(pending);
                let declared = charset.clone();
                *self = classify_head(&buffered).unwrap_or(StreamParser::Text { charset: None });
                self.set_charset(&declared);
                let mut out = self.feed(&buffered);
                out.extend(self.finish());
                out
            }
        }
    }
}

/// Decides from the leading bytes *without consuming them*, so the frame that
/// gave the evidence is still handed to the chosen decoder.
fn classify_head(bytes: &[u8]) -> Option<StreamParser> {
    let index = bytes.iter().position(|b| *b == 10 || *b == 13)?;
    let head = String::from_utf8_lossy(&bytes[..index]).trim_start().to_string();
    if head.is_empty() || head.starts_with(':') {
        return Some(StreamParser::Sse(SseParser::default()));
    }
    if head.starts_with("data:")
        || head.starts_with("event:")
        || head.starts_with("id:")
        || head.starts_with("retry:")
    {
        return Some(StreamParser::Sse(SseParser::default()));
    }
    if head.starts_with('{') || head.starts_with('[') {
        return Some(StreamParser::lines(None));
    }
    Some(StreamParser::Text { charset: None })
}

fn chunk_event(label: &str, data: &str) -> SseEvent {
    SseEvent {
        kind: "message".into(),
        at: util::now_ms(),
        event: Some(label.to_string()),
        data: data.to_string(),
        ..Default::default()
    }
}

#[tauri::command]
pub async fn stream_sse(
    app: AppHandle,
    draft: Draft,
    exec_id: String,
    first_byte_timeout_ms: Option<u64>,
    stream_format: Option<String>,
    sink: Channel<SseEvent>,
) -> Result<(), String> {
    let worker = app.clone();
    let id_for_task = exec_id.clone();
    let format = stream_format.unwrap_or_else(|| "auto".into());
    let task = tokio::spawn(async move {
        session(worker, draft, id_for_task, first_byte_timeout_ms, format, sink).await;
    });
    register(&app, &exec_id, task.abort_handle());
    Ok(())
}

async fn session(
    app: AppHandle,
    mut draft: Draft,
    exec_id: String,
    first_byte_timeout_ms: Option<u64>,
    format: String,
    sink: Channel<SseEvent>,
) {
    // A streaming request must not be killed by the ordinary request timeout.
    if let Some(settings) = draft.settings.as_mut() {
        settings.timeout_ms = None;
    }

    let prepared = {
        let state = app.state::<AppState>();
        http::prepare(&state, &draft, Some("text/event-stream"))
    };
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(message) => {
            emit(
                &sink,
                SseEvent {
                    kind: "error".into(),
                    at: util::now_ms(),
                    message: Some(message),
                    ..Default::default()
                },
            );
            unregister(&app, &exec_id);
            return;
        }
    };

    let started = Instant::now();
    let response = match prepared.builder.send().await {
        Ok(response) => response,
        Err(e) => {
            let (kind, message) = http::describe_error(&e);
            emit(
                &sink,
                SseEvent {
                    kind: "error".into(),
                    at: util::now_ms(),
                    message: Some(message),
                    event: Some(kind),
                    ..Default::default()
                },
            );
            unregister(&app, &exec_id);
            return;
        }
    };

    let status = response.status().as_u16();
    let headers_map = response.headers().clone();
    let headers = http::headers_vec(&headers_map);
    emit(
        &sink,
        SseEvent {
            kind: "open".into(),
            at: util::now_ms(),
            status: Some(status),
            headers: Some(headers),
            message: Some(prepared.url.clone()),
            bytes: 0,
            ..Default::default()
        },
    );

    if status >= 400 {
        let body = response.text().await.unwrap_or_default();
        emit(
            &sink,
            SseEvent {
                kind: "error".into(),
                at: util::now_ms(),
                message: Some(if body.trim().is_empty() {
                    format!("HTTP {status}")
                } else {
                    body
                }),
                status: Some(status),
                ..Default::default()
            },
        );
        emit_done(&sink, started, 0, 0);
        unregister(&app, &exec_id);
        return;
    }

    let mut stream = response.bytes_stream().boxed();
    let content_type = http::content_type_of(&headers_map);
    let wire_charset = usable_label(&content_type);
    let mut parser = StreamParser::new(&format, &content_type);
    let mut total_bytes: u64 = 0;
    let mut total_events: u64 = 0;

    let first = match first_byte_timeout_ms.filter(|v| *v > 0) {
        Some(ms) => {
            match tokio::time::timeout(Duration::from_millis(ms), stream.next()).await {
                Ok(chunk) => chunk,
                Err(_) => {
                    emit(
                        &sink,
                        SseEvent {
                            kind: "error".into(),
                            at: util::now_ms(),
                            event: Some("timeout".into()),
                            message: Some(format!(
                                "等待首个数据帧超时（{ms} ms）。服务端可能并未以 text/event-stream 返回。"
                            )),
                            ..Default::default()
                        },
                    );
                    emit_done(&sink, started, total_bytes, total_events);
                    unregister(&app, &exec_id);
                    return;
                }
            }
        }
        None => stream.next().await,
    };

    let mut pending_first = Some(first);
    while let Some(chunk) = match pending_first.take() {
        Some(chunk) => chunk,
        None => stream.next().await,
    } {
        match chunk {
            Ok(bytes) => {
                total_bytes += bytes.len() as u64;
                // the untouched wire content, for troubleshooting framing;
                // `bytes` here is this chunk's size, not the running total.
                // The base64 copy only rides along when UTF-8 could not read it —
                // a clean chunk decodes identically under every label we offer.
                let redecodable = std::str::from_utf8(&bytes).is_err();
                emit(
                    &sink,
                    SseEvent {
                        kind: "raw".into(),
                        at: util::now_ms(),
                        data: read_text(&bytes, &wire_charset),
                        bytes: bytes.len() as u64,
                        raw_base64: redecodable.then(|| http::encode_base64(&bytes)),
                        ..Default::default()
                    },
                );
                for mut evt in parser.feed(&bytes) {
                    evt.bytes = total_bytes;
                    total_events += 1;
                    emit(&sink, evt);
                }
            }
            Err(e) => {
                let (kind, message) = http::describe_error(&e);
                emit(
                    &sink,
                    SseEvent {
                        kind: "error".into(),
                        at: util::now_ms(),
                        event: Some(kind),
                        message: Some(message),
                        bytes: total_bytes,
                        ..Default::default()
                    },
                );
                break;
            }
        }
    }

    for mut evt in parser.finish() {
        evt.bytes = total_bytes;
        total_events += 1;
        emit(&sink, evt);
    }

    emit_done(&sink, started, total_bytes, total_events);
    unregister(&app, &exec_id);
}

fn emit(sink: &Channel<SseEvent>, event: SseEvent) {
    let _ = sink.send(event);
}

fn emit_done(sink: &Channel<SseEvent>, started: Instant, bytes: u64, events: u64) {
    let _ = sink.send(SseEvent {
        kind: "done".into(),
        at: util::now_ms(),
        message: Some(format!(
            "连接结束：{} 个事件，{} 字节，耗时 {}",
            events,
            bytes,
            http::elapsed_ms(started)
        )),
        bytes,
        ..Default::default()
    });
}
