# Parqsee

A fast and simple Parquet file viewer built with Tauri v2, React, and TypeScript.

## Project Overview

Parqsee is a desktop application for viewing and exploring Apache Parquet files.
It features:

- Drag-and-drop file loading and a built-in file explorer over folders the
  user opens (⇧⌘O), remembered across launches
- Fast Rust backend (Arrow / Parquet / DataFusion) for file processing
- Tabbed browsing with pagination, filtering, a sort by any column from
  its header (ascending, descending, back to file order) and in-page search
- A column profile beside the grid: counts and a chart of a column's
  values under the active filter, each bar a click away from becoming a
  filter condition
- SQL query view (DataFusion) over the open file
- CSV / JSON export
- Recent files history and the open tabs, persisted with security-scoped
  bookmarks so the sandboxed App Store build can reopen them at the next
  launch (tabs come back in order, with their view mode, page, filter and
  sort)
- Dark/light mode and English/Japanese localization, the native menu
  included; the app starts in the system's language
- A bundled sample file (`Contents/Resources/sample.parquet`), opened from
  the Welcome screen for anyone with no Parquet file at hand — App Store
  reviewers first of all
- Mac App Store build: free with a limited tier (3 tabs open at a time)
  and a one-time in-app purchase that removes the limit (StoreKit 2
  through a Swift bridge; `app-store` feature)

## Tech Stack

### Frontend
- **React 18.3** — UI framework
- **TypeScript** — type-safe JavaScript
- **Tailwind CSS v4** — utility-first CSS (configured via `@tailwindcss/postcss`)
- **Vite 6** — build tool and dev server
- **i18next / react-i18next** — localization
- **lucide-react** — icon set
- **Vitest + Testing Library** — unit and component tests

### Backend
- **Tauri v2** — desktop app framework
- **Rust** — systems programming language
- **Apache Arrow / Parquet 58** — reading Parquet files
- **DataFusion 54** — SQL execution and paginated reads (`default-features = false`; the
  SQL function families are opted in explicitly in `Cargo.toml`)

## Project Structure

The repository is split into two top-level workspaces: `frontend/` (the Vite
app) and `backend/` (the Tauri/Rust app). There is no root `package.json` —
all npm scripts live in `frontend/`.

```
parqsee/
├── frontend/                     # React frontend
│   ├── src/
│   │   ├── app/                  # App shell: provider tree and router
│   │   ├── components/           # Shared UI: Modal (the centred dialog shell every modal uses)
│   │   ├── contexts/             # SettingsContext, RecentFilesContext, WorkspaceContext
│   │   ├── features/             # Feature-based modules (see below)
│   │   ├── hooks/                # Shared hooks (useDebounce, useGlobalKeydown, useColumnVirtualizer)
│   │   ├── lib/                  # Shared helpers (path, format, tauri, i18n, settings-storage, column-widths)
│   │   ├── locales/              # en.json, ja.json
│   │   └── test/setup.ts         # Vitest setup and global mocks
│   ├── package.json
│   ├── vite.config.ts
│   └── vitest.config.ts
├── backend/                      # Tauri backend
│   ├── src/
│   │   ├── commands/             # Tauri command handlers (file, data, query, workspace, iap, menu)
│   │   ├── services/             # parquet (cache, reads, SQL), export, access (sandbox bookmarks), store (free tier / purchase), menu_labels (the menu's strings)
│   │   ├── models/               # Serde types shared with the frontend
│   │   ├── menu.rs               # Open Recent, and the menu's language
│   │   ├── lib.rs                # Builder, plugins, command registration
│   │   └── main.rs               # Entry point
│   ├── resources/                # Bundled into Resources/: sample.parquet (from scripts/gen_sample.py)
│   ├── storekit/                 # Swift package: the StoreKit 2 bridge (built by build.rs under `app-store`)
│   ├── build.rs                  # tauri-build, plus the Swift build and link under `app-store`
│   ├── Cargo.toml
│   ├── Entitlements.plist        # App Sandbox entitlements (applied to signed release builds)
│   ├── Info.plist                # Merged into the bundle's Info.plist: App Store Connect keys and CFBundleLocalizations
│   ├── tauri.conf.json           # Tauri config (window, bundle, build hooks)
│   └── tauri.appstore.conf.json  # Overlay for the store build: turns the `app-store` feature on
├── docs/
│   ├── ASSETS.md
│   └── MANUAL_QA.md              # Shell-dependent checks to run on the release app
├── scripts/
│   ├── apply_squircle.py         # Icon post-processing
│   ├── gen_sample.py             # Writes backend/resources/sample.parquet (uv run; the result is committed)
│   ├── release/
│   │   ├── appstore.sh           # Build → sign → .pkg → App Store Connect (universal; --unsigned is the dry run)
│   │   ├── sign_app.sh           # Embed a provisioning profile and sign with Entitlements.plist + the identifiers
│   │   ├── upload_pkg.sh         # Validate a signed .pkg with App Store Connect and upload it (appstore.sh's last step, callable alone)
│   │   └── test_appstore.py      # unittest over appstore.sh and upload_pkg.sh with stubbed tools (python3 scripts/release/test_appstore.py)
│   └── qa/
│       ├── gen_fixtures.py       # Fixture generators for docs/MANUAL_QA.md and e2e (uv run)
│       ├── gen_huge.py
│       ├── sign_for_storekit.sh  # MQ-12: sign_app.sh with a development profile
│       └── e2e/                  # Playwright WebKit suite against the real backend (see README)
└── site/                         # The product page, privacy policy and support page,
                                  # en + ja, published to GitHub Pages by
                                  # .github/workflows/pages.yml (see site/README.md)
```

### Feature modules

Each folder under `frontend/src/features/` owns its own `components/`,
`routes/` and (where it talks to Rust) `api/`, and re-exports through
`index.ts`:

- `welcome` — landing screen: drop zone, recent files (the first five, the
  rest behind Show all), feature highlights; `api/` for recent files. Also
  `RecentFilesPopover`, the same list as a panel under the top row's clock
  button (the Welcome list is out of reach once a tab is open): every
  entry, a search box over name and path (Enter opens the first match),
  and the parent folder after the name when two entries share a file
  name (`lib/recent-file-labels.ts`). `layout` imports the panel by file,
  not through the index, which would cycle back through the Welcome route
- `workspace` — main layout: sidebar, header, tab hosting; `api/` for workspace roots
- `file-explorer` — tree over the workspace roots, search, breadcrumb (bounded by the root), context menu
- `file-viewer` — data table (column-virtualized), pagination, search bar,
  the filter bar (on screen from the moment a file opens; a row starts with
  no column picked — a dimmed placeholder, not the file's first column, so
  an untouched bar states no condition and a value alone applies nothing —
  while the operator starts at `=`; a row whose column the file loses goes
  back to unpicked rather than to another column), export modal,
  the sort (a click on a sortable column's name in the header cycles
  ascending → descending → file order through `lib/sort.ts`'s `nextSort`;
  the header carries `aria-sort`; nested and unordered columns keep a
  plain name; the sort resets the page like a filter, rolls back with the
  rest of the request state when a sorted load fails, goes with the
  export, and is dropped when the file no longer has the column),
  and the column profile (`ColumnProfilePanel`, opened by the chart button on a
  column header): row / NULL / distinct counts under the active filter and a bar
  chart of the values, every one listed or binned past twenty; a click on a
  value, a bucket or the NULL row goes into the filter bar through its
  `FilterBarHandle.addConditions` and applies at once, replacing a condition on
  the same column with the same operator (also interchanging `<` / `<=` at
  day-end) so a narrower bucket does not stack on the wider one. The rows
  that arrive this way light up once (`.filter-arrived` in `index.css`) and
  the first takes focus, since the click's effect lands in the grid, the
  footer and the bar at once with nothing to say so; a value or the NULL
  row also closes the panel — one value leaves nothing to chart — while a
  bucket keeps it open for the drill-down. Restored
  form-generated filters become editable rows; unrecognized SQL remains a
  visible, parenthesized base predicate. Explicit empty values from a chart
  are distinct from unfilled form rows. Changing file, column or filter
  clears the old chart before another bar can be clicked. The panel is not
  part of the tab's saved state
- `query` — SQL editor and result grid, and the chart of the result
  (`components/query-chart.tsx`, Table / Chart in the results header):
  the first column is X, every numeric column after it a series in
  column order, so the SQL is the whole axis-and-aggregation UI. The kind
  is inferred from X's `chart_type` (labels → bar, time → line, numbers →
  scatter; pie is never inferred — nothing in a type says the values are
  shares of a whole, so the user picks it) among the kinds in
  `IMPLEMENTED_CHART_KINDS` — bar and pie so far; a line and scatter stage
  each add a renderer under `components/charts/` and its name there.
  `QueryChart` is the frame (the notes, the problem, the footer rule);
  each kind owns its plot, legend and selection, and
  `components/charts/chart-chrome.tsx` holds what they share.
  `lib/chart-data.ts` builds the model once per result: values parsed by
  chart type (integers only inside ±2^53, decimals only up to 15
  significant digits, floats only when finite — the rest counted by
  reason and named above the plot, never silently rounded), at most
  10,000 plotted points across all series (`MAX_CHART_POINTS`; past it the
  chart is refused and the SQL asked to narrow, never thinned).
  `lib/chart-scales.ts` and `lib/chart-geometry.ts` are pure; the axis is
  its own SVG so many groups scroll under it. One focusable "data point
  details" box walks the points with the arrow keys instead of a tab stop
  per mark, and the pointer, the legend and the keyboard all drive it.
  The mode and the picked kind live in `QueryView` for the tab's life and
  are not in the saved session (neither the SQL nor its result is): a
  re-run of the same SQL keeps the pick, a different SQL re-infers, and
  the same SQL whose new result cannot draw the pick re-infers and says
  so. Series colors are the `--chart-series-1..8` tokens in `index.css`,
  a palette validated for both surfaces.
  The pie (`lib/pie-data.ts`, `components/charts/pie-chart.tsx`) is the
  one kind that claims its values are parts of one whole, so anything
  that is not a whole refuses the kind outright instead of leaving
  values out the way the others do — which would draw the circle full
  with every percentage against a different denominator: a second
  numeric column, a repeated or absent category (told apart by the raw
  value, so `''` is not NULL), an invalid or negative value, nothing
  positive, more than 50 rows, a truncated result, a total no double can
  carry. Past eight slices the tail is summed into a grey Other
  (`--chart-other`, outside the categorical ramp) that keeps the rows it
  swallowed so the details can still name them; a zero has no area and
  is counted in a note instead; the total is a compensated sum, since
  plain addition over fifty doubles drifts by more than the smallest
  slice is wide. Slices run clockwise from 12 o'clock, biggest first,
  and carry their category, value and percentage in the legend rather
  than inside the circle
- `layout` — the top row's controls (`HeaderActions`: Open File / Open Folder / Recent Files / Settings, shared by the header and the tab bar) and the tab bar, with the right-click menu over a tab: copy path,
  reveal in Finder, close it, close the others, close the ones to its
  right, reopen the last closed tab. The bulk closes go through
  `closeTabs` in one dispatch; the reopen history (the last 10 closes of
  the session, with each tab's view state) lives in `WorkspaceContext`
  and is not persisted
- `settings` — the settings dialog (language, theme, restore tabs, purchase;
  every control applies at once); `api/` for `set_menu_language`. The grid's own display settings are not
  here: rows per page is in the pagination bar, row density and column
  types in `file-viewer`'s view options
- `license` — the upgrade prompt (`UpgradePrompt`), the Free ⓘ pill (`FreeBadge`: one button in the top row that opens the prompt, the limit in its tooltip), Settings › Purchase; `api/` for the `iap_*` commands; `lib/` holds `FREE_TAB_LIMIT`, the tab-limit derivation and the reducer

## Key Commands

All npm scripts run from `frontend/`. The repo uses **pnpm** (see
`frontend/pnpm-lock.yaml`); `tauri.conf.json` invokes `pnpm` in its build hooks.

### Development
```bash
cd frontend
pnpm dev          # Vite dev server (frontend only, port 1420)
pnpm tauri dev    # Full desktop app (delegates to `cd ../backend && tauri dev`)
```

### Building
```bash
cd frontend
pnpm build        # tsc && vite build
pnpm tauri build  # Production desktop app (no store: always unlocked)
pnpm tauri:store  # The Mac App Store variant: `app-store` feature, StoreKit bridge linked
```

Installers land in `backend/target/release/bundle/`.

`pnpm tauri:store` has to run with the `APPLE_*` variables out of the
environment. Tauri notarizes what it bundles as soon as it finds
`APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_KEY_PATH` (or
`APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`) there, and a store build
must not be notarized — `Warn skipping app notarization, no ...
environment variables found` in the build log is the line that says it
did not. `scripts/release/appstore.sh` unsets them itself, so this only
bites a manual `pnpm tauri:store` run in a shell where the upload
credentials were exported.

The submission itself is `scripts/release/appstore.sh`: the store variant
as a universal binary (`--target universal-apple-darwin`; needs
`rustup target add x86_64-apple-darwin` once), signed with the Mac App
Store profile and the Apple Distribution identity, wrapped into a `.pkg`
with `productbuild`, validated and uploaded on `--upload` through
`scripts/release/upload_pkg.sh` (`xcrun altool`; it refuses an unsigned
package first). `--unsigned` is the dry run without certificates. It
lands in `backend/target/universal-apple-darwin/release/bundle/macos/`;
see the script's header for the flags and the `APPLE_*` variables it
reads. `appstore.sh` re-signs and re-packages on every run, so a package
validated earlier is uploaded as the same bytes by calling
`upload_pkg.sh` on it directly.

### Testing
```bash
cd frontend && pnpm test        # Vitest, single run
cd frontend && pnpm test:watch  # Vitest, watch mode
cd backend  && cargo test --lib # Rust unit tests
cd backend/storekit && swift test  # The StoreKit bridge's Swift side
```

## Tauri Commands

Exposed from Rust to the frontend (registered in `backend/src/lib.rs`).
Argument names are camelCase on the JS side.

| Command | Signature | Purpose |
|---|---|---|
| `open_parquet_file` | `(path)` → `ParquetMetadata` | Open a file and return its schema/row count (cached) |
| `get_file_info` | `(path)` → `FileInfo` | Path, name and byte size |
| `check_file_exists` | `(path)` → `bool` | Existence check before opening; resolves the file's bookmark first under the sandbox |
| `list_directory` | `(path)` → `FileEntry[]` | Directory listing, directories first. Under the sandbox only readable inside an open workspace root |
| `remember_file` | `(path)` → `RecentFile` | Record a just-opened file in Recent Files and create its security-scoped bookmark |
| `list_recent_files` | `()` → `RecentFile[]` | Newest first; `available` is false when the file cannot be reached any more |
| `take_pending_files` | `()` → `string[]` | The files Finder / the Dock handed the app before the webview was listening; asked for once at launch, and empty afterwards |
| `sample_file_path` | `()` → `string` | Where the bundled sample file is (`resource_dir()/sample.parquet`); an error in a build without it. The webview opens it through `open_parquet_file` like any file, minus `remember_file` |
| `remove_recent_file` / `clear_recent_files` | `(path)` / `()` → `void` | Edit the Recent Files list |
| `list_workspace_roots` | `()` → `WorkspaceRoot[]` | The folders open in the explorer, restored at launch |
| `add_workspace_root` | `(path)` → `WorkspaceRoot` | Open a folder (chosen in the folder dialog) as a root; bookmarked for the next launch |
| `remove_workspace_root` | `(path)` → `void` | Close a root and release its access grant |
| `list_session_tabs` | `()` → `SessionTabs` | The tabs of the last session in order, each with its saved state and `available` (bookmark resolves and the file exists), plus the active tab's path |
| `save_session` | `(tabs, active?)` → `void` | Replace the saved session with the open tabs (`{path, state}` each) and the active one's path; written by the webview on change |
| `read_parquet_data` | `(path, offset, limit, filter?, sort?)` → `Value[]` | One page of rows, optional SQL `WHERE` fragment, optional `SortSpec` (`{column, direction: asc \| desc}`). A sorted page is an `ORDER BY` over the whole file per page (see `order_by_terms`) |
| `count_parquet_data` | `(path, filter?)` → `number` | Row count under the active filter |
| `profile_column` | `(path, column, filter?)` → `ColumnProfile` | The column's row / NULL / distinct counts under the filter and its chart: every value with its count when there are at most 20 distinct values, else equal-width buckets on round edges (whole days / seconds for temporal columns) for numbers and dates and the 20 commonest values for the rest, with what is not shown counted as `other`. Bucket counts use the same typed predicates as drill-down; day-end time buckets include their final representable instant. Unsafe double ranges and decimals with more than 15 digits of precision fall back to top values. Two or three scans of the file through the single-partition session (`services/profile.rs`) |
| `export_data` | `(sourcePath, exportPath, format, offset?, limit?, filter?, sort?)` → `number` | Export to `csv` or `json`, returning the row count. `offset`/`limit` address the filtered, sorted result — the sequence the grid paginates over. On success the destination folder is recorded as the last export folder |
| `export_default_dir` | `(sourcePath)` → `string \| null` | Where the save panel for an export should start: the file's own folder when it lies inside an open workspace root, else the last export folder, else `null` |
| `evict_cache` | `(path)` → `void` | Drop the cached session and metadata for a file |
| `execute_sql` | `(filePath, query)` → `QueryResult` | Run a read-only SQL query; the file is registered as table `t`. DDL, DML, `SET` and `COPY` are refused. Results are capped at 10,000 rows (`truncated`/`max_rows` on the result). Each column carries `chart_type` (`QueryChartType`: integer / float / decimal / date / timestamp with its timezone / category / unsupported), decided from the planned schema in `commands/query.rs` — the webview cannot tell a CAST's or an aggregate's type from the file's `ColumnInfo`, and `data_type` is a display string. Dictionary columns are unsupported until their JSON rendering is proven to match a plain column's |
| `iap_status` | `()` → `IapStatus` | `{state: free \| unlocked, store_error?, revision}`, derived from the App Store entitlements on every call; waits for the launch-time read (20 s at most, then the free tier at revision 0 with the reason, and the read arrives as `iap-status` when it lands) |
| `iap_products` | `()` → `IapProduct[]` | The full version (one product) with the storefront's name, description and `display_price`; empty in a build without a store |
| `iap_purchase` | `(productId)` → `IapPurchaseResult` | Buy the product `iap_products` returned; `outcome` is `purchased`, `cancelled` or `pending` and `status` is the state afterwards |
| `iap_restore` | `()` → `IapStatus` | Restore Purchases, then the state |
| `set_menu_language` | `(language)` → `void` | Put the native menu into the UI's language; a no-op when it is already in it, and on a platform without a menu |

The frontend also listens for a `file-drop` event emitted from
`lib.rs`'s window drag-drop handler — and from its `RunEvent::Opened`
handler, which is how a file opened from Finder, the Dock or `open -a`
arrives — for a `menu` event carrying the id
of the native menu item that was chosen (`open-file`, `open-folder`,
`close-tab`, `reopen-tab`, `settings`, `find`, `find-next`,
`find-previous`, `toggle-sidebar`, `switch-view`, `run-query`,
`previous-tab`, `next-tab`, `shortcuts`, `help`) — `build_menu` in
`lib.rs` owns their key equivalents, and
`frontend/src/lib/shortcuts.ts` lists the same ids with the same keys
(its test reads `lib.rs` and checks); `WorkspaceContext.runCommand`
answers a `menu` event and a keydown alike by that id, handing what a
view owns (`find*`, `run-query`, `switch-view`) to the active view over
`lib/app-commands.ts` — for `recent-files-cleared`, sent when
File › Open Recent › Clear Menu emptied the store (the `RecentFilesContext`
mirror follows; the submenu itself is `menu.rs`: rebuilt from the store
after every change to Recent Files, a pick arrives as `file-drop`, so
nothing of it reaches the `menu` event) —
because a native key equivalent beats the webview's keydown handler — and
for `iap-status`, the new `IapStatus` after every change to the purchase
state: the launch-time read (which may land after `iap_status` gave up
waiting for it), a purchase, a restore, and a transaction update from the
store (a purchase approved elsewhere, a refund). `LicenseProvider`
listens before it asks, and the reducer keeps whichever of the event and a
command's answer carries the higher `revision`, since the two can cross.

## Architecture Notes

1. Tauri v2 APIs differ from v1 — check the v2 docs before copying snippets.
2. All file I/O happens in Rust; the webview never touches the filesystem directly.
3. `ParquetCache` (Tauri managed state, `services/parquet.rs`) caches a DataFusion
   `SessionContext` and the parsed metadata per file path. Every query path goes
   through `execute_sql_limited`; closing the last tab for a file evicts it.
   The file is registered through `register_file_as_t` as a `file://` URL with
   its own extension and with statistics collection off — see its rustdoc
   before touching it: the plain `register_parquet` path mis-handled uppercase
   extensions and glob characters in names, and collected statistics overflow
   DataFusion's selectivity arithmetic on 64-bit columns at their limits
   (reproduced on both 40 and 54).
   Because the session is shared with the SQL view, `execute_sql_limited`
   plans first and refuses anything that would mutate it.
   Sessions run with `target_partitions = 1` — a deliberate trade-off: filtered
   paged reads and filtered exports use `LIMIT`/`OFFSET` with no `ORDER BY`, and
   only single-partition scans keep their row order deterministic (see the
   rustdoc on `get_or_create_session`). The SQL view runs single-threaded as a
   result; don't revert this for speed without splitting paging and querying
   into separate sessions.
   Unfiltered, unsorted pages do not go through DataFusion at all: `read_data` reads them
   with `range_reader`, the parquet Arrow reader with offset/limit pushed down,
   which skips whole row groups by their row counts. A `LIMIT`/`OFFSET` query
   decodes every row before the page — the last page of a 58M-row file took
   2.5 s in release and a minute in debug. Both paths read row groups in file
   order, so adding a filter never reorders the grid
   (`unfiltered_pages_match_the_sql_path` pins this).
   A sort is the one thing that does reorder it, and it is the expensive
   path by design: each uncached page is its own `ORDER BY ... LIMIT/OFFSET` query
   over the whole file. The file has no row id, so the query numbers the
   rows itself (`row_number() OVER ()`, in file order because the session
   scans a single partition) and the `ORDER BY` is the sort column and
   then that position in the same direction (`SortOrder`): ties come in
   file order, the order is total, and the sort is over two columns
   however wide the file is — the earlier key of "every other sortable
   column" cost 100 ms of planning per page on a 733-column file of 174
   rows. Without a unique tie-breaker the heap's order among equal keys
   differs from page to page and a sort on a category column showed rows
   twice and dropped others;
   `sorted_pages_join_up_without_repeating_or_losing_a_row` pins this.
   The page is read in two steps (`sorted_rows`): the position query
   returns the positions of the page's rows, and the parquet reader
   fetches those rows by index through a row selection
   (`rows_at_positions`), skipping the row groups none of them fall in.
   A filter sits above the numbering, never inside it, so it cannot be
   pushed into the scan on the sorted path; a filtered sort scans every
   row group of the key and the filter's columns.
   DataFusion answers the position query with a top-k heap of `offset + limit`
   rows, so the cost grows with the offset. Three things keep that in
   bounds. A page past the midpoint is read from the other end — the
   descending order is the exact reverse of the ascending one, so
   `sorted_page_batches` takes the mirrored window of the reversed order and turns
   it around (`mirrored_window`); the last page costs what the first
   does and the middle page is the worst. A page at least 16,384 rows
   and a quarter of the (filtered) file deep skips the top-k for an
   ordinary sort of the same query (`prefer_full_page_sort`,
   `full_sort_page_plan`: the top-k is swapped out after physical
   optimization, or DataFusion would put it back), which sorts batches
   and merges them instead of maintaining a heap the size of most of
   the file — on 1M rows the middle page went from 464 ms to 58 ms. And
   every file's session runs under a memory pool of
   `SESSION_MEMORY_LIMIT` (2 GiB): operators that can spill (the SQL
   view's aggregates and full sorts) go to disk past it, a top-k cannot
   and fails — which `sorted_rows` answers by running the ordinary sort
   instead, since the depth at which a top-k exhausts the pool depends
   on the key's width, not on a fraction of the file; only when that
   sort fails too (its merge batches need memory as well) does the grid
   report a page too deep to sort with the ways out (a filter, the other
   end, the SQL view); `a_sort_past_the_memory_limit_fails_cleanly` and
   `a_top_k_past_the_memory_limit_falls_back_to_the_full_sort` pin both.
   The session reserves half the pool for the full sort's merge
   (`sort_spill_reservation_bytes`, set in `get_or_create_session`):
   DataFusion's sorter otherwise fills the pool with buffered batches
   and then cannot allocate the row-format keys its in-memory merge
   needs before the first spill — the middle page of the 58M-row file
   failed that way at 44M buffered rows. With the reservation it spills
   about 1.3 GB in three files and answers in 6–9 s, the first page in
   about a second, a category key or the file's own order alike;
   `scripts/qa/PERFORMANCE.md` has the benchmark.
   Counts and sorted pages share a bounded LRU in `ParquetCache`: at most
   64 results and 32 MiB across all files, keyed by path, session identity,
   file size/modification time and SQL. Hits stat the file; changed versions
   invalidate older results. The count/page sequence checks its version at
   both ends and refuses results if the file changed during the read. Even
   unfiltered sorts obtain their count from the versioned query path rather
   than cached UI metadata. Schema/UI metadata still refresh explicitly.
   The frontend count and the sort's mirrored-window count reuse
   the same result. Refresh/close evicts entries; a query from an evicted
   session cannot insert them again. Stable/volatile functions (including
   those in subqueries) bypass caching. Results over 8192 rows or the byte
   budget are not cached. Page arrays are compacted before caching so a
   100-row slice does not retain the whole top-k allocation; string/binary
   views also compact their backing blocks. SQL-view queries are not cached.
   Sorted exports with a limit of at most 8192 rows (current pages and small
   custom ranges) use the same Arrow page reader, including mirroring and
   existing cached results. They do not insert new count/page results, so
   custom ranges do not displace grid entries, and memory errors have export
   guidance. Native types survive until the export writer converts them.
   Unsorted exports, larger sorted ranges and full exports still stream.
   If the first read of a deep page still hurts, the next step is a
   cached permutation per (file, filter, column, direction) paged through
   the parquet reader's row selection, not a smaller key. A full sorted
   export runs the query without a limit and spills to disk past the pool.
4. In the SQL view and in filters, the open file is always registered as table `t`.
5. Settings and recent files are persisted in `localStorage`. `lib/settings-storage.ts`
   owns the storage key and schema and must not import from `contexts/` — `lib/i18n.ts`
   reads the saved language at import time, and routing that through `SettingsContext`
   would create an import cycle.
6. Theme styling is mid-migration: `index.css` defines CSS-variable utilities
   (`bg-primary`, `text-secondary`, `border-primary`, …) used by the newer components,
   while older components still branch on `effectiveTheme === 'dark'` inline.
   Prefer the CSS variables in new code.
7. Both grids (`file-viewer/components/data-table.tsx` and
   `query/components/query-results.tsx`) only render the columns — and in the query
   grid, the rows — that overlap the scroll viewport via `hooks/useVirtualRange`,
   with column widths computed up front by `lib/column-widths.ts`
   (`table-layout: fixed`). Wide files (hundreds of columns) would otherwise put
   tens of thousands of cells per tab in the DOM, and WebKit's style recalc over
   them made tab switches take close to a second. Keep new grid features
   compatible with this (no DOM lookups of off-screen cells).
8. Exports stream RecordBatches straight into arrow's CSV/JSON writers —
   constant memory; don't buffer whole files. Without a filter they come from
   `range_reader` (the parquet Arrow reader with offset/limit pushed down, the
   same path unfiltered pages take); with one they are streamed out of
   DataFusion so the exported range matches what the grid shows.
   The rows go to a staging file in `std::env::temp_dir()` and are moved
   into place at the end (`move_into_place`: a rename, or a copy when the
   rename is refused — another volume, or the sandbox), so a failed export
   never destroys an existing file. The staging file must
   not sit next to the destination: under the sandbox the save panel grants
   exactly the chosen file, and creating `<name>.partial` beside it fails
   with EPERM unless the folder is inside a workspace root (#21). The temp
   directory is the container's `Data/tmp` there — `libsecinit` rewrites
   `TMPDIR` in-process — and is always writable. The same grant is why the
   copy fallback cannot be atomic (nowhere beside the file to stage a
   replacement, and the file is truncated before the first byte lands):
   it backs the previous contents up to the temp directory first and puts
   them back when the copy fails partway (a full volume, an I/O error),
   touches nothing when that backup cannot be made, and only when the
   restore fails too keeps backup and export in the temp directory and
   names both in the error. The filesystem calls sit behind `FinalizeFs`
   so the tests can refuse the rename and fail a copy halfway; a real
   cross-volume fill-up was reproduced on a 2 MiB RAM disk (`hdiutil
   attach -nomount ram://4096`, `diskutil erasevolume HFS+ …`), which the
   sandboxed release `.app` has not been checked against.
9. Arrow's JSON writers reject decimals and write NaN/±Infinity as `null`, and
   the webview parses the IPC payload with JS number semantics.
   `batches_to_rows` (`services/parquet.rs`) is the one choke point that renders
   decimals, non-finite floats and integers outside ±2^53 as strings — route
   every row the webview consumes through it.
10. Commands wrap their bodies in `commands::guarded`, which turns a panic into
    an error; a panic that escapes a Tauri command never resolves the promise
    and leaves the grid on its spinner.
11. The release build runs under the App Sandbox (`backend/Entitlements.plist`,
    applied because `tauri.conf.json` signs ad-hoc; `APPLE_SIGNING_IDENTITY`
    overrides the identity). The store submission is not signed by Tauri
    at all: this Tauri version has no config key for a provisioning
    profile and does not add the application / team identifiers to the
    entitlements, and an identity plus an API key in the environment would
    make it notarize, which a store build must not be. So
    `scripts/release/appstore.sh` builds with every `APPLE_*` variable
    unset and `scripts/release/sign_app.sh` embeds the profile and signs
    with `Entitlements.plist` plus the two identifiers read from the
    profile — the same routine `scripts/qa/sign_for_storekit.sh` runs with
    a development profile for MQ-12. `pnpm tauri dev` and the e2e bridge are not
    sandboxed, so sandbox behaviour is only visible on the release `.app`.
    The entitlements include `com.apple.security.network.client` even though
    the app never talks to the network: WKWebView's GPU/Networking helpers
    fail to start under the sandbox without it and the window stays blank
    (the plist comment records the evidence). A blank release window is the
    first thing to suspect after touching the entitlements.
    `services/access` (`FileAccess`, Tauri managed state) owns what makes
    files readable there: `bookmarks.json` in the app data directory records
    workspace roots and recent files with their security-scoped bookmarks
    (keyed by path, nothing tied to the bundle identifier), and a grant is
    held per path — for a root from open until removed, for a file exactly as
    long as its `ParquetCache` entry (`acquire` on fill, `release` on evict;
    DataFusion reopens the file on every query, so the grant cannot end with
    the first read; a fill that fails gives the grant back itself through
    `release_unless_used`, unless the other half's entry or a fill in
    flight still holds it — the file gets no tab, so nothing would evict
    it, and each failed open of a different file would otherwise keep one
    more grant until the process ends). Files dropped on the window or picked in a dialog are
    readable without any of this for the rest of the session; `remember_file`
    creates their bookmark at open time so Recent Files can reopen them
    later. The ObjC calls sit behind the `BookmarkProvider` trait
    (`access/macos.rs`); the store and the lifecycle are unit-tested with a
    fake on any OS.
    The bundled sample (`services/sample`, `resources/sample.parquet`
    bundled through `bundle.resources`) needs none of this: the app's own
    bundle is readable under the sandbox, and `FileAccess` falls back to the
    plain path for a file it has no bookmark for. The webview opens it
    through the ordinary path — a tab like any other, counted against the
    free tier's limit, kept in the session — but never calls `remember_file`
    for it: the Welcome screen links to it, and Recent Files is for the
    user's own files (`MAX_RECENT`, 20, in `services/access/store.rs`; the
    Welcome screen shows the first five and folds the rest, the top row's
    panel shows them all with a search box, File › Open Recent the first
    ten — `services/recent_menu.rs` decides those, `menu.rs` draws them).
    Clear all / Clear Menu ask no confirmation, on every surface alike:
    the files are untouched, only the way back to them goes.
    `bookmarks.json` also records the last export folder (`last_export`),
    which only decides where the next save panel starts — the panel grants
    the write. Its bookmark is best effort: the save panel grants the chosen
    file, not its folder, so under the sandbox creating one usually fails
    and the bare path is kept, which works because the sandbox allows
    `stat` on paths it cannot read. It is resolved for the path only and no
    grant outlives the call.
    The open tabs are recorded there too (`session`: path, bookmark, view
    mode / page / filter per tab, and the active tab's path; `version`
    stays 1, a store without `session` restores nothing). Each tab carries
    its own bookmark because Recent Files is capped and can be cleared,
    but `save_session` never creates a second one for a file: it copies
    the recent entry's bytes or the tab's previous entry, and only creates
    one for a file recorded nowhere. Restoring adds no lifecycle:
    `WorkspaceContext` lists the session at launch (after the roots), skips
    tabs that are not `available` — the bookmark must resolve; `exists`
    alone is meaningless under the sandbox — reopens the rest through
    `open_parquet_file` (so `acquire` on fill / `release` on evict apply as
    for a manual open; `bookmark_for` falls back to the session entry), and
    never calls `remember_file`, so Recent Files keeps its order. Skipped
    files are named in a one-line notice; the next save drops them. The
    webview saves 250 ms after a change to what the session keeps (not on
    search, selection or scroll), flushes on `pagehide`, and writes nothing
    before the restore has finished so the empty first render cannot erase
    the store. The `restoreTabs` setting (localStorage, default on) only
    gates the restore.
12. The free tier and the purchase (`services/store`, issue #22, which
    replaced the 14-day trial of #15 before anything existed in App Store
    Connect; decisions in #5). The store build is free and always usable:
    the free tier keeps at most `FREE_TAB_LIMIT` (3) tabs open at once
    and everything else — paging, filters, search, the SQL view, export —
    works; a non-consumable in-app purchase (`parqsee.full`) removes the
    limit for good, and a refund puts it back. `License` (Tauri managed
    state, `Arc<License>`) keeps a snapshot of the entitlements — read at
    launch, after purchase / restore, and on every `Transaction.updates`
    event, each snapshot numbered (`IapStatus.revision`) and handed to
    `on_change` — and derives `IapStatus` (`free | unlocked`, plus
    `store_error`) from it; there is no clock. **The backend enforces
    nothing**: it has no notion of a tab, so the limit lives in the
    webview (`FREE_TAB_LIMIT` in `features/license/lib/license.ts`,
    checked by `WorkspaceContext` before a file is opened — counting the
    opens still in flight, and holding the file's slot until its open
    lands or fails, so two files handed over at once into the last slot
    do not both get opened in the backend and one of them refused a tab
    with its cache and grant left behind — and when the
    session is restored — the first tabs up to the limit come back, the
    rest are named in the restore notice and kept in memory with their
    state until the limit lifts (a purchase, Restore Purchases, or the
    launch-time read landing after `iap_status` gave up waiting), when
    they are opened like the rest were; a quit before that drops them
    from the session at the next save — with the `open` / `restore`
    transitions in `workspace-tabs.ts` as the backstop), and the row
    commands never refuse. A client-side limit is bypassable by patching
    the bundle; that is the trade a one-time-purchase utility makes — do
    not "fix" it by inventing a tab count in Rust. A store that cannot be
    read leaves the app on the free tier with the reason, never locked.
    The product id is a constant in `services/store/mod.rs` and nowhere
    else — it does not depend on the bundle identifier, and the webview
    buys by the id `iap_products` returned; name, description and price
    come from App Store Connect, never from code. The App Store sits
    behind the `StoreProvider` trait: `storekit::SwiftStore` (compiled
    with the `app-store` Cargo feature, macOS only) calls the C functions
    of the Swift package in `backend/storekit/`, which `build.rs` builds
    with `swift build` and links statically (see its comments for the
    Swift runtime and the deployment target: the app requires macOS 12
    for StoreKit 2, and `MACOSX_DEPLOYMENT_TARGET` is pinned in
    `.cargo/config.toml` because linking for older makes ld pick an
    `@rpath` copy of the concurrency runtime that is not in the bundle);
    `AlwaysUnlocked` serves every other build — the default
    `pnpm tauri build`, `pnpm tauri dev`, `cargo test --lib`, the e2e
    bridge, Windows / Linux — so nothing outside the store build ever
    shows the limit or the upgrade prompt; `IapStatus.has_store` is false
    there, and Settings › Purchase renders nothing. The state is unit-tested with
    a fake provider; the real store is checked by hand
    (`docs/MANUAL_QA.md`, MQ-12, which also says how to sign the store
    build so StoreKit uses the sandbox). To *see* the free tier's screens
    while working on them — no build outside the signed store one shows
    them, and that one shows no price until the product exists in App
    Store Connect — the e2e harness scripts the store in the page
    (`launch({ iap })` in `scripts/qa/e2e/lib.mjs`): S14 in the suite,
    `pnpm shots:license` photographs every state in en/ja × light/dark,
    and `pnpm free-tier` opens it in a window to click around (all three
    under `scripts/qa/e2e/`, with `pnpm dev` running).
13. The webview runs under the Content Security Policy in `tauri.conf.json`
    (`app.security.csp`): `default-src 'self'` plus
    `connect-src ipc: http://ipc.localhost`. Tauri does not add the IPC
    origins itself; without them the `fetch` to `ipc://localhost` is blocked
    and every `invoke` silently falls back to the slower `postMessage`
    path. `'self'` covers the Vite bundle, the stylesheet and `/logo.png`;
    Tauri's own init scripts are user scripts and exempt. There is no
    `'unsafe-inline'`: React writes the `style` prop through the CSSOM,
    which the CSP does not police, so the virtualized grids' inline styles
    are fine — what would break the release build is an inline `<style>`
    or `<script>` element, `setAttribute('style', …)`, a `data:` image or
    a web font. The policy is only applied to the built assets (the dev
    server sends none), so check with `scripts/qa/e2e/csp-server.mjs`
    (see its README) and then on the release `.app` (MQ-11).
14. Opening a `.parquet` from Finder (#2). `bundle.fileAssociations` in
    `tauri.conf.json` becomes `CFBundleDocumentTypes`; macOS then delivers
    the file as `tauri::RunEvent::Opened`, which is why `run()` builds the
    app and drives the event loop itself. `deliver_opened` converts the
    `file://` URLs with `Url::to_file_path` (never by trimming the string:
    spaces, `%`, `#` and non-ASCII names arrive percent-encoded) and hands
    them to the webview as the same `file-drop` event a drag and drop uses,
    so a Finder open is an ordinary open — `remember_file` included, and
    `services::access` stays the only owner of what is readable under the
    sandbox. On a cold start the event arrives before the webview has its
    listener, so `services::opened::PendingOpen` buffers the paths until
    `take_pending_files`; one mutex covers buffering and draining, so a file
    arriving in between is neither lost nor opened twice. Two orderings are
    load-bearing: `PendingOpen` is managed on the built app rather than in
    `setup`, because `Opened` is delivered before `Ready` and a panic in
    that Objective-C callback aborts the process instead of surfacing; and
    the webview only asks after its listener is registered and the session
    restore has finished, or the restored tabs take the active tab back from
    the file the user just double-clicked.
15. Never call `window.confirm` (or `window.alert` for a decision). The
    dialog plugin's init script replaces `window.confirm` with an `async`
    function over the native OK / Cancel panel, so it returns a Promise —
    truthy whichever button is pressed — and `if (confirm(...))` runs the
    action on Cancel. Ask through `lib/dialog.ts` (`confirmDestructive`),
    which awaits the plugin under Tauri and the synchronous original in a
    plain browser (vitest, the e2e harness, which answers
    `plugin:dialog|confirm` from `window.__dialog.confirm`).
16. The menu bar is localized in Rust, not in `locales/`
    (`services/menu_labels.rs`, en + ja by key). It has to be: the menu is
    built in `setup`, long before the webview could say which language the
    UI is in, and a menu that starts in English and flips a moment later
    is what that would look like. So it starts in the system's language
    (`menu::system_language`, `NSLocale.preferredLanguages`) — the same
    answer `systemLanguage` in `lib/settings-storage.ts` gives for a first
    launch, so the two agree unless the user chose otherwise — and
    `set_menu_language` corrects it from `SettingsContext` when they did.
    `MenuBuilder` labels each item as `build_menu` creates it and keeps
    the handle; `menu::set_language` retitles them in place rather than
    rebuilding the menu, which would mean re-managing `RecentMenu`. An
    item's label key is its menu id, which is what lets
    `lib/__tests__/shortcuts.test.ts` keep reading `build_menu` — it also
    checks every key has a label, since a key with none would be drawn as
    itself rather than fail. Predefined items are labelled like the rest:
    muda fills them from a hardcoded English table (`Paste`,
    `Quit {app}`) that macOS never localizes, and every constructor takes
    the text. What no setting reaches, because AppKit supplies it in the
    *system's* language: the Services submenu, the Help menu's search
    field, Emoji & Symbols, the About panel, and the dialog plugin's open
    and save panels. `CFBundleLocalizations` in `Info.plist` is what tells
    macOS the app has Japanese at all — without it those parts stay
    English on a Japanese Mac and `navigator.language` reads `en`.

## Comments explain; external references only cite

A comment must make its point without the reader opening anything else.
What a comment is tempted to point at decays faster than the code it
annotates: a GitHub issue is closed and its context collapses to a title;
an audit id (`CT-04`) or a manual-QA item (`MQ-12`) is renumbered; a
numbered note in this file shifts when one is added above it; a local
`spec-*.md` is gitignored and never existed for anyone but its author. An
explanation that lives at the far end of such a link goes silent when the
link does, and it goes silent invisibly — the comment still reads fine.

What matters is the job the reference is doing:

- **Citation — allowed, and worth having.** The comment explains the
  mechanism in full, and the reference is appended as the source for the
  one claim the code cannot re-derive: that this was decided, reproduced
  or asked for. It comes after the explanation, never at its head — a
  leading id makes the tracker the subject of the sentence. The shape to
  copy is `FREE_TAB_LIMIT`'s TSDoc in `features/license/lib/license.ts`:
  the rationale, then `(#22)`.
- **Forward pointer — allowed.** "The upload becomes its own stage once
  CI (#6) exists" names where the remaining work lives. Nothing is being
  explained, so nothing is lost if the issue disappears — the pointer *is*
  the content.
- **Delegation — never.** "See #22 for why", "see spec-fix-CT-01.md",
  "CLAUDE.md note 12". Move the reasoning into the comment. If it is too
  long to sit inline, it belongs in the rustdoc / TSDoc of the declaration
  it constrains — still in this repository, still versioned with the code
  it describes.

Pointers into this repository — `see range_reader`, `docs/MANUAL_QA.md`,
the e2e README — are fine: they are versioned with the code. Point at a
name that survives renumbering (a function, a file, a heading), never at
a note number or a line number.

The same test applies to names. A test or a constant named after an
audit item or a ticket means nothing to a reader without the tracker
open; name it for the behaviour and append the id if it is worth citing.

### Specs are scaffolding, not artifacts

A `spec-*.md` at the repository root (gitignored) is a thinking aid for
one fix, not a record of it. Before the branch that finishes the fix is
merged: move what cannot be re-derived from the code — external platform
behaviour, options deliberately not taken — into rustdoc / TSDoc beside
the code it constrains; move anything still unimplemented into a GitHub
issue that stands on its own; leave no comment or document pointing at
the spec. Then delete it. Build steps, deliverable lists, acceptance
checklists and "where the parts live" tables go with it: the code, its
tests and git history are the source of truth, and a table of file paths
rots silently.

## Testing

Vitest + Testing Library cover the file-explorer feature, the Welcome
screen's sample link, the Free ⓘ pill, the restore notice, the upgrade
prompt's states, Recent Files' Clear all and its fold past five, the
Recent Files panel (search, same-name folders) and its button in the top
row, the viewer's view
options, the header's sort (the button on sortable columns only, `aria-sort`;
`nextSort`'s cycle; the viewer's page reset, rollback of a failed sorted
load, a restored sort kept or dropped by the file's columns), the column profile panel (values, buckets and NULL as
conditions, the partial-list note, a late answer discarded), the SQL chart
(`features/query`: value parsing at the safe-integer and 15-digit
boundaries, inference and availability per X type, the point cap over all
series, exclusion counts by reason, bar geometry; the pie's conditions
and its slices (the row counts at 1 / 8 / 9 / 50 / 51, a repeated,
empty or NULL category, negative and invalid values, zeros, one
positive value, a truncated result, a total past the safe range, the
top seven and the Other they feed, a row whose own category reads
Other) and its wedges from the running total; the chart's keyboard
walk, legend, tooltip and problem states; `QueryView`'s table-first mode,
the pick kept across a re-run and dropped on a new SQL, the notice when the
same SQL loses the pick, a superseded run's answer ignored), its button
on the header and the filter bar's `addConditions`, the tab bar's right-click menu, the workspace
context (tabs, roots, recent files, the sample file, the free tier's tab limit at open
and at restore, reopening closed tabs), the license context and its pure parts (tab-limit
derivation, reducer: free → unlocked and back on a refund, restore,
cancelled / failed / pending purchases, the upgrade prompt),
`lib/path`, `lib/column-widths`, `lib/settings-storage`'s
system-language guess and
`hooks/useVirtualRange`; `cargo test --lib` covers the extension matching in
`commands/file.rs`, the sort's `ORDER BY` (the key, the tie-breakers, quoting,
a refused column) and its pages joining up over runs of ties with a filter
and in both directions, a sorted export's order, file registration edge cases (uppercase extensions, glob
characters, 64-bit limits, duplicate columns), webview rendering of decimals /
big integers / NaN (Decimal32/64 included), the read-only SQL view, result
truncation, the chart type of every Arrow type and of a query's planned
columns (`commands::query`), export,
the column profile in `services::profile` (the full list and the commonest
values, integer / float / date / timestamp bins and their edge labels as
filter literals, NaN and the infinities kept out of the bins, nested
columns, quoted names, explicit empty values, Float16 including non-finite
values, Time32/Time64 through day-end, Date64 and timezone timestamps
including a DST transition, and exact drill-down round trips at 20/21 distinct
values; large integers, high-precision decimals and extreme finite floats
exercise the top-values fallback),
the bookmark store, a listing's probe running off the FileAccess lock, the
Open Recent menu's items in `services::recent_menu`, the
URL-to-path conversion and the launch handover in
`services::opened`, the sample's lookup and the committed file's shape in
`services::sample`, the session entries and the access-grant lifecycle in
`services/access` (with a fake provider; the real `NSURL` round trip has one
macOS-only test), the menu's label tables in `services::menu_labels` (both
languages carry every key, nothing is left untranslated, and a language tag
is read down to its primary subtag), and the free / unlocked state in
`services/store` (with a fake store; `cargo test --lib --features app-store` adds three round trips
through the Swift bridge). Those round trips prove the ABI and nothing more —
a test binary has no provisioning profile, so the store never answers and every
one of them takes the error path; what the bridge *encodes* on the way back is
covered on the Swift side by `swift test --package-path backend/storekit`
(`encodeJSON`: the shapes the entry points answer with, and the refusal of a
top-level value `JSONSerialization` would raise on rather than throw — `null`
there took the app down on Restore Purchases). `cargo test --lib export_bindings` regenerates the ts-rs
bindings in `frontend/src/bindings/ipc/` after a change to `models/`.
`python3 scripts/release/test_appstore.py` runs `scripts/release/appstore.sh`
and `scripts/release/upload_pkg.sh` against a fake checkout with stubs of
pnpm / codesign / productbuild / pkgutil / altool on PATH (argument
handling, artifact paths, the build's scrubbed environment, the signed and
unsigned sequences, the upload script's refusal of an unsigned package)
plus one run through the real `productbuild`.
`scripts/qa/e2e/shots.mjs` (`pnpm shots`) is not a test: it drives the same
harness to photograph the app for `site/` and the App Store listing (#16), in
en/ja × light/dark at the sizes App Store Connect accepts. Regenerate the
site's screenshots from it after a visible UI change (`site/README.md` has the
one-liner).
`scripts/qa/e2e/` is the end-to-end regression suite: Playwright WebKit
drives the Vite dev server against the real backend through
`backend/examples/bridge.rs` (a stdin/stdout JSON bridge calling the same
service functions the commands call, over an unsandboxed store under
`PARQSEE_DATA_DIR`). Run it after backend or frontend changes that touch
paging, filters, export, the explorer, workspace roots, recent files (S7,
the top row's panel included; S7b, a launch listing overtaken by an open), the
session (S11: tabs back across a relaunch, a deleted file's tab skipped and
named), opening from Finder (S12: cold start through `PARQSEE_PENDING_FILES`,
warm start through the `file-drop` event), the bundled sample (S13: opened
from the Welcome screen, not in Recent Files, back after a relaunch), the
free tier (S14, over the harness's scripted store: two files dropped
into the last slot, the prompt at the fourth tab, cancelled and
completed purchases, a refund, the capped restore and Restore
Purchases), the column profile (S19: values and NULL as conditions, the
bins of a hundred thousand ids and a drill-down into one, non-finite
floats including a NaN click, empty strings, restored filters and stale bars), the sort (S21: a category column's ties in id order across two pages, the reverse, another column, under a filter, back to file order, the sorted export of the current page, the sort back after a relaunch), the SQL chart (S20: table first, the bar chart with its computed fills in light and dark, negative bars, exclusion counts from the real backend's big integers and NaN, the problem states, an error leaving no stale chart, 300 groups scrolling, the keyboard walk and the tooltip, the mode kept per tab, in en and ja; S20-pie: the kind picked by hand
because it is never inferred, eight slices and the ninth folded into
Other with its breakdown and its own colour, forty-three rows behind
one slice, a zero counted and a single value as a circle, and every
condition that refuses the kind named on its button; run both under
`csp-server` too) or the SQL view — see its README for setup (`cargo build --example bridge`,
`pnpm dev`, `pnpm suite`); rebuild the bridge after backend edits.
What only the macOS shell can show — native menu shortcuts, `alert()`,
Finder drag and drop, Reveal in Finder, the clipboard, large-file timing,
window/appearance, the sandbox (entitlements, bookmarks surviving a
relaunch), Gatekeeper — is listed in `docs/MANUAL_QA.md` with steps,
expected results and a results template; run it on the release `.app`
before tagging a release and after touching the menu (Open Recent and its
labels included: they are rebuilt on the main thread and only the real app
has a menu bar), entitlements,
`services/access`, the file association or the `RunEvent::Opened` handler,
capabilities, plugins or the Tauri version. The fixtures it refers to
are generated by `uv run scripts/qa/gen_fixtures.py` and
`uv run scripts/qa/gen_huge.py` into the git-ignored `scripts/qa/fixtures/`.
