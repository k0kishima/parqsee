# Performance fixtures and benchmarks

These scripts preserve the repeatable parts of the column-sort investigation.
They are manual diagnostic tools rather than CI benchmarks: timings vary with
the machine, build, OS file cache and other load.

## Sort datasets

Generate all default shapes:

```sh
uv run scripts/qa/gen_sort_perf.py
```

The output defaults to `scripts/qa/fixtures/sort-perf/`, which is ignored by
Git. The generator writes one row group at a time and records the exact shape
in `manifest.json`.

| Profile | Default shape | Purpose |
| --- | --- | --- |
| `standard` | 1M rows, 7 columns, 100k-row groups | Baseline with distributed keys, repeated groups and NULLs |
| `reversed` | Same 1M logical rows as `standard`, physically reversed | Detect sensitivity to input order |
| `wide` | 200k rows, 23 columns, long strings | Exercise row width and comparison/copy costs |

The profiles, row count, row-group size, seed, number of wide columns and
payload width are command-line options. Run
`uv run scripts/qa/gen_sort_perf.py --help` for the complete interface.
Generated Parquet files are deliberately
not committed.

`gen_huge.py` remains separate. It targets file size and large-file UI/manual
QA (about 58M rows and 2.5 GiB by default); `gen_sort_perf.py` controls data
shape for repeatable sort comparisons.

## Backend sort benchmark

Build the real bridge in release mode, then measure it:

```sh
cd backend && cargo build --locked --release --example bridge && cd ..
uv run scripts/qa/sort_benchmark.py
```

The benchmark reads the same service functions as the app through the bridge.
For the first, 1%, quarter, middle, just-past-middle and last windows it:

1. evicts the app cache and opens metadata;
2. times a sorted page cache miss;
3. immediately times the same page's cache hit;
4. checks that rows stay identical across the miss, hit and repetitions;
5. discards the configured warmup samples and reports the median.

Results are written as JSON to a timestamped file under the system temporary
directory unless `--output` is supplied. The report includes all samples,
conditions, Git revision, dataset metadata and platform. The OS file cache is
not cleared, and Tauri IPC and UI rendering are outside the timing scope.

Examples:

```sh
# A different generated shape and sort key
uv run scripts/qa/sort_benchmark.py \
  scripts/qa/fixtures/sort-perf/wide.parquet --column payload_00

# A filtered sort; COUNT setup is reported separately
uv run scripts/qa/sort_benchmark.py --filter 'key % 2 = 0'

# Compare builds by running the same dataset with each bridge
uv run scripts/qa/sort_benchmark.py --bridge /path/to/other/release/bridge \
  --output /tmp/other-build.json
```

Compare results from the same machine, dataset manifest and command. Do not
turn a single machine's millisecond values into CI thresholds. Correctness
remains covered by Rust, frontend and end-to-end tests.
