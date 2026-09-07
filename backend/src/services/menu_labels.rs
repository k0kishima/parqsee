//! The native menu's strings, in the languages the app ships.
//!
//! The menu bar is the one surface the webview cannot draw, so its labels
//! are the one part of the UI that is not in `frontend/src/locales`. That
//! is not duplication: nothing outside the menu says "Open Recent" or
//! "Hide Parqsee", and keeping them here is what lets the menu be right in
//! the first frame — it is built in `setup`, long before the webview has
//! loaded, let alone told us which language it is in (`set_menu_language`).
//! The initial guess is the system's language; the webview corrects it if
//! its owner chose another one.
//!
//! The English column reproduces what the menu said before it could be
//! translated, muda's own defaults included, so an English menu is
//! unchanged. Predefined items are not exempt: muda fills them in from a
//! hardcoded English table (`Quit {app}`, `Services`, `Paste`) which macOS
//! never localizes, so they are listed here like the rest and passed as
//! the `text` argument every constructor takes.
//!
//! The Japanese column follows the wording of Apple's own menus ("しまう",
//! "ペースト", "メニューを消去"), which is what a Mac user reads everywhere
//! else in the menu bar.

/// The key of every label the menu draws.
///
/// A key is the menu item's own id where it has one (`open-file`, `find`,
/// …), so `MenuBuilder::item` takes one string for both. The rest are the
/// predefined items, whose ids are muda's, and the submenu titles under
/// `title.`, which have no id at all.
pub const KEYS: &[&str] = &[
    // Submenu titles. The app menu's own title is not among them: macOS
    // replaces it with the bundle name whatever it is set to.
    "title.file",
    "title.edit",
    "title.view",
    "title.query",
    "title.window",
    "title.help",
    "title.open-recent",
    // Parqsee
    "about",
    "settings",
    "services",
    "hide",
    "hide-others",
    "show-all",
    "quit",
    // File
    "open-file",
    "open-folder",
    "recent-clear",
    "close-tab",
    "reopen-tab",
    // Edit
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "select-all",
    "find",
    "find-next",
    "find-previous",
    // View
    "toggle-sidebar",
    "switch-view",
    "fullscreen",
    // Query
    "run-query",
    // Window
    "minimize",
    "zoom",
    "previous-tab",
    "next-tab",
    // Help
    "shortcuts",
    "help",
];

const EN: &[(&str, &str)] = &[
    ("title.file", "File"),
    ("title.edit", "Edit"),
    ("title.view", "View"),
    ("title.query", "Query"),
    ("title.window", "Window"),
    ("title.help", "Help"),
    ("title.open-recent", "Open Recent"),
    ("about", "About Parqsee"),
    ("settings", "Settings…"),
    ("services", "Services"),
    ("hide", "Hide Parqsee"),
    ("hide-others", "Hide Others"),
    ("show-all", "Show All"),
    ("quit", "Quit Parqsee"),
    ("open-file", "Open…"),
    ("open-folder", "Open Folder…"),
    ("recent-clear", "Clear Menu"),
    ("close-tab", "Close Tab"),
    ("reopen-tab", "Reopen Closed Tab"),
    ("undo", "Undo"),
    ("redo", "Redo"),
    ("cut", "Cut"),
    ("copy", "Copy"),
    ("paste", "Paste"),
    ("select-all", "Select All"),
    ("find", "Find…"),
    ("find-next", "Find Next"),
    ("find-previous", "Find Previous"),
    ("toggle-sidebar", "Toggle Sidebar"),
    ("switch-view", "Switch Content / Query"),
    ("fullscreen", "Toggle Full Screen"),
    ("run-query", "Run Query"),
    ("minimize", "Minimize"),
    ("zoom", "Zoom"),
    ("previous-tab", "Show Previous Tab"),
    ("next-tab", "Show Next Tab"),
    ("shortcuts", "Keyboard Shortcuts"),
    ("help", "Parqsee Help"),
];

const JA: &[(&str, &str)] = &[
    ("title.file", "ファイル"),
    ("title.edit", "編集"),
    ("title.view", "表示"),
    ("title.query", "クエリ"),
    ("title.window", "ウインドウ"),
    ("title.help", "ヘルプ"),
    ("title.open-recent", "最近使った項目を開く"),
    ("about", "Parqsee について"),
    ("settings", "設定…"),
    ("services", "サービス"),
    ("hide", "Parqsee を隠す"),
    ("hide-others", "ほかを隠す"),
    ("show-all", "すべてを表示"),
    ("quit", "Parqsee を終了"),
    ("open-file", "開く…"),
    ("open-folder", "フォルダを開く…"),
    ("recent-clear", "メニューを消去"),
    ("close-tab", "タブを閉じる"),
    ("reopen-tab", "閉じたタブを開く"),
    ("undo", "取り消す"),
    ("redo", "やり直す"),
    ("cut", "カット"),
    ("copy", "コピー"),
    ("paste", "ペースト"),
    ("select-all", "すべてを選択"),
    ("find", "検索…"),
    ("find-next", "次を検索"),
    ("find-previous", "前を検索"),
    ("toggle-sidebar", "サイドバーの表示 / 非表示"),
    ("switch-view", "コンテンツ / クエリを切り替え"),
    ("fullscreen", "フルスクリーンにする"),
    ("run-query", "クエリを実行"),
    ("minimize", "しまう"),
    ("zoom", "拡大 / 縮小"),
    ("previous-tab", "前のタブを表示"),
    ("next-tab", "次のタブを表示"),
    ("shortcuts", "キーボードショートカット"),
    ("help", "Parqsee ヘルプ"),
];

/// The language tag as one of the app's, for anything a caller hands us:
/// the webview's setting, the system's `ja-JP`, an empty string. Only the
/// primary subtag decides, and everything the app does not have is
/// English — the same rule as `systemLanguage` in the webview.
pub fn normalize(language: &str) -> &'static str {
    let primary = language.split(['-', '_']).next().unwrap_or_default();
    if primary.eq_ignore_ascii_case("ja") {
        "ja"
    } else {
        "en"
    }
}

/// The menu's strings in one language.
#[derive(Clone, Copy)]
pub struct Labels(&'static [(&'static str, &'static str)]);

impl Labels {
    /// The text for `key`. English answers for a key its own column is
    /// missing, and the key itself for one no column has — a menu with a
    /// key in it is wrong, but a menu that fails to build is worse.
    pub fn get(&self, key: &str) -> &'static str {
        find(self.0, key)
            .or_else(|| find(EN, key))
            .unwrap_or_else(|| leaked(key))
    }
}

fn find(table: &'static [(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, text)| *text)
}

/// Only reached by a key no column has, which the tests rule out.
fn leaked(key: &str) -> &'static str {
    Box::leak(key.to_string().into_boxed_str())
}

/// The labels for a language, taking anything `normalize` accepts.
pub fn labels(language: &str) -> Labels {
    match normalize(language) {
        "ja" => Labels(JA),
        _ => Labels(EN),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_language_has_every_key_exactly_once_and_nothing_else() {
        for (name, table) in [("en", EN), ("ja", JA)] {
            let keys: Vec<&str> = table.iter().map(|(k, _)| *k).collect();
            assert_eq!(
                keys.iter().copied().collect::<HashSet<_>>().len(),
                keys.len(),
                "{name} repeats a key"
            );
            assert_eq!(
                keys.iter().copied().collect::<HashSet<_>>(),
                KEYS.iter().copied().collect::<HashSet<_>>(),
                "{name} does not cover exactly KEYS"
            );
            for (key, text) in table {
                assert!(!text.is_empty(), "{name} has no text for {key}");
            }
        }
    }

    #[test]
    fn the_two_languages_say_different_things() {
        // A key left untranslated is the failure this catches; the app
        // name is the one thing both columns are allowed to share.
        for key in KEYS {
            let (en, ja) = (labels("en").get(key), labels("ja").get(key));
            assert_ne!(en, ja, "{key} is the same in both languages");
        }
    }

    #[test]
    fn normalize_reads_the_primary_subtag_only() {
        for tag in ["ja", "ja-JP", "JA_jp", "ja-Jpan-JP"] {
            assert_eq!(normalize(tag), "ja", "{tag}");
        }
        for tag in ["en", "en-US", "de", "jav", "", "-"] {
            assert_eq!(normalize(tag), "en", "{tag}");
        }
    }

    #[test]
    fn an_unknown_key_answers_with_itself_rather_than_failing() {
        assert_eq!(labels("ja").get("no-such-key"), "no-such-key");
    }
}
