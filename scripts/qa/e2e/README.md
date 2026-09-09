# End-to-end harness

Drives the real frontend (Vite dev server, WebKit via Playwright) against the
real Rust backend (`backend/examples/bridge.rs`) without the Tauri shell. This
is what caught the stale-response races, the uppercase-extension and glob
bugs, and the deep-`OFFSET` slowdown — everything short of native menus,
Finder and `alert()`, which stay on `docs/MANUAL_QA.md`.

## How it works

```
suite.mjs ── Playwright ──> WebKit (http://localhost:1420)
                               │  window.__TAURI_INTERNALS__.invoke(cmd, args)   (injected by lib.mjs)
                               ▼
                          exposeFunction('__bridgeInvoke')
                               │  {"id","cmd","args","delayMs"}  one JSON line per call
                               ▼
                   backend/target/debug/examples/bridge  ──> the same service functions the Tauri commands call
```

`lib.mjs` injects a fake `__TAURI_INTERNALS__` before the app loads. App
commands (`read_parquet_data`, `execute_sql`, …) are forwarded to the bridge
process; the plugin commands the UI uses are answered in-process (`event`
listeners are kept so `window.__emit('file-drop', [path])` delivers drops,
`dialog` returns whatever `window.__dialog.save/open` holds, `notification`
and `alert()` are recorded, `app|version` answers with `tauri.conf.json`'s
version so Settings shows the one a build would carry). `window.__delays[cmd] = ms` holds one command's
responses back, which is how the suite provokes out-of-order responses.

The bridge has no App Store: `iap_status` answers `unlocked` (the same
`AlwaysUnlocked` provider every build without the `app-store` feature uses),
so by default the free tier's tab limit and the upgrade prompt never appear
here. `launch({ iap: { ...FREE_STORE } })` puts a scripted store in front of
the `iap_*` commands instead — answered in the page, nothing reaches the
bridge — with the product and its price, what is owned, and whether a
purchase goes through, is cancelled, stays pending or is rejected
(`setStore(page, patch)` changes it mid-run; `pushIapStatus(page, status)`
is the `iap-status` event a refund or a purchase approved elsewhere
raises). S14 drives the limit, the prompt, the purchase, a refund and the
capped restore with it; the real store is still checked by hand on the
signed store build (`docs/MANUAL_QA.md`, MQ-12), which is the only place
the payment sheet exists.

`launch({ pendingFiles })` acts out a cold start from Finder: the harness has
no Tauri event loop to raise `RunEvent::Opened`, so the paths are seeded into
the bridge's `PendingOpen` (`PARQSEE_PENDING_FILES`) and the frontend drains
them with `take_pending_files` as it does at launch. A warm start — the file
opened while the window is up — is `finderOpen(page, paths)`, the `file-drop`
event `deliver_opened` emits. S12 covers both.

The bridge has no Tauri resource directory either: `sample_file_path`
answers with the checkout's `backend/resources/sample.parquet` (the bytes
the bundle carries), or with `PARQSEE_SAMPLE_FILE` when set. S13 opens it
from the Welcome screen and relaunches on it.

Workspace roots, recent files and the session (the open tabs) live in the
bridge's store (`bookmarks.json` under `PARQSEE_DATA_DIR`). `launch()` gives
every run a fresh directory under `out/data/`; pass the same `dataDir` to two
launches to act out a relaunch (S9 and S11 do — and note that a relaunch on a
store with tabs restores them). The bridge is not sandboxed and records no
security-scoped bookmarks, so the store and the explorer are covered here
and the grants themselves stay on `docs/MANUAL_QA.md`. `openFolder(page,
dir)` answers the folder dialog with `dir` and clicks Open Folder.

## Setup

```sh
cd backend   && cargo build --example bridge          # the bridge binary
cd frontend  && pnpm dev                              # keep running, port 1420
uv run scripts/qa/gen_fixtures.py                     # -> scripts/qa/fixtures/
cd scripts/qa/e2e && pnpm install                     # playwright-core
npx --package=playwright-core playwright install webkit   # once per machine
```

## Run

```sh
cd scripts/qa/e2e
pnpm smoke                 # one file, prints the grid
pnpm suite                 # the regression suite; exit code 1 on any FAIL/ERROR
ONLY=S3 pnpm suite         # one scenario prefix
pnpm large-file            # needs `uv run scripts/qa/gen_huge.py`; use a release bridge for real numbers
BRIDGE_BIN=../../../backend/target/release/examples/bridge pnpm suite
```

### Demo screenshots (`pnpm shots`)

Not a test: `shots.mjs` drives the same harness to photograph the app for the
site (#7) and the App Store listing (#16), so the pictures are the real UI
against the real backend rather than a mockup. The data is the bundled sample
(`backend/resources/sample.parquet`) copied into `out/demo/shop-data/` as a
small folder of orders files — `gen_fixtures.py` writes test shapes
(`corrupt.parquet`, `all_null.parquet`) that would look broken in a store
screenshot.

```sh
pnpm shots                          # 1280x800 @2x -> 2560x1600, en+ja, light+dark
SIZE=1440x900 pnpm shots            # -> 2880x1800
SIZE=1280x800 SCALE=1 pnpm shots    # the 1x sizes
LANGS=en THEMES=light pnpm shots    # one combination
```

The four sizes are what App Store Connect accepts; 2560x1600 and 2880x1800 are
the other two at `deviceScaleFactor` 2. Output: `out/shots/demo/`.

### The free tier's screens (`pnpm shots:license`)

Not a test either: `license-shots.mjs` photographs every state of the Free
badge, the upgrade prompt, Settings › Purchase and the restore notice over
the scripted store, in en/ja × light/dark, into `out/shots/license/`. This
is how those screens are looked at while they are being worked on — no
other build shows them with a price until the product exists in App Store
Connect. `LANGS` / `THEMES` / `SIZE` / `SCALE` as for `pnpm shots` (the
default here is @1x).

### Clicking around the free tier (`pnpm free-tier`)

`free-tier.mjs` opens the same thing in a headed WebKit window and leaves
it there until Enter: the badge, the prompt with the price, Buy (unlocks),
Restore (`OWNED=1` to make it unlock), Settings › Purchase. Open Folder is
answered with the demo folder; paths given as arguments open at launch.
`UI_LANG=ja THEME=dark` pick the language and theme, `NO_PRICE=1` the
store without a product.

### Checking the Content Security Policy

The release app serves the webview under the CSP in `backend/tauri.conf.json`
(`app.security.csp`); the Vite dev server sends none, so a violation — an
inline `<style>`, a `data:` image, a font, a `setAttribute('style', …)` —
breaks the release build only. `csp-server.mjs` serves the built frontend
with that header so the suite runs under it:

```sh
cd frontend && pnpm build                 # -> frontend/dist
cd scripts/qa/e2e && pnpm csp-server      # port 1421, reads the CSP from tauri.conf.json
DEV_URL=http://localhost:1421/ pnpm suite # in another shell
```

WebKit reports a violation as a console error starting with `Refused to`,
which the suite prints in the `page-errors` OBSERVE lines. One is expected
and harmless: `Refused to apply a stylesheet … (:5)` right after a
`page.screenshot()` — Playwright injects an inline `<style>` to hide the
caret. Anything else is a real violation. Run this after adding inline
styles/scripts, images, fonts or a new plugin. Only the release `.app`
exercises `connect-src` (the IPC goes through the fake `__TAURI_INTERNALS__`
here); that stays on `docs/MANUAL_QA.md` MQ-11.

Output goes to `out/` (git-ignored): `shots/*.png`, `suite_results.json`,
and the suite's export files. `BRIDGE_QUIET=1` silences the bridge's stderr.

Check statuses: `PASS`/`FAIL` are assertions; `OBSERVE` lines record
behaviour worth a look without asserting it; `ERROR` is an exception in the
scenario itself (screenshot in `out/shots/<scenario>-error.png`).

## Writing checks

- Scope every locator to the active tab: `div[style*="position: absolute"][style*="display: flex"]`.
  Hidden tabs keep their DOM (h1, footer, Export button, search input), so an
  unscoped `text=` locator matches the wrong tab.
- Use the fixtures by name from `FIX`; regenerate rather than hand-edit them.
- After changing the backend, rebuild the bridge — a stale binary is the
  usual reason a "fix" does not show up here.
- `cargo test` / `pnpm tauri build` and the bridge build share the target
  directory lock; don't run them concurrently.
