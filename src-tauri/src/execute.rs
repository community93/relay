use std::time::Instant;

use futures_util::StreamExt;
use tauri::{AppHandle, Manager};

use crate::http;
use crate::state::AppState;
use crate::types::*;

pub fn register(app: &AppHandle, id: &str, handle: tokio::task::AbortHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let mut map = state.running.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(old) = map.insert(id.to_string(), handle) {
            old.abort();
        }
    }
}

pub fn unregister(app: &AppHandle, id: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        state
            .running
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
    }
}

#[tauri::command]
pub async fn execute(
    app: AppHandle,
    draft: Draft,
    exec_id: String,
) -> Result<ExecResponse, String> {
    let worker_app = app.clone();
    let task = tokio::spawn(async move { run(worker_app, draft).await });
    register(&app, &exec_id, task.abort_handle());

    let joined = task.await;
    unregister(&app, &exec_id);

    match joined {
        Ok(result) => result,
        Err(e) if e.is_cancelled() => {
            let mut res = http::empty_response();
            res.error_kind = Some("cancelled".into());
            res.error = Some("请求已取消".into());
            Ok(res)
        }
        Err(_) => Err("请求执行过程中发生内部错误".into()),
    }
}

#[tauri::command]
pub fn cancel(app: AppHandle, exec_id: String) -> Result<(), String> {
    let handle = app
        .try_state::<AppState>()
        .and_then(|state| {
            state
                .running
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&exec_id)
        });
    match handle {
        Some(handle) => {
            handle.abort();
            Ok(())
        }
        None => Err("该请求已经结束了".into()),
    }
}

async fn run(app: AppHandle, draft: Draft) -> Result<ExecResponse, String> {
    let mut res = http::empty_response();
    let prepared = {
        let state = app.state::<AppState>();
        http::prepare(&state, &draft, None)
    }?;
    res.final_url = prepared.url.clone();

    let started = Instant::now();
    let response = match prepared.builder.send().await {
        Ok(response) => response,
        Err(e) => {
            let (kind, message) = http::describe_error(&e);
            res.error_kind = Some(kind);
            res.error = Some(message);
            res.time_ms = http::elapsed_ms(started);
            return Ok(res);
        }
    };

    let status = response.status().as_u16();
    let headers_map = response.headers().clone();
    let final_url = response.url().to_string();
    let content_type = http::content_type_of(&headers_map);

    let (bytes, truncated) = match http::read_capped(response.bytes_stream().boxed()).await {
        Ok(pair) => pair,
        Err(message) => {
            let mut partial = http::headers_vec(&headers_map);
            let count = partial.len();
            res.status = status;
            res.status_text = http::status_text(status);
            res.headers = std::mem::take(&mut partial);
            res.header_count = count;
            res.content_type = content_type;
            res.final_url = final_url;
            res.time_ms = http::elapsed_ms(started);
            res.error_kind = Some("body".into());
            res.error = Some(message);
            return Ok(res);
        }
    };

    let shaped = http::shape_body(&content_type, &bytes);
    let headers = http::headers_vec(&headers_map);
    let header_count = headers.len();

    res.ok = (200..400).contains(&status);
    res.status = status;
    res.status_text = http::status_text(status);
    res.headers = headers;
    res.header_count = header_count;
    res.set_cookies = http::set_cookies_of(&headers_map);
    res.content_type = content_type;
    res.charset = shaped.charset;
    res.is_text = shaped.is_text;
    res.body_text = shaped.text;
    res.body_base64 = shaped.base64;
    res.body_raw_base64 = shaped.raw_base64;
    res.truncated = truncated;
    res.size_bytes = bytes.len() as u64;
    res.final_url = final_url;
    res.redirects = usize::from(res.final_url != prepared.url);
    res.time_ms = http::elapsed_ms(started);
    if truncated {
        res.note = Some(format!(
            "响应体超过 {} MB，仅保留了前面部分。",
            http::MAX_INLINE_BYTES / 1024 / 1024
        ));
    } else if shaped.lossy {
        res.note = Some("响应不是合法 UTF-8，已按 UTF-8 宽松解码显示。".into());
    }
    Ok(res)
}
