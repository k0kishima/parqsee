//! The sample file the app ships for people who have no Parquet file at
//! hand — App Store reviewers first of all (#16).
//!
//! `resources/sample.parquet` (written by `scripts/gen_sample.py` and
//! committed) is bundled as `Contents/Resources/sample.parquet` through
//! `bundle.resources` in `tauri.conf.json`; `tauri-build` copies it next to
//! the binary for `pnpm tauri dev`, so `app.path().resource_dir()` finds it
//! in both. Under the App Sandbox the app's own bundle is readable without a
//! security-scoped bookmark, so the sample is opened through the ordinary
//! `open_parquet_file` path: `FileAccess` finds no bookmark for it and
//! falls back to the plain path.
//!
//! The webview opens it like any other file — a tab, counted against the
//! free tier's limit, kept in the session — but never records it in Recent
//! Files: the Welcome screen already links to it, and the bundle path is
//! not one of the user's files.

use std::path::{Path, PathBuf};

/// The sample's name inside the resource directory (and the tab's title).
pub const SAMPLE_FILE_NAME: &str = "sample.parquet";

/// Where the sample lies under `resource_dir`; an error when this build
/// does not carry it (a bundle built without `bundle.resources`, or a dev
/// binary whose resources were not copied).
pub fn sample_path(resource_dir: &Path) -> Result<PathBuf, String> {
    let path = resource_dir.join(SAMPLE_FILE_NAME);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "This build has no sample file ({} is missing)",
            path.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{sample_path, SAMPLE_FILE_NAME};
    use crate::models::ColumnKind;
    use crate::services::parquet::ParquetCache;
    use crate::services::test_support::temp_path;
    use std::path::Path;

    /// The committed sample, as `pnpm tauri build` bundles it.
    fn committed_sample() -> &'static Path {
        Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/sample.parquet"))
    }

    #[test]
    fn resolves_the_sample_inside_the_resource_dir() {
        let dir = temp_path("sample", "with-sample");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(committed_sample(), dir.join(SAMPLE_FILE_NAME)).unwrap();

        assert_eq!(sample_path(&dir).unwrap(), dir.join("sample.parquet"));
    }

    #[test]
    fn a_build_without_the_sample_says_so() {
        let dir = temp_path("sample", "without-sample");
        std::fs::create_dir_all(&dir).unwrap();

        let err = sample_path(&dir).unwrap_err();
        assert!(err.starts_with("This build has no sample file"), "{err}");
        assert!(err.contains("sample.parquet"), "{err}");
    }

    /// Pins the shape `scripts/gen_sample.py` produces, so a regenerated or
    /// damaged file is caught here and not by a reviewer.
    #[tokio::test]
    async fn the_committed_sample_has_the_shape_the_welcome_screen_promises() {
        let path = committed_sample().to_string_lossy().into_owned();
        let cache = ParquetCache::new();
        let meta = cache.get_or_create_metadata(&path).await.unwrap();

        assert_eq!(meta.num_rows, 1500);
        let names: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "order_id", "order_date", "customer", "country", "category", "product", "quantity",
                "unit_price", "discount_rate", "total", "status", "is_gift", "shipped_at", "notes",
            ]
        );
        let kinds: Vec<ColumnKind> = meta.columns.iter().map(|c| c.kind).collect();
        for kind in [
            ColumnKind::Integer,
            ColumnKind::Temporal,
            ColumnKind::Text,
            ColumnKind::Decimal,
            ColumnKind::Float,
            ColumnKind::Boolean,
        ] {
            assert!(kinds.contains(&kind), "no {kind:?} column in the sample");
        }

        // Nulls in three columns, and the rows read back through the same
        // path the grid uses.
        let ctx = cache.get_or_create_session(&path).await.unwrap();
        let df = ctx
            .sql("SELECT count(*) FILTER (WHERE discount_rate IS NULL) AS d, \
                         count(*) FILTER (WHERE shipped_at IS NULL) AS s, \
                         count(*) FILTER (WHERE notes IS NULL) AS n FROM t")
            .await
            .unwrap();
        let batches = df.collect().await.unwrap();
        let row = batches[0]
            .columns()
            .iter()
            .map(|c| {
                c.as_any()
                    .downcast_ref::<arrow::array::Int64Array>()
                    .unwrap()
                    .value(0)
            })
            .collect::<Vec<_>>();
        assert!(row.iter().all(|&n| n > 0 && n < 1500), "null counts: {row:?}");
    }
}
