# Parqsee

A fast and simple Parquet file viewer built with Tauri v2, React, and TypeScript.

## Project Overview

Parqsee is a desktop application for viewing and exploring Apache Parquet files.
It features:

- Drag-and-drop file loading and a built-in file explorer over folders the
  user opens (⌘⇧O), remembered across launches
- Fast Rust backend (Arrow / Parquet / DataFusion) for file processing
- Tabbed browsing with pagination, filtering and in-page search
- SQL query view (DataFusion) over the open file
- CSV / JSON export
- Recent files history and the open tabs, persisted with security-scoped
  bookmarks so the sandboxed App Store build can reopen them at the next
  launch (tabs come back in order, with their view mode, page and filter)
- Dark/light mode and English/Japanese localization

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
│   │   ├── commands/             # Tauri command handlers (file, data, query, workspace)
│   │   ├── services/             # parquet (cache, reads, SQL), export, access (sandbox bookmarks)
│   │   ├── models/               # Serde types shared with the frontend
│   │   ├── lib.rs                # Builder, plugins, command registration
│   │   └── main.rs               # Entry point
│   ├── Cargo.toml
│   ├── Entitlements.plist        # App Sandbox entitlements (applied to signed release builds)
│   └── tauri.conf.json           # Tauri config (window, bundle, build hooks)
├── docs/
│   ├── ASSETS.md
│   └── MANUAL_QA.md              # Shell-dependent checks to run on the release app
└── scripts/
    ├── apply_squircle.py         # Icon post-processing
    └── qa/
        ├── gen_fixtures.py       # Fixture generators for docs/MANUAL_QA.md and e2e (uv run)
        ├── gen_huge.py
        └── e2e/                  # Playwright WebKit suite against the real backend (see README)
```

### Feature modules

Each folder under `frontend/src/features/` owns its own `components/`,
`routes/` and (where it talks to Rust) `api/`, and re-exports through
`index.ts`:

- `welcome` — landing screen: drop zone, recent files, feature highlights; `api/` for recent files
- `workspace` — main layout: sidebar, header, tab hosting; `api/` for workspace roots
- `file-explorer` — tree over the workspace roots, search, breadcrumb (bounded by the root), context menu
- `file-viewer` — data table (column-virtualized), pagination, search bar, filter bar, export modal
- `query` — SQL editor and result grid
- `layout` — tab bar
- `settings` — settings modal

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
pnpm tauri build  # Production desktop app
```

Installers land in `backend/target/release/bundle/`.

### Testing
```bash
cd frontend && pnpm test        # Vitest, single run
cd frontend && pnpm test:watch  # Vitest, watch mode
cd backend  && cargo test --lib # Rust unit tests
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
| `remove_recent_file` / `clear_recent_files` | `(path)` / `()` → `void` | Edit the Recent Files list |
| `list_workspace_roots` | `()` → `WorkspaceRoot[]` | The folders open in the explorer, restored at launch |
| `add_workspace_root` | `(path)` → `WorkspaceRoot` | Open a folder (chosen in the folder dialog) as a root; bookmarked for the next launch |
| `remove_workspace_root` | `(path)` → `void` | Close a root and release its access grant |
| `list_session_tabs` | `()` → `SessionTabs` | The tabs of the last session in order, each with its saved state and `available` (bookmark resolves and the file exists), plus the active tab's path |
| `save_session` | `(tabs, active?)` → `void` | Replace the saved session with the open tabs (`{path, state}` each) and the active one's path; written by the webview on change |
| `read_parquet_data` | `(path, offset, limit, filter?)` → `Value[]` | One page of rows, optional SQL `WHERE` fragment |
| `count_parquet_data` | `(path, filter?)` → `number` | Row count under the active filter |
| `export_data` | `(sourcePath, exportPath, format, offset?, limit?, filter?)` → `number` | Export to `csv` or `json`, returning the row count. `offset`/`limit` address the filtered result. On success the destination folder is recorded as the last export folder |
| `export_default_dir` | `(sourcePath)` → `string \| null` | Where the save panel for an export should start: the file's own folder when it lies inside an open workspace root, else the last export folder, else `null` |
| `evict_cache` | `(path)` → `void` | Drop the cached session and metadata for a file |
| `execute_sql` | `(filePath, query)` → `QueryResult` | Run a read-only SQL query; the file is registered as table `t`. DDL, DML, `SET` and `COPY` are refused. Results are capped at 10,000 rows (`truncated`/`max_rows` on the result) |

The frontend also listens for a `file-drop` event emitted from
`lib.rs`'s window drag-drop handler, and for a `menu` event carrying the id
of the native menu item that was chosen (`open-file`, `open-folder`,
`close-tab`, `settings`) — `build_menu` in `lib.rs` owns ⌘O / ⌘⇧O / ⌘W / ⌘,
because a native key equivalent beats the webview's keydown handler.

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
   Unfiltered pages do not go through DataFusion at all: `read_data` reads them
   with `range_reader`, the parquet Arrow reader with offset/limit pushed down,
   which skips whole row groups by their row counts. A `LIMIT`/`OFFSET` query
   decodes every row before the page — the last page of a 58M-row file took
   2.5 s in release and a minute in debug. Both paths read row groups in file
   order, so adding a filter never reorders the grid
   (`unfiltered_pages_match_the_sql_path` pins this).
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
    overrides the identity). `pnpm tauri dev` and the e2e bridge are not
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
    the first read). Files dropped on the window or picked in a dialog are
    readable without any of this for the rest of the session; `remember_file`
    creates their bookmark at open time so Recent Files can reopen them
    later. The ObjC calls sit behind the `BookmarkProvider` trait
    (`access/macos.rs`); the store and the lifecycle are unit-tested with a
    fake on any OS.
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
12. The webview runs under the Content Security Policy in `tauri.conf.json`
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

## Testing

Vitest + Testing Library cover the file-explorer feature, the workspace
context (tabs, roots, recent files), `lib/path`, `lib/column-widths` and
`hooks/useVirtualRange`; `cargo test --lib` covers the extension matching in
`commands/file.rs`, file registration edge cases (uppercase extensions, glob
characters, 64-bit limits, duplicate columns), webview rendering of decimals /
big integers / NaN, the read-only SQL view, result truncation, export, and
the bookmark store, the session entries and the access-grant lifecycle in
`services/access` (with a fake provider; the real `NSURL` round trip has one
macOS-only test). `cargo test --lib export_bindings` regenerates the ts-rs
bindings in `frontend/src/bindings/ipc/` after a change to `models/`.
`scripts/qa/e2e/` is the end-to-end regression suite: Playwright WebKit
drives the Vite dev server against the real backend through
`backend/examples/bridge.rs` (a stdin/stdout JSON bridge calling the same
service functions the commands call, over an unsandboxed store under
`PARQSEE_DATA_DIR`). Run it after backend or frontend changes that touch
paging, filters, export, the explorer, workspace roots, recent files, the
session (S11: tabs back across a relaunch, a deleted file's tab skipped and
named) or the SQL view — see its README for setup (`cargo build --example bridge`,
`pnpm dev`, `pnpm suite`); rebuild the bridge after backend edits.
What only the macOS shell can show — native menu shortcuts, `alert()`,
Finder drag and drop, Reveal in Finder, the clipboard, large-file timing,
window/appearance, the sandbox (entitlements, bookmarks surviving a
relaunch), Gatekeeper — is listed in `docs/MANUAL_QA.md` with steps,
expected results and a results template; run it on the release `.app`
before tagging a release and after touching the menu, entitlements,
`services/access`, capabilities, plugins or the Tauri version. The fixtures it refers to
are generated by `uv run scripts/qa/gen_fixtures.py` and
`uv run scripts/qa/gen_huge.py` into the git-ignored `scripts/qa/fixtures/`.
