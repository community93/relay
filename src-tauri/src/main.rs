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

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

/// 托盘菜单要能被 tray_set_next 就地更新文案，所以把 Menu 存在托管状态里。
struct TrayMenu(std::sync::Mutex<Option<Menu<tauri::Wry>>>);

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.as_ref().show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 收进托盘要同时藏原生窗口和 webview 控制器：WebView2 的页面可见性只跟控制器
/// 走，只藏 HWND 的话页面仍报告可见，心跳补检等"回到前台"逻辑也不会触发。
#[tauri::command]
fn window_hide(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())?;
    window.as_ref().hide().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_show(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.as_ref().show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

/// 前端在「关闭即退出」的设置下走这一条；托盘菜单的退出也走这一条。
#[tauri::command]
fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

/// 定时计划的"下次触发"随心跳更新到托盘菜单里，让常驻状态看得见。
#[tauri::command]
fn tray_set_next(state: tauri::State<TrayMenu>, text: String) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(menu) = guard.as_ref() {
        if let Some(item) = menu.get("next").and_then(|entry| entry.as_menuitem().cloned()) {
            item.set_text(format!("定时计划：{text}")).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .manage(automation::Automation::default())
        .manage(TrayMenu(std::sync::Mutex::new(None)))
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "显示 Relay", true, None::<&str>)?;
            let next = MenuItem::with_id(app, "next", "定时计划：无", false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Relay", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &next, &quit])?;
            *app.state::<TrayMenu>().0.lock().unwrap() = Some(menu.clone());
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("Relay 必须带窗口图标").clone())
                .tooltip("Relay")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗不退出：先把窗口藏起来（用户看到的就是"关掉了"），再让前端按
            // 设置决定就此收进托盘还是整个退出。就算前端卡死了，托盘菜单里仍然
            // 有「退出 Relay」可用。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                if let Some(webview) = window.app_handle().get_webview_window("main") {
                    let _ = webview.as_ref().hide();
                }
                let _ = window.emit("close-requested", ());
            }
        })
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
            automation::automation_reply,
            window_hide,
            window_show,
            app_exit,
            tray_set_next
        ])
        .run(tauri::generate_context!())
        .expect("Relay 启动失败");
}
