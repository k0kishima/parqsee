pub mod commands;
pub mod menu;
pub mod models;
pub mod services;

use services::access::FileAccess;
use services::opened::PendingOpen;
use services::parquet::ParquetCache;
use services::store::{License, StoreProvider};
use std::sync::Arc;
use tauri::{DragDropEvent, Emitter, Manager};

/// The application menu.
///
/// Tauri's default menu carries "Close Window" on ⌘W, and a native key
/// equivalent wins over the webview's keydown — so ⌘W closed the only
/// window instead of the tab. This menu owns ⌘W / ⌘O / ⌘, itself and
/// forwards them to the frontend as a `menu` event carrying the item id.
/// File › Open Recent is the exception: its items are handled in Rust
/// (see `menu.rs`) and reach the webview as `file-drop`.
///
/// Every label comes from `menu::MenuBuilder`, which reads it from
/// `services::menu_labels` and keeps the item so `set_menu_language` can
/// retitle it when the UI's language changes. The menu starts in the
/// system's language, which is also what the webview picks on a first
/// launch, so the two agree without waiting for each other. An item's
/// label key is its menu id.
#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::App) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, PredefinedMenuItem, Submenu};

    let mut b = menu::MenuBuilder::new(app, menu::system_language());

    let settings = b.item("settings", Some("CmdOrCtrl+,"))?;
    let about = b.predefined("about", |app, text| PredefinedMenuItem::about(app, text, None))?;
    let services = b.predefined("services", PredefinedMenuItem::services)?;
    let hide = b.predefined("hide", PredefinedMenuItem::hide)?;
    let hide_others = b.predefined("hide-others", PredefinedMenuItem::hide_others)?;
    let show_all = b.predefined("show-all", PredefinedMenuItem::show_all)?;
    let quit = b.predefined("quit", PredefinedMenuItem::quit)?;
    // The app menu's own title is not labelled: macOS replaces it with the
    // bundle name whatever it is set to.
    let app_menu = Submenu::with_items(
        app,
        "Parqsee",
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &services,
            &PredefinedMenuItem::separator(app)?,
            &hide,
            &hide_others,
            &show_all,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let open = b.item("open-file", Some("CmdOrCtrl+O"))?;
    let open_folder = b.item("open-folder", Some("CmdOrCtrl+Shift+O"))?;
    let recent = menu::build_recent_submenu(app, &mut b)?;
    let close_tab = b.item("close-tab", Some("CmdOrCtrl+W"))?;
    // Always enabled: whether there is a tab to bring back is the webview's
    // to know (it owns the history), and a native item's enabled state
    // cannot follow it without a command round trip per close.
    let reopen_tab = b.item("reopen-tab", Some("CmdOrCtrl+Shift+T"))?;
    let file = b.submenu(
        "title.file",
        &[
            &open,
            &open_folder,
            &recent,
            &PredefinedMenuItem::separator(app)?,
            &close_tab,
            &reopen_tab,
        ],
    )?;

    // Every item below with a key equivalent is listed in the webview's
    // `lib/shortcuts.ts` under the same id and with the same keys (a test
    // there reads this function and checks). The menu is where a macOS
    // user looks a shortcut up, so a key that is not here is a key nobody
    // finds. Items are always enabled: whether there is a search to step
    // through or a query to run is the webview's to know, and a native
    // item's enabled state cannot follow it without a command round trip.
    let find = b.item("find", Some("CmdOrCtrl+F"))?;
    let find_next = b.item("find-next", Some("CmdOrCtrl+G"))?;
    let find_previous = b.item("find-previous", Some("CmdOrCtrl+Shift+G"))?;
    let undo = b.predefined("undo", PredefinedMenuItem::undo)?;
    let redo = b.predefined("redo", PredefinedMenuItem::redo)?;
    let cut = b.predefined("cut", PredefinedMenuItem::cut)?;
    let copy = b.predefined("copy", PredefinedMenuItem::copy)?;
    let paste = b.predefined("paste", PredefinedMenuItem::paste)?;
    let select_all = b.predefined("select-all", PredefinedMenuItem::select_all)?;
    let edit = b.submenu(
        "title.edit",
        &[
            &undo,
            &redo,
            &PredefinedMenuItem::separator(app)?,
            &cut,
            &copy,
            &paste,
            &select_all,
            &PredefinedMenuItem::separator(app)?,
            &find,
            &find_next,
            &find_previous,
        ],
    )?;

    let toggle_sidebar = b.item("toggle-sidebar", Some("CmdOrCtrl+B"))?;
    let switch_view = b.item("switch-view", Some("CmdOrCtrl+E"))?;
    let fullscreen = b.predefined("fullscreen", PredefinedMenuItem::fullscreen)?;
    let view = b.submenu(
        "title.view",
        &[
            &toggle_sidebar,
            &switch_view,
            &PredefinedMenuItem::separator(app)?,
            &fullscreen,
        ],
    )?;

    let run_query = b.item("run-query", Some("CmdOrCtrl+Enter"))?;
    let query = b.submenu("title.query", &[&run_query])?;

    let previous_tab = b.item("previous-tab", Some("CmdOrCtrl+Shift+["))?;
    let next_tab = b.item("next-tab", Some("CmdOrCtrl+Shift+]"))?;
    let minimize = b.predefined("minimize", PredefinedMenuItem::minimize)?;
    let zoom = b.predefined("zoom", PredefinedMenuItem::maximize)?;
    let window = b.submenu(
        "title.window",
        &[
            &minimize,
            &zoom,
            &PredefinedMenuItem::separator(app)?,
            &previous_tab,
            &next_tab,
        ],
    )?;

    // Help: the shortcut sheet in the webview, and the support page of the
    // product site in the UI's language (the webview knows which). Marked
    // as the Help menu so macOS adds its search field to it.
    let shortcuts = b.item("shortcuts", Some("CmdOrCtrl+/"))?;
    let help_page = b.item("help", None::<&str>)?;
    let help = b.submenu("title.help", &[&shortcuts, &PredefinedMenuItem::separator(app)?, &help_page])?;
    help.set_as_help_menu_for_nsapp()?;

    let menu = Menu::with_items(app, &[&app_menu, &file, &edit, &view, &query, &window, &help])?;
    b.finish();
    Ok(menu)
}

/// Hand the files macOS was asked to open with the app (a double-click in
/// Finder, a drop on the Dock icon, `open -a Parqsee …`) to the webview as
/// the `file-drop` event a drag and drop uses — or buffer them when it is
/// not listening yet, which is what a cold start looks like: the event
/// arrives while the window is still loading. `PendingOpen` decides which,
/// and `take_pending_files` hands the buffered ones over.
///
/// Runs in the event loop, outside `commands::guarded`, so nothing here may
/// panic — and a panic here is not even an error the webview could show: it
/// happens inside an Objective-C callback, cannot unwind through it, and
/// aborts the process. That is what a cold start did while `PendingOpen`
/// was managed from the setup hook: macOS delivers `application:openURLs:`
/// before `applicationDidFinishLaunching`, so this runs before
/// `RunEvent::Ready` — which is where Tauri runs `setup` — and `state()`
/// panicked on a store that had nothing in it yet. `PendingOpen` is managed
/// before the event loop starts for that reason, and this asks for it
/// without insisting.
#[cfg(target_os = "macos")]
fn deliver_opened(app: &tauri::AppHandle, urls: &[tauri::Url]) {
    let paths = services::opened::file_paths(urls);
    let Some(pending) = app.try_state::<Arc<PendingOpen>>() else {
        eprintln!("no place to keep the files to open: {:?}", paths);
        return;
    };
    let Some(paths) = pending.deliver(paths) else { return };
    if let Err(e) = app.emit("file-drop", &paths) {
        eprintln!("failed to forward the files to open: {}", e);
    }
    // The app is activated by Launch Services, but its window may have been
    // minimized or hidden; the file is of no use behind that.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
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

/// The App Store, on the store build; every other build owns the full
/// version. See `services::store`.
fn store_provider() -> Box<dyn StoreProvider> {
    #[cfg(all(feature = "app-store", target_os = "macos"))]
    {
        Box::new(services::store::storekit::SwiftStore)
    }
    #[cfg(not(all(feature = "app-store", target_os = "macos")))]
    {
        Box::new(services::store::AlwaysUnlocked)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
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

            // The purchase state. Read in the background; `iap_status` waits
            // for the first read (`License::status`).
            // A transaction update from the store reaches the webview as
            // the `iap-status` event.
            let license = Arc::new(License::new(store_provider()));
            let handle = app.handle().clone();
            license.set_on_change(Box::new(move |status| {
                if let Err(e) = handle.emit("iap-status", status) {
                    eprintln!("failed to forward the purchase state: {}", e);
                }
            }));
            app.manage(Arc::clone(&license));
            tauri::async_runtime::spawn(async move { license.init().await });

            #[cfg(target_os = "macos")]
            {
                app.set_menu(build_menu(app)?)?;
                menu::refresh_recent_menu(app.handle());
                app.on_menu_event(|app, event| {
                    let id = event.id().0.as_str();
                    if menu::handle_recent_menu_event(app, id) {
                        return;
                    }
                    if let Err(e) = app.emit("menu", id.to_string()) {
                        eprintln!("failed to forward menu event {id}: {e}");
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
            commands::file::take_pending_files,
            commands::file::sample_file_path,
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
            commands::query::execute_sql,
            commands::iap::iap_status,
            commands::iap::iap_products,
            commands::iap::iap_purchase,
            commands::iap::iap_restore,
            commands::menu::set_menu_language
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
        // Built rather than run so the event loop is ours: `RunEvent::Opened`
        // is the only way to hear about a file opened from Finder.
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    // Not in `setup`: a file passed at launch reaches `deliver_opened`
    // before Tauri runs the setup hook (see its comment).
    app.manage(Arc::new(PendingOpen::new()));

    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            deliver_opened(_app, urls);
        }
    });
}
