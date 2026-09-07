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
//! Only macOS has the menu at all (`build_menu` in `lib.rs`); everywhere
//! else `RecentMenu` is never managed and `refresh_recent_menu` finds
//! nothing to do.
//!
//! This module also owns the menu's language. `MenuBuilder` labels every
//! item from `services::menu_labels` as `build_menu` creates it and keeps
//! the handles; `set_language` retitles them all in place. Rebuilding the
//! whole menu instead would mean re-managing `RecentMenu` and losing the
//! submenu the Open Recent items are appended to, for no gain: a title is
//! all that changes.

use crate::services::access::FileAccess;
use crate::services::menu_labels::{self, Labels};
use crate::services::recent_menu::{recent_menu_items, recent_path, RecentMenuItem, CLEAR_RECENT_ID};
use std::sync::{Arc, Mutex};
use tauri::menu::{IsMenuItem, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// The submenu, kept as managed state so it can be rebuilt in place.
pub struct RecentMenu(Submenu<Wry>);

/// The empty Open Recent submenu for `build_menu`; `refresh_recent_menu`
/// fills it once the store is managed.
pub fn build_recent_submenu(app: &tauri::App, builder: &mut MenuBuilder) -> tauri::Result<Submenu<Wry>> {
    let submenu = builder.submenu("title.open-recent", &[])?;
    app.manage(RecentMenu(submenu.clone()));
    Ok(submenu)
}

/// A menu item whose text the language decides.
enum Labelled {
    Item(MenuItem<Wry>),
    Predefined(PredefinedMenuItem<Wry>),
    Submenu(Submenu<Wry>),
}

impl Labelled {
    fn set_text(&self, text: &str) -> tauri::Result<()> {
        match self {
            Labelled::Item(item) => item.set_text(text),
            Labelled::Predefined(item) => item.set_text(text),
            Labelled::Submenu(item) => item.set_text(text),
        }
    }
}

/// Builds the menu's items with the labels of one language and remembers
/// each one under the key it was labelled from, so `set_language` can
/// retitle it later. `finish` hands the collection to `App::manage`.
pub struct MenuBuilder<'a> {
    app: &'a tauri::App,
    language: &'static str,
    labels: Labels,
    entries: Vec<(&'static str, Labelled)>,
}

impl<'a> MenuBuilder<'a> {
    pub fn new(app: &'a tauri::App, language: &str) -> Self {
        let language = menu_labels::normalize(language);
        Self { app, language, labels: menu_labels::labels(language), entries: Vec::new() }
    }

    /// The text `key` has in the language the menu is being built in, for
    /// an item this builder cannot create itself.
    pub fn text(&self, key: &'static str) -> &'static str {
        self.labels.get(key)
    }

    /// One of the app's own items. Its key is also its menu id — the id
    /// the `menu` event carries and `lib/shortcuts.ts` lists.
    pub fn item(&mut self, key: &'static str, accelerator: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
        let item = MenuItem::with_id(self.app, key, self.labels.get(key), true, accelerator)?;
        self.entries.push((key, Labelled::Item(item.clone())));
        Ok(item)
    }

    /// One of muda's items, built by the constructor passed in. They take
    /// their text the same way, and muda's own is English (see
    /// `services::menu_labels`), so they are labelled here like the rest.
    pub fn predefined(
        &mut self,
        key: &'static str,
        make: impl FnOnce(&'a tauri::App, Option<&str>) -> tauri::Result<PredefinedMenuItem<Wry>>,
    ) -> tauri::Result<PredefinedMenuItem<Wry>> {
        let item = make(self.app, Some(self.labels.get(key)))?;
        self.entries.push((key, Labelled::Predefined(item.clone())));
        Ok(item)
    }

    pub fn submenu(&mut self, key: &'static str, items: &[&dyn IsMenuItem<Wry>]) -> tauri::Result<Submenu<Wry>> {
        let submenu = Submenu::with_items(self.app, self.labels.get(key), true, items)?;
        self.entries.push((key, Labelled::Submenu(submenu.clone())));
        Ok(submenu)
    }

    /// Manage what was collected, so `set_language` can find it.
    pub fn finish(self) {
        self.app.manage(MenuLabelling {
            entries: self.entries,
            language: Mutex::new(self.language),
        });
    }
}

/// Every labelled item of the menu, and the language they are in.
pub struct MenuLabelling {
    entries: Vec<(&'static str, Labelled)>,
    /// Also read by `rebuild`, for Open Recent's Clear Menu.
    language: Mutex<&'static str>,
}

/// The language the menu starts in, before the webview can say which one
/// the app is actually set to. The system's, which is the same answer
/// `systemLanguage` in the webview gives for a first launch, so the two
/// agree unless the user chose otherwise — and then the menu is corrected
/// a moment later rather than starting wrong.
#[cfg(target_os = "macos")]
pub fn system_language() -> &'static str {
    use objc2_foundation::NSLocale;
    // The list macOS narrows to the localizations the bundle declares
    // (`CFBundleLocalizations` in `Info.plist`), most preferred first.
    NSLocale::preferredLanguages()
        .firstObject()
        .map(|tag| menu_labels::normalize(&tag.to_string()))
        .unwrap_or("en")
}

#[cfg(not(target_os = "macos"))]
pub fn system_language() -> &'static str {
    "en"
}

/// Put the menu in `language`, for the webview telling us what the UI is
/// set to (`set_menu_language`). A no-op when nothing changes, so the call
/// every launch makes costs nothing.
///
/// `set_text` hops to the main thread on its own and waits there, so this
/// must not be called from the main thread itself; a command's thread —
/// the only caller — is not.
pub fn set_language(app: &AppHandle, language: &str) {
    let language = menu_labels::normalize(language);
    let Some(state) = app.try_state::<MenuLabelling>() else { return };
    {
        let Ok(mut current) = state.language.lock() else { return };
        if *current == language {
            return;
        }
        *current = language;
    }
    let labels = menu_labels::labels(language);
    for (key, item) in &state.entries {
        if let Err(e) = item.set_text(labels.get(key)) {
            eprintln!("could not put the menu's {key} into {language}: {e}");
        }
    }
    // Open Recent's items are file names, but Clear Menu is a label.
    refresh_recent_menu(app);
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
    // system's own Open Recent menus have it. Rebuilt from scratch every
    // time, so its label is read from the menu's current language rather
    // than tracked like the rest.
    let language = handle
        .try_state::<MenuLabelling>()
        .and_then(|state| state.language.lock().ok().map(|l| *l))
        .unwrap_or("en");
    let clear = menu_labels::labels(language).get(CLEAR_RECENT_ID);
    submenu.append(&MenuItem::with_id(handle, CLEAR_RECENT_ID, clear, !items.is_empty(), None::<&str>)?)?;
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    /// The `NSLocale` call itself, which the pure tests in
    /// `services::menu_labels` cannot reach. It runs off the main thread
    /// here, as it does in `build_menu`'s process before the event loop
    /// starts; what it answers depends on the machine, so only that it
    /// answers one of the app's languages is checked.
    #[test]
    fn the_system_language_is_one_of_the_app_s() {
        assert!(matches!(super::system_language(), "en" | "ja"));
    }
}
