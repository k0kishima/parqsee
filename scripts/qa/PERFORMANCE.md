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

## Column profile benchmark

The panel beside the grid is two or three scans of the column it charts, and
what they cost cannot be read off the code: it depends on the column's
cardinality, on the filter above it and on whether `COUNT(DISTINCT)` fits the
session's memory pool. `profile_benchmark.py` drives `profile_column` through
the same release bridge the sort benchmark uses:

```sh
cd backend && cargo build --locked --release --example bridge && cd ..
uv run scripts/qa/profile_benchmark.py \
  --filter none \
  --filter 'broad="category" = '\''alpha'\''' \
  --filter 'selective="id" < 100000' \
  --repetitions 3 --warmups 1 --busy-column id
```

It runs four sections — the profile of each column under each filter, a page
read issued while a profile runs, every column profiled in quick succession,
and a profile whose tab is closed under it — and writes every sample, the
medians, the process's peak RSS and CPU, the dataset's metadata and the Git
revision to JSON. Each case gets a bridge process of its own, because an
allocator hands back very little of a finished query's memory and the next case
would report the previous one's high-water mark as its own.

```sh
# The read that competes with a profile for the memory pool
uv run scripts/qa/profile_benchmark.py --skip columns --skip pileup \
  --busy-column id --sort-column category

# Clicking along four columns, nothing cancelled
uv run scripts/qa/profile_benchmark.py --skip columns --skip concurrency \
  --skip abandonment --columns category,id,token,ts --gap-ms 150
```

The same operations from the UI are in `scripts/qa/e2e/large-file.mjs`: the
time from the click on a column's chart button to bars (or to the message a
refused profile leaves), a page move made while a profile is still running, and
clicking along the header. Point it at the built frontend rather than the dev
server — React's development build mounts an effect twice under `StrictMode`,
so every panel asks the backend twice there:

```sh
cd frontend && pnpm build
cd scripts/qa/e2e && pnpm csp-server            # serves frontend/dist on 1421
DEV_URL=http://localhost:1421/ BRIDGE_BIN=../../../backend/target/release/examples/bridge \
  node large-file.mjs
```

### What 58M rows cost (2026-09-21)

Apple M4, 10 cores, 32 GB, macOS 26.6.2; `huge.parquet` (58,000,000 rows,
2.5 GiB, `gen_huge.py`); release bridge at `ea1bb86`; three repetitions, the
first discarded; the OS file cache was warm for every column (it was not
cleared — `sudo purge` is what a genuinely cold pass needs).

| Column | Type | Distinct | Chart | Unfiltered | `category = 'alpha'` (9.7M rows) | `id < 100000` | Peak RSS unfiltered |
|---|---|---|---|---|---|---|---|
| `category` | text | 5 | top values | 0.90 s | 0.83 s | 0.015 s | 42 MB |
| `flag` | boolean | 2 | top values | 1.69 s | 1.38 s | 0.020 s | 41 MB |
| `id` | int64 | 58,000,000 | histogram | 2.29 s | 2.09 s | 0.018 s | 1,200 MB |
| `token` | text | 58,000,000 | top values | **refused after 2.4 s** | 4.58 s | 0.064 s | 4,311 MB |
| `x` | float64 | 58,000,000 | histogram | 2.20 s | 1.67 s | 0.024 s | 1,204 MB |
| `ts` | timestamp(ms) | 57,983,113 | histogram | 3.16 s | 2.40 s | 0.037 s | 1,203 MB |

A profile is never cached: the same panel reopened on a warm session costs what
the first one did (2,261 ms against 2,286 ms for `id`), because
`execute_sql_with_cache` shares the file's session but not the result cache.
From the UI, the click-to-bars times on the built frontend were 0.98 s
(`category`), 2.42 s (`id`) and 3.26 s (`ts`) — the backend's numbers plus the
render.

`COUNT(DISTINCT)` is the whole memory story. It cannot spill, so a column with
tens of millions of distinct values exhausts the session's 2 GiB pool and the
panel is left with DataFusion's own words:

```
Failed to collect results: Resources exhausted: Additional allocation failed
for AggregateStream[0] ... AggregateStream[0]#0(can spill: false) consumed
1873.9 MB ... pool_size: 2.0 GB
```

RSS reached 4.3 GB before that error, so the pool tracks less than the process
actually holds.

### What a profile does to everything else

A running profile does not disturb the grid. A page read issued while a 1.2 GB
profile of `id` was running:

| Read | Alone | During a profile |
|---|---|---|
| Unfiltered page (parquet reader) | 3 ms | 4 ms |
| Filtered page (same session) | 7 ms | 9 ms |
| Deep sorted page, offset 29M (`category`) | 5,603 ms | 5,686 ms |

In the UI a page move during a profile of `ts` took ~102 ms. Even a profile
large enough to exhaust the pool left a filtered page read at 13 ms against
8 ms: the grid's reads are bounded by `LIMIT`, so they need almost nothing from
the pool.

What an abandoned profile does hurt is the next profile. Nothing cancels one:
closing the tab (`evict_cache`) let the query run 2.0 s and 2.0 s of CPU past
the close and then answer. Clicking along `category → id → token → ts` at 150 ms
intervals on the built frontend ended, in three runs out of three, with the
panel the user is looking at — `ts`, which profiles fine in 3.3 s on its own —
showing the resources-exhausted error after 1.8 s, because `token`'s abandoned
scan still held the pool. The backend-only pile-up of all six columns settled
in 4.6 s at 4.2 GB RSS and 13.7 s of CPU, with `token` the one refused; which
of two overlapping profiles is refused depends on who asks for the big
allocation last.

### What was decided

These three answers are what the measurement above was run to settle (#30).

* **Cancel a superseded profile: yes.** Not because it slows the grid — it does
  not — but because an abandoned one holds the memory pool and makes the
  profile the user is waiting for fail, reproducibly, and because it spends
  seconds of CPU on an answer the webview has already dropped. Dropping the
  DataFusion stream releases its reservation, so cancellation is what returns
  the pool to the request that is still wanted.
* **Show the parquet footer's statistics first: no.** The wait is 0.9–3.5 s
  behind a spinner, not the tens of seconds that would justify a second kind of
  number on screen. The footer carries min/max and null counts for the whole
  file only: no distinct count, and nothing under the grid's filter, which is
  what the panel is always about.
* **`COUNT(DISTINCT)` needs its own answer.** It is the one part that fails
  rather than waits, and it fails with a DataFusion sentence about
  `AggregateStream` reservations. That is a defect of its own, not a tuning
  question.

Cancellation landed as `services::profile_requests` and the `cancel_profile`
command: the panel names each request and cancels the ones it supersedes, and
cancelling is dropping the work, which drops the DataFusion stream and releases
its reservation. Clicking along the same four columns afterwards ended three
runs out of three with the `ts` panel's bars after about 3.8 s — what that
profile costs on its own — instead of the error it showed before.
