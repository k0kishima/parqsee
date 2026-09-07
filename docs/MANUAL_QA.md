# Manual QA checklist

The checks below are the ones the automated suites cannot make: they depend
on the macOS shell around the webview — native menus, Finder, the clipboard,
`alert()`, window management, code signing. Everything else (file parsing,
paging, filters, the SQL view, export, the explorer) is covered by
`cargo test --lib`, Vitest, and the end-to-end suite in `scripts/qa/e2e/`;
do not re-check those by hand.

## When to run

- Before tagging a release.
- After touching `build_menu` in `backend/src/lib.rs`,
  `backend/src/services/menu_labels.rs`, `backend/capabilities/`,
  `backend/Entitlements.plist`, `backend/src/services/access/`,
  `backend/storekit/`, `backend/src/services/store/`,
  `bundle.fileAssociations` or `bundle.resources` in `backend/tauri.conf.json`,
  `backend/Info.plist`, `scripts/release/`, the
  `RunEvent::Opened` handler in `backend/src/lib.rs`, any
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

The release app keeps everything it remembers (workspace roots, Recent
Files, the session tabs, the last export folder — `bookmarks.json` — and
the `localStorage` settings) inside its sandbox container,
`~/Library/Containers/llc.fuji.parqsee/`. To run the checks below from a
clean slate, quit the app and delete that folder; macOS recreates it at
the next launch. The bundle identifier was `com.parqsee.app` before the
release hardening (#3): a Mac that ran those builds still has their data
under `~/Library/Containers/com.parqsee.app/` (release) and, from
`pnpm tauri dev`, under `~/Library/Application Support/com.parqsee.app/`,
`~/Library/WebKit/com.parqsee.app/` and `~/Library/Caches/com.parqsee.app/`.
Nothing reads them any more; delete them.

### The store build (MQ-12)

The free tier's limit and the purchase only exist in the build with the
`app-store` Cargo feature, which links the StoreKit bridge
(`backend/storekit/`):

```sh
cd frontend && pnpm tauri:store        # tauri build --config tauri.appstore.conf.json
```

Every other build — `pnpm tauri build`, `pnpm tauri dev`, the e2e bridge —
owns the full version and never shows the limit, so MQ-1 to MQ-11 are
unaffected by the store work and cannot check it.

StoreKit answers only an app that carries a provisioning profile and is
signed by the same team, and then it talks to the **sandbox** App Store
(no money changes hands). Tauri signs ad hoc, so re-sign the bundle:

```sh
scripts/qa/sign_for_storekit.sh backend/target/release/bundle/macos/Parqsee.app \
    ~/Downloads/Parqsee_Development.provisionprofile \
    "Apple Development: <name> (<TEAMID>)"
```

The profile is a *Mac App Development* profile for the App ID
`llc.fuji.parqsee` (Certificates, Identifiers & Profiles), the identity the
Apple Development certificate it names (`security find-identity -v -p
codesigning`). Without them the upgrade prompt still appears but reads
*The App Store did not return a price* and the buttons fail — that is the
unsigned build, not a bug. Purchases need a **Sandbox tester** account
(App Store Connect › Users and Access › Sandbox), never a real Apple
Account; macOS asks for it at the first purchase. The purchase lives in
that account's history on Apple's side: deleting the app or its container
does not reset it, and a fresh Sandbox tester is the only way to see the
free tier again. In System Settings › App Store, the *Sandbox Account*
section shows who is signed in and lets you sign out.

The pitfalls of driving the release app from a terminal apply here too:
`open` reuses a running instance of the same app (quit it first), and a
locked screen makes every screenshot black.

The submission itself is `scripts/release/appstore.sh` (build → sign with
the Mac App Store profile and the Apple Distribution identity → `.pkg` →
`scripts/release/upload_pkg.sh` on `--upload`, which validates and uploads
through `xcrun altool`; the `APPLE_*` variables are in their headers).
Its dry run, `scripts/release/appstore.sh --unsigned`, is what MQ-11
installs: the same universal `.pkg` around the ad-hoc signed `.app`. A
package signed for the store cannot be checked here — an app signed with
an Apple Distribution certificate only runs when the App Store or
TestFlight installed it — so the signed build is checked through
TestFlight for Mac (#16), not on this list.

Each item lists why it cannot be automated. An item that loses that reason
should be moved into the harness and removed from this list; keep the list
around ten items or nobody will run it.

## Checks

### MQ-1 · Native menu and shortcuts

| | |
|---|---|
| Fixture | any two files, e.g. `one_row.parquet` and `numeric.parquet` |
| Steps | Check the menu bar shows **Parqsee › Settings…** (⌘,) and **File › Open…** (⌘O) / **Open Folder…** (⇧⌘O) / **Open Recent ▸** / **Close Tab** (⌘W) / **Reopen Closed Tab** (⇧⌘T). With no folder open, open two tabs, press ⌘W. Press ⇧⌘T. Press ⌘W again on the last tab, then ⇧⌘T twice. Press ⌘O, ⇧⌘O, then ⌘,. Open the fixtures folder with ⇧⌘O, open a tab, press ⌘W. Then **File › Open Recent**: pick a file from it; open `paths/dir with space/inner.parquet` and another `inner.parquet` from a different folder, look at the submenu again; ✕ an entry in the top row's panel and look again; choose **Clear Menu**, then look at the Welcome screen and the panel. Then the rest of the menu bar: **Edit › Find…** (⌘F) / **Find Next** (⌘G) / **Find Previous** (⇧⌘G), **View › Toggle Sidebar** (⌘B) / **Switch Content / Query** (⌘E), **Query › Run Query** (⌘↩), **Window › Show Previous Tab** (⇧⌘[) / **Show Next Tab** (⇧⌘]), **Help › Keyboard Shortcuts** (⌘/) / **Parqsee Help**. With two tabs open: press ⌘F, type a value that occurs and Enter, click a cell in the grid, press ⌘G and ⇧⌘G; press ⌘E twice; in the SQL editor type a query and press ⌘↩; press ⇧⌘] and ⌘1; press ⌘B twice; press ⌘/ twice; choose **Help › Parqsee Help**; type `short` in the Help menu's search field. |
| Expected | ⌘W closes only the active tab; on the last tab it returns to the Welcome screen and the window stays open. ⇧⌘T brings the tab just closed back, active, on the page it was on — from the Welcome screen too; a third press with nothing left closed does nothing. ⌘O shows the file dialog, ⇧⌘O the folder dialog; ⌘, opens Settings. With a folder open, closing the last tab keeps the sidebar and shows the Welcome content next to it. Open Recent lists the same files as the Welcome screen, newest first (at most ten), and picking one opens it in a tab and moves it to the top; the two `inner.parquet` show as `inner.parquet — <folder>`; the entry removed in the panel is gone from the submenu at once; Clear Menu empties the submenu (Clear Menu itself greys out), the Welcome list and the panel with no confirmation asked. Every item listed is in the menu bar with that key beside it. ⌘F opens the search bar of the active tab; ⌘G and ⇧⌘G step through the matches with the grid focused, not the search box; ⌘E switches the tab to Query and back; ⌘↩ runs the query with the editor focused; ⇧⌘] and ⌘1 move between the tabs; ⌘B hides and shows the sidebar; ⌘/ opens the shortcut sheet and closes it again; Parqsee Help opens the support page in the browser, in the UI's language; the Help search field lists **Keyboard Shortcuts**. |
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
| Steps | Open the fixtures folder with ⇧⌘O first. Drag each onto different regions of the window (Welcome drop zone, the grid, the sidebar). Drag the three-file selection at once. |
| Expected | Every file opens in a tab with rows in the grid; the three-file drop opens three tabs; dropping the directory does nothing harmful. |
| Why manual | The harness emits synthetic `file-drop` events; only Finder exercises the real drag source and the window's drop regions. |

### MQ-4 · Export completion, Copy Path and Reveal in Finder

| | |
|---|---|
| Fixture | `multi_rowgroup.parquet` |
| Steps | Open the fixtures folder (⇧⌘O) and the fixture from the tree. Export → CSV: note where the save panel opens, save into a different folder (say `~/Downloads`). When the modal switches to the completed state, click **Copy Path** and ⌘V into any text field, then click **Reveal in Finder**. Repeat once with a row range (e.g. 100–200). Then drop a file from outside the fixtures folder on the window and start an export. |
| Expected | The first save panel opens in the fixtures folder with `multi_rowgroup.csv` filled in; the modal shows the row count and destination path; the button reads **Copied** briefly and the full path is pasted; Finder opens with the file selected. The second export from the fixtures folder still starts there (its own folder wins); the export of the dropped file starts in the folder you saved into. A system notification is a bonus, not a requirement (the first export may prompt for permission). |
| Why manual | `plugin-opener`'s `revealItemInDir`, the save panel's start folder and the notification permission prompt only exist in the real shell; `navigator.clipboard` availability differs between WKWebView and the Playwright build of WebKit. |

### MQ-5 · Explorer context menu

| | |
|---|---|
| Fixture | any file in the sidebar tree (open the fixtures folder with ⇧⌘O first) |
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

### MQ-8 · Sandbox: folders, recent files and tabs survive a restart

| | |
|---|---|
| Fixture | the fixtures folder; `one_row.parquet`, `numeric.parquet` and `multi_rowgroup.parquet`; a copy of `dict.parquet` somewhere outside the fixtures folder |
| Steps | Open the fixtures folder (⇧⌘O) and, from the tree, `one_row.parquet`. Drop the `dict.parquet` copy on the window; pick `numeric.parquet` with ⌘O; open `multi_rowgroup.parquet` from the tree and go to its page 2; switch `one_row.parquet` to the Query view; click the `dict.parquet` tab so it is the active one. Export the dropped copy to CSV into a folder outside the fixtures folder (say `~/Downloads`). Quit with ⌘Q, relaunch. Expand a subfolder in the tree, open a file from it, open each Recent Files entry; start an export of the dropped copy and cancel the panel. Quit, move the `dict.parquet` copy to another folder in Finder and delete `numeric.parquet` (regenerate the fixtures afterwards with `uv run scripts/qa/gen_fixtures.py`), relaunch. Then turn *Restore tabs from the last session* off in Settings, quit, relaunch. |
| Expected | After the first relaunch the sidebar shows the fixtures tree without asking, the subfolder lists, and every Recent Files entry opens — including the dropped and the ⌘O-picked file, which no folder covers. The tabs are back in the same order with `dict.parquet` active, `multi_rowgroup.parquet` on page 2 and `one_row.parquet` in the Query view, and Recent Files is in the same order as before the quit (a restore does not count as an open). The save panel opens in the folder you exported into before quitting. After the move and the delete, the moved `dict.parquet` copy still opens from Recent Files (the bookmark follows the file) and its tab is back; `numeric.parquet` shows *No longer available* in Recent Files (on click, an alert and then it disappears) and its tab is not restored: a one-line notice at the bottom names the file (*1 file from the last session could not be reopened*), goes away on ✕, and does not come back on the next relaunch. With the setting off the app launches on the welcome screen (the folder is still restored, so the tree is there). `ls ~/Library/Containers/llc.fuji.parqsee/Data/Library/Application\ Support/llc.fuji.parqsee/bookmarks.json` exists, its root and recent entries carry a `bookmark`, `session.tabs[*]` carry one each (the same bytes as the recent entry for the same file) with their `state`, and `last_export` holds the export folder (its `bookmark` is expected to be `null`: the save panel grants the file, not the folder). |
| Why manual | Security-scoped bookmarks and their grants only exist under the App Sandbox, which only the signed release bundle runs in; the harness's bridge is unsandboxed and records none. |

### MQ-9 · Opening from Finder

| | |
|---|---|
| Fixture | `scripts/qa/fixtures/paths/sp ace.parquet`, `pct%20.parquet`, `hash#1.parquet` and `日本語ファイル.parquet`; `multi_rowgroup.parquet` |
| Steps | Run `plutil -p backend/target/release/bundle/macos/Parqsee.app/Contents/Info.plist \| grep -A 8 CFBundleDocumentTypes`. Quit the app (`osascript -e 'quit app "Parqsee"'`) and **cold start** it three ways, one per file from `paths/`, quitting in between: double-click the file in Finder; drop it on the Dock icon; `open -a Parqsee '<path>'`. With the app running (**warm start**), double-click `日本語ファイル.parquet`, then minimize the window and `open -a Parqsee <path to multi_rowgroup.parquet>`. Right-click a `.parquet` in Finder → *Open With*. Finally quit, relaunch, and open the first file again from Recent Files. |
| Expected | The Info.plist lists a `CFBundleDocumentTypes` entry with `CFBundleTypeExtensions = (parquet)` and `CFBundleTypeRole = Viewer`. Each cold start opens the window on that file with the grid filled — the names with a space, a `%`, a `#` and Japanese characters all open, since the URL is converted with `Url::to_file_path` and not by string surgery. A cold start that flashes and disappears is the regression to watch for: `RunEvent::Opened` arrives before `RunEvent::Ready`, so anything the handler expects the setup hook to have prepared panics inside an Objective-C callback and aborts the process (`pgrep -f MacOS/parqsee` empty a second after `open`, an `.ips` in `~/Library/Logs/DiagnosticReports`). A warm start adds a tab for the file and makes it the active one, without disturbing the tabs already open; the minimized window comes back to the front. Finder offers Parqsee in *Open With* for `.parquet` files. After the relaunch the first file is in Recent Files and opens from it — the Finder open went through `remember_file`, so its bookmark exists (this is the part the sandbox breaks if `RunEvent::Opened` ever grows its own access path). |
| Why manual | Launch Services integration: only the installed bundle's `Info.plist` is read by Finder and the Dock, and only a real launch raises `RunEvent::Opened`. |
| Pitfalls | Most of this can be judged without looking at the window: the container's `bookmarks.json` (see [How to run](#how-to-run)) gains the file in `recent` with a `bookmark`, and `session.tabs`/`session.active` show the order and which tab is active. `open` reuses a running Parqsee, so a cold start needs the quit first (and *Quit* really quits: the app has no menu-bar item left behind). If Finder still opens the old handler after you replace the `.app`, re-register it: `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f backend/target/release/bundle/macos/Parqsee.app`. If Finder does not offer Parqsee at all, `.parquet` has no system UTI and the extension-only declaration was not enough — add an `exportedType` (`UTExportedTypeDeclarations`) to `bundle.fileAssociations` and rebuild. Do not check any of this over a locked screen: `screencapture` returns black and System Events cannot see the window. |

### MQ-10 · Gatekeeper on another Mac

| | |
|---|---|
| Fixture | `backend/target/release/bundle/dmg/Parqsee_*.dmg` from `pnpm tauri build --bundles dmg` (the default build makes only the `.app`) |
| Steps | Copy the dmg to a Mac that has never run Parqsee, open it, launch the app. |
| Expected | **Currently blocked** with "cannot verify the developer" (ad-hoc signature, not notarized). Update this expectation once signing and notarization are set up. |
| Why manual | Gatekeeper's verdict depends on the signing identity and notarization ticket of the actual artifact. |

### MQ-11 · Sandbox entitlements and file access

| | |
|---|---|
| Fixture | the package from `scripts/release/appstore.sh --unsigned` (`backend/target/universal-apple-darwin/release/bundle/macos/Parqsee-<version>.pkg`), installed with `sudo installer -pkg <that .pkg> -target /`; `multi_rowgroup.parquet` |
| Steps | Run `pkgutil --expand <the .pkg> /tmp/parqsee-pkg` and read `/tmp/parqsee-pkg/*.pkg/PackageInfo`; then `lipo -info /Applications/Parqsee.app/Contents/MacOS/parqsee`, `codesign -d --entitlements - /Applications/Parqsee.app`, `plutil -p /Applications/Parqsee.app/Contents/Info.plist` and `ls /Applications/Parqsee.app/Contents/Resources/sample.parquet`. Delete the container (see [How to run](#how-to-run)), launch `/Applications/Parqsee.app` and keep Console.app open filtered on `Parqsee`. On the Welcome screen click **Open the sample file**; ⌘Q, relaunch. Close the tab. Open a folder, browse it, open a file, export it to CSV into a folder you choose in the save dialog (not the workspace folder), then **Reveal in Finder**. Right-click a file → **Reveal in Finder**. Run `pnpm tauri dev` once and click **Open the sample file** there too. |
| Expected | `PackageInfo` names `llc.fuji.parqsee` with `install-location="/Applications"`, and the app is at `/Applications/Parqsee.app` afterwards. The binary is universal (`x86_64 arm64`). `Info.plist` carries `LSApplicationCategoryType` = `public.app-category.developer-tools`, `LSMinimumSystemVersion` = `12.0` and `ITSAppUsesNonExemptEncryption` = false — App Store Connect rejects an upload without the first. The entitlements list exactly `com.apple.security.app-sandbox`, `com.apple.security.files.user-selected.read-write`, `com.apple.security.files.bookmarks.app-scope` and `com.apple.security.network.client` (the last one is for WKWebView's helper processes; without it the window stays blank). The sample file is in the bundle's `Resources/`. The window renders the Welcome screen with the logo — a blank white window means the sandbox is blocking the webview. The sample opens in a tab `sample.parquet` with 1,500 rows × 14 columns (the bundle is readable under the sandbox without a bookmark; a `File not found` alert here means `resource_dir()` resolved somewhere else), the tab is back after the relaunch, and Recent Files stays empty — the sample is never recorded there. Everything else works and Console shows no `deny` lines from `sandboxd` for Parqsee. The dev build starts and behaves as before (it is unsandboxed; that is expected), and opens the sample too — `tauri-build` copies it next to the debug binary. The release webview also runs under the CSP from `tauri.conf.json`, which the dev build does not: the grid's columns keep their widths and the logo shows (a violation would drop them), and a page read is as fast as it was — if the CSP blocked the IPC, Tauri would silently fall back to `postMessage` and every `invoke` would get slower. Release builds have no Web Inspector, so the violation list itself comes from the harness: `scripts/qa/e2e/csp-server.mjs` (see its README) before this check. |
| Why manual | Whether the sandbox is actually applied depends on the signature of the built artifact; every automated suite runs an unsandboxed binary, and only the real webview sends the IPC through `ipc://localhost`. |

### MQ-12 · StoreKit sandbox: the free tier and the purchase

| | |
|---|---|
| Fixture | the store build, re-signed as described in [The store build](#the-store-build-mq-12); a **new** Sandbox tester account; the fixtures folder with at least five files, e.g. `one_row.parquet`, `numeric.parquet`, `dict.parquet`, `multi_rowgroup.parquet`, `all_null.parquet` |
| Steps | Sign out of any Sandbox account (System Settings › App Store), delete the container, launch. Open the fixtures folder (⇧⌘O) and three files from the tree; page, filter, run a query, export one. Open a fourth file from the tree, then drop a fifth on the window. Read the prompt; press Escape. Click a tab that is already open, then click **Free · Upgrade** in the header and ✕. Close one tab, open the fourth file again. Open Settings › Purchase. Quit and relaunch. With the three tabs back, click **Free · Upgrade**, then **Restore purchases** (sign in with the new tester when asked). Click **Buy for …**, confirm with the tester. Open the fourth and fifth files. Quit, relaunch. Open Settings › Purchase. Quit, delete the app and its container, build/sign/launch again with the same tester; open four files, and on the prompt click **Restore purchases**. Finally run `pnpm tauri build` (no feature) and launch that app and open four files. |
| Expected | The app launches straight to the Welcome screen; the header carries a small *Free · Upgrade* badge. Three files open and everything in them works (rows, paging, filters, SQL, export). The fourth open and the drop each bring up the upgrade prompt — the limit (3 tabs), *Everything else works*, the price in the tester's storefront currency, a Buy button with the same price, Restore, *Not now* — and open no tab; Escape and ✕ only close the prompt, the three tabs stay. Clicking an open tab at the limit switches to it without the prompt. After closing a tab the fourth file opens. Settings › Purchase says *Free version · up to 3 tabs at a time* with Buy / Restore. After the relaunch the three tabs are back. Restore with nothing owned leaves things as they are (no error). Buy shows the sandbox payment sheet; on confirmation the prompt closes, the badge is gone, the fourth and fifth files open, and after the relaunch all five tabs are back; Settings › Purchase says *Full version — unlocked* without Buy / Restore. After the reinstall the app is on the free tier again (the app knows nothing yet); the prompt appears at the fourth file, and Restore purchases signs in and unlocks it at once — the prompt closes and the badge goes. The build without the feature opens four files, shows no badge and never shows any of this. |
| Why manual | The App Store (sandbox) is on the other end: the product, the payment sheet and the account's purchase history live there. The unit tests cover the state with a fake store and the tab limit with a mocked license; only this checks the bridge against the real one. |

### MQ-13 · The menu bar's language

| | |
|---|---|
| Fixture | none; a Mac whose system language is Japanese for the last step (System Settings › General › Language & Region) |
| Steps | With the app's language on English, read the menu bar: **Parqsee** (About / Settings… / Services / Hide / Quit), **File**, **Edit**, **View**, **Query**, **Window**, **Help**. Open Settings and switch Language to **日本語**. Read the menu bar again, every submenu opened, **File › 最近使った項目を開く ▸** included (open a file first so it has entries). Quit and relaunch; look at the menu bar before touching anything. Switch back to English, quit, relaunch. Finally, on a Mac set to Japanese, remove the container (`~/Library/Containers/llc.fuji.parqsee`) and launch. |
| Expected | Switching the setting retitles the whole menu bar at once, with no relaunch: 開く… / フォルダを開く… / 最近使った項目を開く / メニューを消去 / タブを閉じる / 閉じたタブを開く, 検索… / 次を検索, サイドバーの表示 / 非表示, クエリを実行, しまう, キーボードショートカット, Parqsee を終了. The keys beside the items do not move. After a relaunch the menu bar is in the chosen language **in its first frame** — no flash of English. On the Japanese Mac with no settings saved, the UI *and* the menu come up in Japanese without opening Settings. What stays in the system's language whatever the setting is not a bug: the **サービス / Services** submenu's contents, the Help menu's search field, Emoji & Symbols, the About panel and the open / save dialogs — AppKit supplies those. |
| Why manual | There is no menu bar without a running `NSApplication`, and the language the menu starts in comes from `NSLocale.preferredLanguages`, which no harness can set. |

## Results template

```markdown
Manual QA — <version> — <date> — <macOS version, chip>
- [ ] MQ-1 Native menu and shortcuts
- [ ] MQ-2 Failed opens show an alert
- [ ] MQ-3 Drag and drop from Finder
- [ ] MQ-4 Export completion, Copy Path and Reveal in Finder
- [ ] MQ-5 Explorer context menu
- [ ] MQ-6 Large file
- [ ] MQ-7 Window and appearance
- [ ] MQ-8 Sandbox: folders, recent files and tabs survive a restart
- [ ] MQ-9 Opening from Finder
- [ ] MQ-10 Gatekeeper on another Mac
- [ ] MQ-11 Sandbox entitlements and file access
- [ ] MQ-12 StoreKit sandbox: the free tier and the purchase
- [ ] MQ-13 The menu bar's language
Notes: <anything that differed from Expected, with what happened>
```
