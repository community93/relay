//! Engine-level tests: the curl parser, the incremental SSE decoder and URL
//! shaping are all pure logic, so they are worth pinning down without a UI or
//! a network.

use base64::Engine;

use crate::curl::parse_curl;
use crate::http::{charset_label, redecode, resolve_url, shape_body};
use crate::sse::SseParser;
use crate::types::{Draft, Kv};

fn one(text: &str) -> crate::types::CurlImport {
    let list = parse_curl(text.to_string()).expect("should parse");
    assert_eq!(list.len(), 1, "expected exactly one command");
    list.into_iter().next().unwrap()
}

#[test]
fn curl_get_flag_moves_data_into_the_query() {
    // `-G` is curl's "send the --data as part of the URL, not as a body"
    let got = one("curl -G -d 'q=42' -d 'lang=zh 中文' 'https://api.demo.com/search'");
    assert_eq!(got.draft.method, "GET");
    assert_eq!(got.draft.url, "https://api.demo.com/search");
    let keys: Vec<_> = got.draft.params.iter().map(|p| (p.key.clone(), p.value.clone())).collect();
    assert_eq!(keys, vec![("q".to_string(), "42".to_string()), ("lang".to_string(), "zh 中文".to_string())]);
    assert!(
        got.draft.body.as_ref().map(|b| b.mode.clone()).unwrap_or_default() == "none"
            || got.draft.body.is_none(),
        "-G must not leave a body behind: {:?}",
        got.draft.body
    );
}

#[test]
fn curl_post_with_json_body_and_query() {
    let got = one(
        "curl -X POST 'https://api.demo.com/v1/orders?tab=paid' -H 'Content-Type: application/json' --data-raw '{\"a\":1}'",
    );
    assert_eq!(got.draft.method, "POST");
    assert_eq!(got.draft.url, "https://api.demo.com/v1/orders");
    assert_eq!(got.draft.params.len(), 1);
    assert_eq!(got.draft.params[0].key, "tab");
    assert_eq!(got.draft.params[0].value, "paid");
    let body = got.draft.body.unwrap();
    assert_eq!(body.mode, "raw");
    assert_eq!(body.raw.unwrap().content, "{\"a\":1}");
    assert!(got.draft.headers.iter().any(|h| h.key == "Content-Type"));
}

#[test]
fn curl_infers_post_from_data() {
    let got = one("curl https://api.demo.com/login -d 'user=abc' -d 'pass=def'");
    assert_eq!(got.draft.method, "POST");
    let body = got.draft.body.unwrap();
    assert_eq!(body.mode, "urlencoded");
    assert_eq!(body.urlencoded.len(), 2);
    assert_eq!(body.urlencoded[0].key, "user");
    assert_eq!(body.urlencoded[1].value, "def");
}

#[test]
fn curl_basic_auth_and_bundled_switches() {
    let got = one("curl -sSkL -u tom:123456 https://api.demo.com/me");
    let settings = got.draft.settings.unwrap();
    assert!(!settings.ssl_verify, "-k should disable verification");
    assert!(settings.follow_redirects, "-L should follow redirects");
    let auth = got
        .draft
        .headers
        .iter()
        .find(|h| h.key == "Authorization")
        .expect("basic auth header");
    assert_eq!(auth.value, "Basic dG9tOjEyMzQ1Ng==");
}

#[test]
fn curl_multipart_file_field_keeps_path() {
    let got = one("curl https://up.demo.com/files -F note=hello -F 'doc=@D:\\data\\report.pdf'");
    let body = got.draft.body.unwrap();
    assert_eq!(body.mode, "form");
    assert_eq!(body.form.len(), 2);
    assert_eq!(body.form[1].kind, "file");
    assert_eq!(body.form[1].value, "D:\\data\\report.pdf");
}

#[test]
fn curl_drops_computed_headers_and_reports_it() {
    let got = one("curl https://api.demo.com -H 'Content-Length: 12' -H 'Host: spoofed' -H 'X-Trace: keep'");
    assert!(got.draft.headers.iter().all(|h| h.key != "Content-Length"));
    assert!(got.draft.headers.iter().all(|h| h.key != "Host"));
    assert!(got.draft.headers.iter().any(|h| h.key == "X-Trace"));
    assert_eq!(got.warnings.len(), 2, "each dropped header should warn once");
}

#[test]
fn curl_batch_splits_on_newlines_and_semicolons() {
    let text = "curl https://a.demo.com/one \ncurl -X DELETE https://a.demo.com/two ; curl https://b.demo.com/three -d 'x=1'";
    let list = parse_curl(text.to_string()).unwrap();
    assert_eq!(list.len(), 3);
    assert_eq!(list[0].draft.url, "https://a.demo.com/one");
    assert_eq!(list[1].draft.method, "DELETE");
    assert_eq!(list[2].draft.method, "POST");
}

#[test]
fn curl_backslash_continuations_join_one_command() {
    let text = "curl -X PUT \\\n  https://api.demo.com/items/9 \\\n  -H 'Content-Type: text/plain' \\\n  -d 'done'";
    let list = parse_curl(text.to_string()).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].draft.method, "PUT");
    assert_eq!(list[0].draft.url, "https://api.demo.com/items/9");
    assert_eq!(
        list[0].draft.body.as_ref().unwrap().raw.as_ref().unwrap().content,
        "done"
    );
}

#[test]
fn curl_url_containing_the_word_curl_is_not_split() {
    let list = parse_curl("curl 'https://api.demo.com/curl?tool=curl'".to_string()).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].draft.params[0].value, "curl");
}

#[test]
fn curl_decodes_percent_escapes_in_query() {
    let got = one("curl 'https://api.demo.com/search?kw=%E4%B8%AD%E6%96%87'");
    assert_eq!(got.draft.params[0].value, "中文");
}

#[test]
fn curl_reports_unparseable_entry_in_a_batch_instead_of_failing() {
    let list = parse_curl("curl https://ok.demo.com/a\ncurl".to_string()).unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[1].warnings.iter().any(|w| w.contains("解析失败")));
}

#[test]
fn resolve_url_encodes_params_and_appends_to_existing_query() {
    let draft = Draft {
        url: "https://api.demo.com/search?fixed=1".into(),
        params: vec![
            Kv {
                id: "1".into(),
                key: "kw".into(),
                value: "中文 test".into(),
                enabled: true,
                description: String::new(),
            },
            Kv {
                id: "2".into(),
                key: "skip".into(),
                value: "x".into(),
                enabled: false,
                description: String::new(),
            },
        ],
        ..Default::default()
    };
    assert_eq!(
        resolve_url(&draft).unwrap(),
        "https://api.demo.com/search?fixed=1&kw=%E4%B8%AD%E6%96%87+test"
    );
}

#[test]
fn resolve_url_adds_https_and_rejects_other_schemes() {
    assert_eq!(
        resolve_url(&Draft {
            url: "api.demo.com/x".into(),
            ..Default::default()
        })
        .unwrap(),
        "https://api.demo.com/x"
    );
    assert!(resolve_url(&Draft {
        url: "ftp://api.demo.com".into(),
        ..Default::default()
    })
    .is_err());
    assert!(resolve_url(&Draft {
        url: "   ".into(),
        ..Default::default()
    })
    .is_err());
}

#[test]
fn binary_bodies_are_base64_not_text() {
    let png = [0x89u8, b'P', b'N', b'G', 0, 1, 2, 3];
    let shaped = shape_body("image/png", &png);
    assert!(!shaped.is_text);
    assert!(shaped.text.is_none());
    assert!(!shaped.lossy);
    assert!(shaped.base64.unwrap().starts_with("iVBORw"));
}

#[test]
fn json_without_content_type_still_reads_as_text() {
    let shaped = shape_body("", b"{\"ok\":true}");
    assert!(shaped.is_text);
    assert_eq!(shaped.text.unwrap(), "{\"ok\":true}");
}

fn drain(parser: &mut SseParser, bytes: &[u8]) -> Vec<crate::types::SseEvent> {
    parser.feed(bytes)
}

#[test]
fn sse_parses_named_events_and_ids() {
    let mut parser = SseParser::default();
    let events = drain(&mut parser, b"event: order\r\ndata: {\"id\":1}\r\nid: 42\r\n\r\n");
    let message = events.iter().find(|e| e.kind == "message").expect("message");
    assert_eq!(message.event.as_deref(), Some("order"));
    assert_eq!(message.id.as_deref(), Some("42"));
    assert_eq!(message.data, "{\"id\":1}");
}

#[test]
fn sse_joins_multiline_data_and_skips_comments() {
    let mut parser = SseParser::default();
    let mut events = drain(&mut parser, b": keep-alive\n");
    events.extend(drain(&mut parser, b"data: line1\ndata: line2\n\n"));
    let message = events.iter().find(|e| e.kind == "message").unwrap();
    assert_eq!(message.data, "line1\nline2");
}

#[test]
fn sse_survives_a_crlf_split_across_packets() {
    let mut parser = SseParser::default();
    let mut got = Vec::new();
    for byte in b"data: a\r\n\r\n" {
        got.extend(drain(&mut parser, &[*byte]));
    }
    got.extend(parser.finish());
    let message = got.iter().find(|e| e.kind == "message").expect("message");
    assert_eq!(message.data, "a");
}

#[test]
fn sse_emits_a_trailing_frame_without_blank_line() {
    let mut parser = SseParser::default();
    let mut got = drain(&mut parser, b"retry: 3000\ndata: last");
    got.extend(parser.finish());
    let message = got.iter().find(|e| e.kind == "message").expect("message");
    assert_eq!(message.data, "last");
    assert_eq!(message.retry, Some(3000));
}

#[test]
fn sse_ignores_empty_frames() {
    let mut parser = SseParser::default();
    let events = drain(&mut parser, b"\n\n\n");
    assert!(events.iter().all(|e| e.kind != "message"));
}

#[test]
fn gbk_declared_charset_is_decoded() {
    let (gbk_bytes, _, _) = encoding_rs::GBK.encode(r#"{"city":"上海浦东"}"#);
    let shaped = shape_body("application/json; charset=GBK", &gbk_bytes);
    assert!(shaped.is_text);
    assert_eq!(shaped.text.as_deref().unwrap(), r#"{"city":"上海浦东"}"#);
    assert_eq!(shaped.charset.as_deref(), Some("gbk"));
    assert!(shaped.raw_base64.is_some(), "raw bytes should come back for a manual override");
}

#[test]
fn gbk_without_declared_charset_is_sniffed() {
    let (gbk_bytes, _, _) = encoding_rs::GBK.encode(r#"{"city":"北京"}"#);
    let shaped = shape_body("application/json", &gbk_bytes);
    assert_eq!(shaped.text.as_deref().unwrap(), r#"{"city":"北京"}"#);
    assert_eq!(shaped.charset.as_deref(), Some("gb18030"));
    assert!(!shaped.lossy);
}

#[test]
fn utf8_bodies_are_not_mislabelled_as_cjk() {
    let text = r#"{"city":"广州"}"#;
    let shaped = shape_body("application/json", text.as_bytes());
    assert_eq!(shaped.charset.as_deref(), Some("utf-8"));
    assert_eq!(shaped.text.as_deref().unwrap(), text);
    assert!(shaped.raw_base64.is_none());
}

#[test]
fn charset_label_handles_quotes() {
    assert_eq!(charset_label("text/html;charset=\"utf-8\"").as_deref(), Some("utf-8"));
    assert_eq!(charset_label("application/json; charset=gb2312").as_deref(), Some("gb2312"));
    assert_eq!(charset_label("application/json").as_deref(), None);
}

#[test]
fn redecode_switches_charset_on_the_same_bytes() {
    let (gbk_bytes, _, _) = encoding_rs::GBK.encode("内网接口");
    let encoded = base64::engine::general_purpose::STANDARD.encode(&gbk_bytes);
    let decoded = redecode(encoded.clone(), "gbk".into()).unwrap();
    assert_eq!(decoded, "内网接口");
    assert!(redecode(encoded, "not-a-real-charset".into()).is_err());
}

fn collect(parser: &mut crate::sse::StreamParser, bytes: &[u8]) -> Vec<crate::types::SseEvent> {
    parser.feed(bytes)
}

#[test]
fn auto_mode_keeps_the_first_sse_frame_intact() {
    // Regression: peeking at the first line used to consume it, so the very first
    // frame lost its `event:` name.
    let mut parser = crate::sse::StreamParser::new("auto", "application/octet-stream");
    let mut got = collect(&mut parser, b"event: delta\ndata: {\"seq\":1}\n\n");
    got.extend(collect(&mut parser, b"event: delta\ndata: {\"seq\":2}\n\n"));
    let messages: Vec<_> = got.iter().filter(|e| e.kind == "message").collect();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].event.as_deref(), Some("delta"));
    assert_eq!(messages[1].event.as_deref(), Some("delta"));
}

#[test]
fn auto_mode_detects_ndjson_lines() {
    let mut parser = crate::sse::StreamParser::new("auto", "application/octet-stream");
    let mut got = collect(&mut parser, b"{\"seq\":1}\n{\"seq\":2}\n");
    got.extend(parser.finish());
    let messages: Vec<_> = got.iter().filter(|e| e.kind == "message").collect();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].event.as_deref(), Some("json"));
    assert_eq!(messages[1].data, "{\"seq\":2}");
}

#[test]
fn auto_mode_falls_back_to_text_chunks_without_newlines() {
    let mut parser = crate::sse::StreamParser::new("auto", "application/octet-stream");
    let mut got = collect(&mut parser, b"chunk-a-chunk-b");
    got.extend(parser.finish());
    assert!(got.iter().any(|e| e.data.contains("chunk-a-chunk-b")), "{:?}", got);
}

#[test]
fn content_type_hints_skip_sniffing() {
    let parser = crate::sse::StreamParser::new("auto", "text/event-stream");
    assert!(matches!(parser, crate::sse::StreamParser::Sse(_)));
    let parser = crate::sse::StreamParser::new("auto", "application/x-ndjson");
    assert!(matches!(parser, crate::sse::StreamParser::Lines { .. }));
    let parser = crate::sse::StreamParser::new("auto", "text/plain; charset=utf-8");
    assert!(matches!(parser, crate::sse::StreamParser::Text { .. }));
}

#[test]
fn a_charset_declared_on_the_stream_is_honoured() {
    // "事件" in GBK — those bytes are not valid UTF-8 at all, so without the
    // declaration the reader can only replace them
    let frame = b"data: \xca\xc2\xbc\xfe\n\n";

    let mut declared = crate::sse::StreamParser::new("sse", "text/event-stream; charset=gbk");
    let mut events = declared.feed(frame);
    events.extend(declared.finish());
    let data = events
        .iter()
        .find(|e| e.kind == "message")
        .map(|e| e.data.clone())
        .unwrap_or_default();
    assert_eq!(data, "事件", "{:?}", data);

    let mut silent = crate::sse::StreamParser::new("sse", "text/event-stream");
    let mut lost = silent.feed(frame);
    lost.extend(silent.finish());
    let text = lost
        .iter()
        .find(|e| e.kind == "message")
        .map(|e| e.data.clone())
        .unwrap_or_default();
    assert!(!text.contains("事件"), "{text:?}");
}

#[test]
fn consecutive_sse_frames_do_not_accumulate_data() {
    // Regression: the data buffer used to survive dispatch, so frame N carried the
    // payloads of frames 1..N.
    let mut parser = SseParser::default();
    let mut events = parser.feed(b"event: a\ndata: first\n\n");
    events.extend(parser.feed(b"event: b\ndata: second\n\n"));
    events.extend(parser.feed(b"data: third\n\n"));
    let messages: Vec<_> = events.iter().filter(|e| e.kind == "message").collect();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0].data, "first");
    assert_eq!(messages[1].data, "second");
    assert_eq!(messages[1].event.as_deref(), Some("b"));
    assert_eq!(messages[2].data, "third");
    assert_eq!(messages[2].event.as_deref(), None);
}

#[test]
fn an_id_shows_only_on_the_frame_that_sent_it() {
    // Deliberately not the browser rule that the last event ID persists: when
    // debugging it matters which frame actually carried the id.
    let mut parser = SseParser::default();
    let mut events = parser.feed(b"id: 7\ndata: one\n\n");
    events.extend(parser.feed(b"data: two\n\n"));
    let messages: Vec<_> = events.iter().filter(|e| e.kind == "message").collect();
    assert_eq!(messages[0].id.as_deref(), Some("7"));
    assert_eq!(messages[1].id, None);
}
