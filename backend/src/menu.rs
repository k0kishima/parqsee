//! File › Open Recent: the native submenu over Recent Files.
//!
//! The webview owns the list's two other surfaces (the Welcome screen and
//! the top row's panel); this one is the menu bar's, where a Mac user looks
//! first. It is rebuilt from the store — the same `bookmarks.json` the
//! webview mirrors — after every change to Recent Files (`remember_file`,
//! `remove_recent_file`, `clear_recent_files`) and once at launch, so the
//! three never disagree. The entries are not probed: an item whose file is
//! gone opens through the ordinary path, which shows "File not found" and
//! drops the entry, the same as a stale row on the Welcome screen.
//!
//! A pick is emitted as the `file-drop` event a drag and drop or a Finder
//! open uses, so it is an ordinary open — `remember_file` included, and
//! `services::access` stays the only owner of what is readable under the
//! sandbox. Clear Menu clears the store here and tells the webview with
//! `recent-files-cleared`. Neither reaches the webview's `menu` event.
//!
//! Only the store build for macOS has the menu at all (`build_menu` in
//! `lib.rs`); everywhere else `RecentMenu` is never managed and
//! `refresh_recent_menu` finds nothing to do.

use crate::services::access::FileAccess;
use crate::services::recent_menu::{recent_menu_items, recent_path, RecentMenuItem, CLEAR_RECENT_ID};
use std::sync::Arc;
use tauri::menu::{MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// The submenu, kept as managed state so it can be rebuilt in place.
pub struct RecentMenu(Submenu<Wry>);

/// The empty Open Recent submenu for `build_menu`; `refresh_recent_menu`
/// fills it once the store is managed.
pub fn build_recent_submenu(app: &tauri::App) -> tauri::Result<Submenu<Wry>> {
    let submenu = Submenu::new(app, "Open Recent", true)?;
    app.manage(RecentMenu(submenu.clone()));
    Ok(submenu)
}

/// Rebuild the submenu from Recent Files as recorded. Menu items must be
/// created and dropped on the main thread; the rebuild is handed there and
/// this returns at once, so a command that changed the list does not wait
/// on the menu bar.
pub fn refresh_recent_menu(app: &AppHandle) {
    let (Some(menu), Some(access)) = (app.try_state::<RecentMenu>(), app.try_state::<Arc<FileAccess>>()) else {
        return;
    };
    let items = recent_menu_items(&access.recent_entries());
    let submenu = menu.0.clone();
    let handle = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        if let Err(e) = rebuild(&handle, &submenu, &items) {
            eprintln!("could not rebuild the Open Recent menu: {e}");
        }
    }) {
        eprintln!("could not reach the main thread for the Open Recent menu: {e}");
    }
}

fn rebuild(handle: &AppHandle, submenu: &Submenu<Wry>, items: &[RecentMenuItem]) -> tauri::Result<()> {
    while submenu.remove_at(0)?.is_some() {}
    for item in items {
        submenu.append(&MenuItem::with_id(handle, &item.id, &item.label, true, None::<&str>)?)?;
    }
    if !items.is_empty() {
        submenu.append(&PredefinedMenuItem::separator(handle)?)?;
    }
    // Disabled rather than absent while there is nothing to clear, as the
    // system's own Open Recent menus have it.
    submenu.append(&MenuItem::with_id(handle, CLEAR_RECENT_ID, "Clear Menu", !items.is_empty(), None::<&str>)?)?;
    Ok(())
}

/// Act on a menu event when it is one of this submenu's; returns whether it
/// was, so the caller forwards the rest to the webview as before.
pub fn handle_recent_menu_event(app: &AppHandle, id: &str) -> bool {
    if id == CLEAR_RECENT_ID {
        if let Some(access) = app.try_state::<Arc<FileAccess>>() {
            access.clear_recent();
        }
        refresh_recent_menu(app);
        if let Err(e) = app.emit("recent-files-cleared", ()) {
            eprintln!("failed to tell the webview Recent Files were cleared: {e}");
        }
        return true;
    }
    if let Some(path) = recent_path(id) {
        if let Err(e) = app.emit("file-drop", vec![path.to_string()]) {
            eprintln!("failed to open {path} from the Open Recent menu: {e}");
        }
        return true;
    }
    false
}
