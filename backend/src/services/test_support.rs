//! Helpers shared by the service test modules.

use arrow::record_batch::RecordBatch;
use parquet::arrow::ArrowWriter;
use parquet::file::properties::WriterProperties;
use std::fs::File;
use std::path::{Path, PathBuf};

/// A path under a temp directory of this process's own, one per `scope`. The
/// whole suite runs in a single process and two test modules write fixtures
/// under the same file names, so the scope keeps them apart.
///
/// The directory is canonicalised: on macOS the temp directory is reached
/// through `/var`, a symlink to `/private/var`, and a security-scoped
/// bookmark resolves to the real path — so a test that compares a path it
/// wrote with one a bookmark handed back would be comparing the two spellings
/// rather than the two files. A test that is about that difference makes its
/// own symlink.
pub fn temp_path(scope: &str, name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("parqsee-{}-test-{}", scope, std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap_or(dir).join(name)
}

/// A directory of this process's own under `temp_path`'s scope, created and
/// empty of anything but what the test puts in it.
pub fn temp_dir(scope: &str, name: &str) -> PathBuf {
    let dir = temp_path(scope, name);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Write one batch out as the parquet fixture a test reads back. The writer
/// takes the batch's own schema; `props` is the one thing that ever varied
/// (a row group count small enough to make paging cross a boundary).
pub fn write_parquet(path: &Path, batch: &RecordBatch, props: Option<WriterProperties>) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut writer =
        ArrowWriter::try_new(File::create(path).unwrap(), batch.schema(), props).unwrap();
    writer.write(batch).unwrap();
    writer.close().unwrap();
}

/// Overwrite the fixture at `path` with `batch`, the way another program
/// replacing the file under an open tab would. The modification time is set
/// two seconds past the old one: a rewrite that lands inside the
/// filesystem's timestamp granularity is indistinguishable from the
/// original, and half of what makes a file a different version is that
/// timestamp.
pub fn rewrite_parquet(path: &Path, batch: &RecordBatch) {
    let before = std::fs::metadata(path).unwrap().modified().unwrap();
    write_parquet(path, batch, None);
    File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new()
                .set_modified(before + std::time::Duration::from_secs(2)),
        )
        .unwrap();
}
