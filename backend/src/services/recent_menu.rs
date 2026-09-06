//! What File › Open Recent lists: the first entries of Recent Files as
//! menu items, and the ids that carry a pick back. Pure data, so the
//! Tauri glue in `crate::menu` stays thin and this part is tested.

use std::collections::HashMap;
use std::path::Path;

/// How many entries the menu shows. The store keeps more (`MAX_RECENT`);
/// a native menu past ten rows stops being quicker than the panel.
pub const MENU_RECENT_LIMIT: usize = 10;

/// A recent entry's menu item id is its path behind this prefix, so the
/// menu event handler can open it without a lookup — and so a pick cannot
/// collide with the app's other item ids.
pub const RECENT_ITEM_PREFIX: &str = "recent:";

/// Clear Menu, the last item of the submenu.
pub const CLEAR_RECENT_ID: &str = "recent-clear";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentMenuItem {
    pub id: String,
    pub label: String,
}

/// The items for `entries` (path and name, newest first), at most
/// `MENU_RECENT_LIMIT`. Two shown entries with the same file name carry
/// their parent folder — `data.parquet — 2024q1` — as the Finder's own
/// Open Recent does; the panel in the webview draws the same distinction.
pub fn recent_menu_items(entries: &[(String, String)]) -> Vec<RecentMenuItem> {
    let shown = &entries[..entries.len().min(MENU_RECENT_LIMIT)];
    let mut names_seen: HashMap<&str, usize> = HashMap::new();
    for (_, name) in shown {
        *names_seen.entry(name.as_str()).or_default() += 1;
    }
    shown
        .iter()
        .map(|(path, name)| {
            let shared = names_seen.get(name.as_str()).copied().unwrap_or(0) > 1;
            let label = if shared {
                format!("{name} — {}", parent_folder(path))
            } else {
                name.clone()
            };
            RecentMenuItem {
                id: format!("{RECENT_ITEM_PREFIX}{path}"),
                label,
            }
        })
        .collect()
}

/// The path a recent item's id stands for; `None` for any other id.
pub fn recent_path(id: &str) -> Option<&str> {
    id.strip_prefix(RECENT_ITEM_PREFIX)
}

/// `/a/b/c.parquet` → `b`; a file at the root of the filesystem → `/`.
fn parent_folder(path: &str) -> String {
    Path::new(path)
        .parent()
        .and_then(|dir| dir.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str) -> (String, String) {
        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        (path.to_string(), name)
    }

    #[test]
    fn items_carry_the_path_in_their_id_and_the_name_as_label() {
        let items = recent_menu_items(&[entry("/data/a.parquet"), entry("/data/b.parquet")]);
        assert_eq!(
            items,
            [
                RecentMenuItem {
                    id: "recent:/data/a.parquet".into(),
                    label: "a.parquet".into()
                },
                RecentMenuItem {
                    id: "recent:/data/b.parquet".into(),
                    label: "b.parquet".into()
                },
            ]
        );
        assert_eq!(recent_path(&items[0].id), Some("/data/a.parquet"));
        assert_eq!(recent_path(CLEAR_RECENT_ID), None);
        assert_eq!(recent_path("open-file"), None);
    }

    #[test]
    fn the_menu_stops_at_its_limit() {
        let entries: Vec<_> = (0..MENU_RECENT_LIMIT + 5)
            .map(|i| entry(&format!("/data/f{i}.parquet")))
            .collect();
        let items = recent_menu_items(&entries);
        assert_eq!(items.len(), MENU_RECENT_LIMIT);
        assert_eq!(items[0].label, "f0.parquet", "newest first, as given");
        assert!(recent_menu_items(&[]).is_empty());
    }

    #[test]
    fn entries_sharing_a_name_carry_their_folder_and_only_those() {
        let items = recent_menu_items(&[
            entry("/exports/2024q1/data.parquet"),
            entry("/exports/2024q2/data.parquet"),
            entry("/exports/2024q2/other.parquet"),
            entry("/data.parquet"),
            entry("/tmp/data.parquet"),
        ]);
        let labels: Vec<&str> = items.iter().map(|i| i.label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "data.parquet — 2024q1",
                "data.parquet — 2024q2",
                "other.parquet",
                "data.parquet — /",
                "data.parquet — tmp",
            ]
        );
    }

    #[test]
    fn a_name_shared_only_with_an_entry_past_the_limit_is_left_alone() {
        let mut entries: Vec<_> = (0..MENU_RECENT_LIMIT)
            .map(|i| entry(&format!("/d{i}/f{i}.parquet")))
            .collect();
        entries.push(entry("/elsewhere/f0.parquet"));
        let items = recent_menu_items(&entries);
        assert_eq!(items[0].label, "f0.parquet", "the twin is not in the menu");
    }
}
