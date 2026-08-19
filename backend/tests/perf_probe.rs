//! Temporary performance probe (not committed).
use parqsee_lib::services::export::export_data;
use std::time::Instant;
const DIR: &str = "/private/tmp/claude-501/-Users-k0kishima-work-fuji-parqsee/f84eb2b5-354b-405c-b348-8e159f6e8597/scratchpad";

#[test]
#[ignore]
fn export_probe() {
    for (label, path, off, limit, fmt) in [
        ("wide 1000 rows csv", format!("{DIR}/wide.parquet"), 0usize, 1000usize, "csv"),
        ("wide 20000 rows csv", format!("{DIR}/wide.parquet"), 0, 20000, "csv"),
        ("big 100k rows csv", format!("{DIR}/big_rows.parquet"), 0, 100_000, "csv"),
        ("big 1000 rows @4.9M csv", format!("{DIR}/big_rows.parquet"), 4_900_000, 1000, "csv"),
        ("big ALL 5M rows csv", format!("{DIR}/big_rows.parquet"), 0, 5_000_000, "csv"),
        ("big ALL 5M rows json", format!("{DIR}/big_rows.parquet"), 0, 5_000_000, "json"),
    ] {
        let out = format!("{DIR}/export_probe_{}_{off}.{fmt}", limit);
        let t = Instant::now();
        let n = export_data(path, out, fmt.to_string(), Some(off), Some(limit)).unwrap();
        println!("export [{label}]: {}ms ({n} rows)", t.elapsed().as_millis());
    }
}
