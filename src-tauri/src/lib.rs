use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

#[tauri::command]
fn open_break_window(app: tauri::AppHandle, break_minutes: u32) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("break") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = WebviewUrl::App(format!("index.html?break=1&minutes={break_minutes}").into());
    WebviewWindowBuilder::new(&app, "break", url)
        .title("Cat Break (Test)")
        .inner_size(900.0, 620.0)
        .always_on_top(true)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn close_break_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("break") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show Control Panel", true, None::<&str>)?;
    let toggle_item = MenuItem::with_id(app, "toggle", "Start / Pause", true, None::<&str>)?;
    let skip_item = MenuItem::with_id(app, "skip", "Skip Current Cycle", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&show_item, &toggle_item, &skip_item, &separator, &quit_item],
    )?;

    TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "toggle" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("tray-action", "toggle-timer");
                }
            }
            "skip" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("tray-action", "skip-cycle");
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            build_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_break_window,
            close_break_window,
            show_main_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
