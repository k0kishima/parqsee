pub mod commands;
pub mod models;
pub mod services;

use services::access::FileAccess;
use services::parquet::ParquetCache;
use std::sync::Arc;
use tauri::{DragDropEvent, Emitter, Manager};

/// The application menu.
///
/// Tauri's default menu carries "Close Window" on ⌘W, and a native key
/// equivalent wins over the webview's keydown — so ⌘W closed the only
/// window instead of the tab. This menu owns ⌘W / ⌘O / ⌘, itself and
/// forwards them to the frontend as a `menu` event carrying the item id.
#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::App) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let app_menu = Submenu::with_items(
        app,
        "Parqsee",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let open = MenuItem::with_id(app, "open-file", "Open…", true, Some("CmdOrCtrl+O"))?;
    let open_folder =
        MenuItem::with_id(app, "open-folder", "Open Folder…", true, Some("CmdOrCtrl+Shift+O"))?;
    let close_tab = MenuItem::with_id(app, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[&open, &open_folder, &PredefinedMenuItem::separator(app)?, &close_tab],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

/// The platform's security-scoped bookmarks; see `services::access`.
fn bookmark_provider() -> Box<dyn services::access::BookmarkProvider> {
    #[cfg(target_os = "macos")]
    {
        Box::new(services::access::macos::MacBookmarks)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(services::access::NoopBookmarks)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Workspace roots and recent files persist in the app data
            // directory (inside the sandbox container on macOS). A directory
            // that cannot be created leaves them in memory for this session
            // rather than refusing to start.
            let data_dir = app.path().app_data_dir().ok().and_then(|dir| {
                std::fs::create_dir_all(&dir)
                    .map_err(|e| eprintln!("could not create {}: {}", dir.display(), e))
                    .ok()
                    .map(|_| dir)
            });
            let access = Arc::new(FileAccess::load(bookmark_provider(), data_dir.as_deref()));
            app.manage(Arc::clone(&access));
            app.manage(ParquetCache::with_access(access));

            #[cfg(target_os = "macos")]
            {
                app.set_menu(build_menu(app)?)?;
                app.on_menu_event(|app, event| {
                    if let Err(e) = app.emit("menu", event.id().0.clone()) {
                        eprintln!("failed to forward menu event {}: {}", event.id().0, e);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::file::open_parquet_file,
            commands::file::get_file_info,
            commands::file::check_file_exists,
            commands::file::list_directory,
            commands::file::remember_file,
            commands::file::list_recent_files,
            commands::file::remove_recent_file,
            commands::file::clear_recent_files,
            commands::workspace::list_workspace_roots,
            commands::workspace::add_workspace_root,
            commands::workspace::remove_workspace_root,
            commands::workspace::list_session_tabs,
            commands::workspace::save_session,
            commands::data::read_parquet_data,
            commands::data::count_parquet_data,
            commands::data::export_data,
            commands::data::export_default_dir,
            commands::data::evict_cache,
            commands::query::execute_sql
        ])
        .on_window_event(|window, event| {
            // Forward the drop to the frontend. This callback runs outside
            // `commands::guarded`, so a panic here would unwind through the
            // event loop; report a failed emit instead.
            if let tauri::WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                if let Err(e) = window.emit("file-drop", paths) {
                    eprintln!("failed to forward dropped files: {}", e);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
