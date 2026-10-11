#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod curl;
mod automation;
mod execute;
mod http;
mod sse;
mod state;
mod store;
#[cfg(test)]
mod tests_engine;
mod types;
mod util;
mod ws;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .manage(automation::Automation::default())
        .invoke_handler(tauri::generate_handler![
            store::load_doc,
            store::save_doc,
            store::data_path,
            store::migrate_data_directory,
            store::file_meta,
            store::save_text,
            store::save_base64,
            execute::execute,
            execute::cancel,
            http::redecode,
            http::redecode_chunks,
            sse::stream_sse,
            ws::ws_connect,
            ws::ws_send,
            ws::ws_close,
            ws::ws_disconnect,
            curl::parse_curl,
            automation::automation_start,
            automation::automation_stop,
            automation::automation_status,
            automation::automation_reply
        ])
        .run(tauri::generate_context!())
        .expect("Relay 启动失败");
}
