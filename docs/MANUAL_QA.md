# Manual QA checklist

The checks below are the ones the automated suites cannot make: they depend
on the macOS shell around the webview — native menus, Finder, the clipboard,
`alert()`, window management, code signing. Everything else (file parsing,
paging, filters, the SQL view, export, the explorer) is covered by
`cargo test --lib`, Vitest, and the end-to-end suite in `scripts/qa/e2e/`;
do not re-check those by hand.

## When to run

- Before tagging a release.
- After touching `build_menu` in `backend/src/lib.rs`, `backend/capabilities/`,
  `backend/Entitlements.plist`, `backend/src/services/access/`, any
  `tauri-plugin-*` dependency, or the Tauri version — those are the things
  that silently break the items below.

## How to run

1. Build the release app: `cd frontend && pnpm tauri build`. Test
   `backend/target/release/bundle/macos/Parqsee.app`. **Never use
   `pnpm tauri dev` for these checks** — the debug backend is ~20× slower on
   scans, and a multi-second page read there looks like a hang, and the dev
   build is not sandboxed, so the bookmark items below pass there for the
   wrong reason.
2. Generate the fixtures (needs [uv](https://docs.astral.sh/uv/); pyarrow is
   fetched on first run):
   ```sh
   uv run scripts/qa/gen_fixtures.py        # -> scripts/qa/fixtures/ (git-ignored)
   uv run scripts/qa/gen_huge.py            # -> scripts/qa/fixtures/huge.parquet, 2.5 GiB
   ```
3. Copy the [results template](#results-template) into the release PR or
   issue and tick items off there. Do not record results in this file.

Each item lists why it cannot be automated. An item that loses that reason
should be moved into the harness and removed from this list; keep the list
around ten items or nobody will run it.

## Checks

### MQ-1 · Native menu and shortcuts

| | |
|---|---|
| Fixture | any two files, e.g. `one_row.parquet` and `numeric.parquet` |
| Steps | Check the menu bar shows **Parqsee › Settings…** (⌘,) and **File › Open…** (⌘O) / **Open Folder…** (⌘⇧O) / **Close Tab** (⌘W). With no folder open, open two tabs, press ⌘W. Press ⌘W again on the last tab. Press ⌘O, ⌘⇧O, then ⌘,. Open the fixtures folder with ⌘⇧O, open a tab, press ⌘W. |
| Expected | ⌘W closes only the active tab; on the last tab it returns to the Welcome screen and the window stays open. ⌘O shows the file dialog, ⌘⇧O the folder dialog; ⌘, opens Settings. With a folder open, closing the last tab keeps the sidebar and shows the Welcome content next to it. |
| Why manual | Native key equivalents are handled by AppKit before the webview sees the keydown; headless WebKit has no menu bar. |

### MQ-2 · Failed opens show an alert

| | |
|---|---|
| Fixture | `dup_names.parquet`, `notparquet.parquet`, `corrupt.parquet`, `paths/broken_link.parquet`; plus a recent-files entry whose file you have since deleted |
| Steps | Drop each file on the window. Click the deleted entry on the Welcome screen. |
| Expected | A dialog appears each time with the reason (duplicate column, not a parquet file, …, `File not found: <path>`); no tab is opened; the deleted entry disappears from recent files. |
| Why manual | Whether `alert()` renders is a WKWebView property; the harness stubs it. A missing dialog makes every failed open silent. |

### MQ-3 · Drag and drop from Finder

| | |
|---|---|
| Fixture | `paths/` — `UPPER.PARQUET`, `glob[1].parquet`, `sp ace.parquet`, `日本語ファイル.parquet`, `folder.parquet/`; plus a multi-selection of three files |
| Steps | Open the fixtures folder with ⌘⇧O first. Drag each onto different regions of the window (Welcome drop zone, the grid, the sidebar). Drag the three-file selection at once. |
| Expected | Every file opens in a tab with rows in the grid; the three-file drop opens three tabs; dropping the directory does nothing harmful. |
| Why manual | The harness emits synthetic `file-drop` events; only Finder exercises the real drag source and the window's drop regions. |

### MQ-4 · Export completion and Reveal in Finder

| | |
|---|---|
| Fixture | `multi_rowgroup.parquet` |
| Steps | Export → CSV, accept the save dialog. When the modal switches to the completed state, click **Reveal in Finder**. Repeat once with a row range (e.g. 100–200). |
| Expected | The modal shows the row count and destination path; Finder opens with the file selected. A system notification is a bonus, not a requirement (the first export may prompt for permission). |
| Why manual | `plugin-opener`'s `revealItemInDir` and the notification permission prompt only exist in the real shell. |

### MQ-5 · Explorer context menu

| | |
|---|---|
| Fixture | any file in the sidebar tree (open the fixtures folder with ⌘⇧O first) |
| Steps | Right-click a file → **Copy Path**, then ⌘V into any text field. Right-click → **Reveal in Finder**. |
| Expected | The full absolute path is pasted; Finder opens with the file selected. |
| Why manual | `navigator.clipboard` availability differs between WKWebView and the Playwright build of WebKit. |

### MQ-6 · Large file

| | |
|---|---|
| Fixture | `huge.parquet` (58M rows, 2.5 GiB, `gen_huge.py`) |
| Steps | Open it. Jump to the last page (»). Apply the filter `x > 3`, then clear it. Export all rows to CSV (~6 GB, ~30 s) and, while it runs, page and switch tabs. Watch memory in Activity Monitor. Delete the CSV afterwards. |
| Expected | Open < 3 s; the last page renders in well under a second; the filter count returns in < 1 s; the UI stays responsive during the export; memory stays flat (≈150 MB). |
| Why manual | Timing and memory behaviour on the real runtime; the reference numbers above were measured on the release backend and must hold in the bundled app. |

### MQ-7 · Window and appearance

| | |
|---|---|
| Fixture | any file |
| Steps | Shrink the window to its minimum size. Enter and leave full screen. Toggle System Settings › Appearance between Light and Dark with the app in the foreground (Settings › Theme set to *System*). |
| Expected | Sidebar and header controls remain usable at minimum size; the layout survives full screen; the theme follows the system immediately. |
| Why manual | Window management and the appearance change are delivered by the OS. |

### MQ-8 · Sandbox: folders and recent files survive a restart

| | |
|---|---|
| Fixture | the fixtures folder; `one_row.parquet` and `numeric.parquet`; a copy of `dict.parquet` somewhere outside the fixtures folder |
| Steps | Open the fixtures folder (⌘⇧O) and, from the tree, `one_row.parquet`. Drop the `dict.parquet` copy on the window; pick `numeric.parquet` with ⌘O. Quit with ⌘Q, relaunch. Expand a subfolder in the tree, open a file from it, open each Recent Files entry. Quit, move the `dict.parquet` copy to another folder in Finder, delete `numeric.parquet`'s copy if you made one (or move it too), relaunch. |
| Expected | After the first relaunch the sidebar shows the fixtures tree without asking, the subfolder lists, and every Recent Files entry opens — including the dropped and the ⌘O-picked file, which no folder covers. After the move the moved entry still opens (the bookmark follows the file); a deleted one shows *No longer available* and, on click, an alert and then disappears. `ls ~/Library/Containers/com.parqsee.app/Data/Library/Application\ Support/com.parqsee.app/bookmarks.json` exists and its entries carry a `bookmark`. |
| Why manual | Security-scoped bookmarks and their grants only exist under the App Sandbox, which only the signed release bundle runs in; the harness's bridge is unsandboxed and records none. |

### MQ-9 · Opening from Finder (known gap)

| | |
|---|---|
| Fixture | any file |
| Steps | Double-click a `.parquet` in Finder; drop one on the Dock icon. |
| Expected | **Currently nothing happens** — the bundle declares no document types and there is no `RunEvent::Opened` handler. Record the result so the release notes can state it; update this expectation once the association ships. |
| Why manual | Launch Services integration. |

### MQ-10 · Gatekeeper on another Mac

| | |
|---|---|
| Fixture | `backend/target/release/bundle/dmg/Parqsee_*.dmg` |
| Steps | Copy the dmg to a Mac that has never run Parqsee, open it, launch the app. |
| Expected | **Currently blocked** with "cannot verify the developer" (ad-hoc signature, not notarized). Update this expectation once signing and notarization are set up. |
| Why manual | Gatekeeper's verdict depends on the signing identity and notarization ticket of the actual artifact. |

### MQ-11 · Sandbox entitlements and file access

| | |
|---|---|
| Fixture | the release `.app`; `multi_rowgroup.parquet` |
| Steps | Run `codesign -d --entitlements - backend/target/release/bundle/macos/Parqsee.app`. Launch the app and keep Console.app open filtered on `Parqsee`. Open a folder, browse it, open a file, export it to CSV into a folder you choose in the save dialog (not the workspace folder), then **Reveal in Finder**. Right-click a file → **Reveal in Finder**. Run `pnpm tauri dev` once. |
| Expected | The entitlements list exactly `com.apple.security.app-sandbox`, `com.apple.security.files.user-selected.read-write` and `com.apple.security.files.bookmarks.app-scope`. Everything works and Console shows no `deny` lines from `sandboxd` for Parqsee. The dev build starts and behaves as before (it is unsandboxed; that is expected). |
| Why manual | Whether the sandbox is actually applied depends on the signature of the built artifact; every automated suite runs an unsandboxed binary. |

## Results template

```markdown
Manual QA — <version> — <date> — <macOS version, chip>
- [ ] MQ-1 Native menu and shortcuts
- [ ] MQ-2 Failed opens show an alert
- [ ] MQ-3 Drag and drop from Finder
- [ ] MQ-4 Export completion and Reveal in Finder
- [ ] MQ-5 Explorer context menu
- [ ] MQ-6 Large file
- [ ] MQ-7 Window and appearance
- [ ] MQ-8 Sandbox: folders and recent files survive a restart
- [ ] MQ-9 Opening from Finder (known gap)
- [ ] MQ-10 Gatekeeper on another Mac
- [ ] MQ-11 Sandbox entitlements and file access
Notes: <anything that differed from Expected, with what happened>
```
