# Parqsee

A fast and simple Parquet file viewer built with Tauri v2, React, and TypeScript.

## Project Overview

Parqsee is a desktop application for viewing and exploring Apache Parquet files.
It features:

- Drag-and-drop file loading and a built-in file explorer
- Fast Rust backend (Arrow / Parquet / DataFusion) for file processing
- Tabbed browsing with pagination, filtering and in-page search
- SQL query view (DataFusion) over the open file
- CSV / JSON export
- Recent files history
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
- **Apache Arrow / Parquet 52** — reading Parquet files
- **DataFusion 40** — SQL execution and paginated reads

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
│   │   ├── commands/             # Tauri command handlers (file, data, query)
│   │   ├── services/             # parquet (cache, reads, SQL), export
│   │   ├── models/               # Serde types shared with the frontend
│   │   ├── utils/                # Parquet Field -> JSON / string conversion
│   │   ├── lib.rs                # Builder, plugins, command registration
│   │   └── main.rs               # Entry point
│   ├── Cargo.toml
│   └── tauri.conf.json           # Tauri config (window, bundle, build hooks)
├── docs/ASSETS.md
└── scripts/apply_squircle.py     # Icon post-processing
```

### Feature modules

Each folder under `frontend/src/features/` owns its own `components/`,
`routes/` and (where it talks to Rust) `api/`, and re-exports through
`index.ts`:

- `welcome` — landing screen: drop zone, recent files, feature highlights
- `workspace` — main layout: sidebar, header, tab hosting
- `file-explorer` — directory tree, search, breadcrumb, context menu
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
| `check_file_exists` | `(path)` → `bool` | Existence check before opening |
| `list_directory` | `(path)` → `FileEntry[]` | Directory listing, directories first |
| `read_parquet_data` | `(path, offset, limit, filter?)` → `Value[]` | One page of rows, optional SQL `WHERE` fragment |
| `count_parquet_data` | `(path, filter?)` → `number` | Row count under the active filter |
| `export_data` | `(sourcePath, exportPath, format, offset?, limit?)` → `string` | Export to `csv` or `json` |
| `evict_cache` | `(path)` → `void` | Drop the cached session and metadata for a file |
| `execute_sql` | `(filePath, query)` → `QueryResult` | Run arbitrary SQL; the file is registered as table `t` |

The frontend also listens for a `file-drop` event emitted from
`lib.rs`'s window drag-drop handler.

## Architecture Notes

1. Tauri v2 APIs differ from v1 — check the v2 docs before copying snippets.
2. All file I/O happens in Rust; the webview never touches the filesystem directly.
3. `ParquetCache` (Tauri managed state, `services/parquet.rs`) caches a DataFusion
   `SessionContext` and the parsed metadata per file path. Every query path goes
   through `execute_sql_with_cache`; closing the last tab for a file evicts it.
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
   `query/components/query-results.tsx`) only render the columns that overlap the
   scroll viewport via `hooks/useColumnVirtualizer`, with column widths computed up
   front by `lib/column-widths.ts` (`table-layout: fixed`). Wide files (hundreds of
   columns) would otherwise put tens of thousands of cells per tab in the DOM, and
   WebKit's style recalc over them made tab switches take close to a second. Keep
   new grid features compatible with this (no DOM lookups of off-screen cells).

## Testing

Vitest + Testing Library cover the file-explorer feature, `lib/path`,
`lib/column-widths` and `hooks/useColumnVirtualizer`;
`cargo test --lib` covers the extension matching in `commands/file.rs`.
Coverage is otherwise thin, so also verify manually:

1. Drag-and-drop with various Parquet files
2. Pagination, filtering and search on a large file
3. SQL view against table `t`
4. CSV/JSON export, including a custom row range
5. Recent files persistence across sessions
