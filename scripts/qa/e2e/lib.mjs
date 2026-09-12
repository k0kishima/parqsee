// Playwright WebKit harness that drives the Parqsee frontend (Vite dev
// server) against the real Rust backend through backend/examples/bridge.rs.
//
// The page gets a fake `__TAURI_INTERNALS__` whose `invoke` forwards every
// app command to the bridge process and answers the plugin commands the UI
// uses (event, dialog, notification) in-process — and, when a launch asks
// for one, the App Store (`iap_*`, see `launch({ iap })`). See README.md.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { webkit, chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..', '..');
/** Fixtures from `uv run scripts/qa/gen_fixtures.py` (override: FIXTURES). */
export const FIX = process.env.FIXTURES ?? path.join(ROOT, 'scripts', 'qa', 'fixtures');
/** Screenshots, exports and results land here (git-ignored; override: E2E_OUT). */
export const OUT = process.env.E2E_OUT ?? path.join(HERE, 'out');
/** `cargo build --example bridge`; BRIDGE_BIN selects another build, e.g. release. */
export const BRIDGE_BIN = process.env.BRIDGE_BIN ?? path.join(ROOT, 'backend', 'target', 'debug', 'examples', 'bridge');
export const DEV_URL = process.env.DEV_URL ?? 'http://localhost:1420/';
/** What `getVersion()` answers in the harness: the version the bundle would carry. */
export const APP_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'backend', 'tauri.conf.json'), 'utf8')).version;

for (const dir of [OUT, path.join(OUT, 'shots')]) mkdirSync(dir, { recursive: true });

/** The bundled sample: 1,500 orders of a fictional web shop, the only realistic Parquet in the repository. */
export const SAMPLE = path.join(ROOT, 'backend', 'resources', 'sample.parquet');
/** The demo workspace `writeDemoData` lays out, for screenshots. */
export const DEMO = path.join(OUT, 'demo', 'shop-data');
/** The files in it, in the order the screenshots open them. */
export const DEMO_FILES = [
  path.join(DEMO, 'orders.parquet'),
  ...['2024-09', '2024-10', '2024-11', '2024-12'].map(m => path.join(DEMO, 'orders', `${m}.parquet`)),
];

/**
 * A folder of files for the screenshots: the sample under names that say
 * what its rows are — orders, by month, over the year the sample covers
 * (2024), so nothing in the tree contradicts the dates in the grid. The
 * fixtures from `gen_fixtures.py` are test shapes (`corrupt.parquet`,
 * `all_null.parquet`) that would look broken in a store screenshot.
 */
export function writeDemoData() {
  rmSync(DEMO, { recursive: true, force: true });
  mkdirSync(path.join(DEMO, 'orders'), { recursive: true });
  for (const file of DEMO_FILES) copyFileSync(SAMPLE, file);
}

export class Bridge {
  /**
   * `dataDir` is where the bridge keeps workspace roots and recent files
   * (bookmarks.json); `pendingFiles` are the paths a cold start from Finder
   * hands over (drained once by `take_pending_files`).
   */
  constructor(dataDir, pendingFiles = []) {
    if (!existsSync(BRIDGE_BIN)) {
      throw new Error(`bridge binary not found at ${BRIDGE_BIN} — run \`cargo build --example bridge\` in backend/`);
    }
    this.proc = spawn(BRIDGE_BIN, [], {
      stdio: ['pipe', 'pipe', process.env.BRIDGE_QUIET ? 'ignore' : 'inherit'],
      env: { ...process.env, PARQSEE_DATA_DIR: dataDir, PARQSEE_PENDING_FILES: pendingFiles.join('\n') },
    });
    this.pending = new Map();
    this.seq = 0;
    this.log = [];
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ('err' in msg) p.reject(msg.err); else p.resolve(msg.ok);
    });
  }
  call(cmd, args, delayMs = 0) {
    const id = ++this.seq;
    this.log.push({ cmd, args });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, args, delayMs }) + '\n');
    });
  }
  close() { this.proc.stdin.end(); this.proc.kill(); }
}

const INIT = `
window.__cbs = {};
window.__listeners = {};
window.__notifications = [];
window.__alerts = [];
// \`confirm\` answers the native OK / Cancel panel the app asks before a
// destructive action (lib/dialog.ts); the real plugin shows a sheet.
window.__dialog = { save: null, open: null, confirm: true };
window.__delays = {};
// The App Store, scripted. \`null\` hands the \`iap_*\` commands to the bridge,
// whose store is \`AlwaysUnlocked\`: no limit, no prompt, no badge. A launch
// with \`iap\` set answers them here instead — see \`FREE_STORE\` and
// \`setStore\` — which is the only way the free tier is reachable outside a
// signed store build. \`__purchases\` records every product id bought.
window.__iap = null;
window.__purchases = [];
window.__iapInvoke = async (cmd, args) => {
  const s = window.__iap;
  const delay = window.__delays[cmd] || 0;
  if (delay) await new Promise(r => setTimeout(r, delay));
  const unlock = () => { s.status = Object.assign({}, s.status, { state: 'unlocked' }); };
  switch (cmd) {
    case 'iap_status': return s.status;
    case 'iap_products': if (s.productsError) throw s.productsError; return s.products;
    case 'iap_purchase': {
      window.__purchases.push(args.productId);
      if (s.purchaseError) throw s.purchaseError;
      if (s.purchaseOutcome === 'purchased') unlock();
      return { outcome: s.purchaseOutcome, status: s.status };
    }
    case 'iap_restore': if (s.restoreError) throw s.restoreError; if (s.owned) unlock(); return s.status;
    default: throw 'unmocked ' + cmd;
  }
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event, id) { const l = window.__listeners[event] || []; window.__listeners[event] = l.filter(x => x.id !== id); } };
let cbId = 0;
// What Tauri's own init script sets, and what the API's isTauri() reads
// (lib/tauri.ts re-exports it); without it the app takes itself for a
// plain browser and registers no event listeners, so drops go nowhere.
window.isTauri = true;
window.__TAURI_INTERNALS__ = {
  transformCallback(cb, once) { const id = ++cbId; window.__cbs[id] = cb; return id; },
  unregisterCallback(id) { delete window.__cbs[id]; },
  convertFileSrc(p) { return p; },
  async invoke(cmd, args) {
    if (cmd.startsWith('plugin:')) {
      switch (cmd) {
        case 'plugin:event|listen': {
          const id = ++cbId;
          (window.__listeners[args.event] ||= []).push({ id, handler: args.handler });
          return id;
        }
        case 'plugin:event|unlisten': {
          const l = window.__listeners[args.event] || [];
          window.__listeners[args.event] = l.filter(x => x.id !== args.eventId);
          return null;
        }
        case 'plugin:dialog|save': return window.__dialog.save;
        case 'plugin:dialog|open': return window.__dialog.open;
        case 'plugin:dialog|confirm': window.__confirms = (window.__confirms || []).concat(args.message); return window.__dialog.confirm;
        case 'plugin:notification|notify': window.__notifications.push(args.options); return null;
        case 'plugin:notification|is_permission_granted': return true;
        case 'plugin:notification|request_permission': return 'granted';
        case 'plugin:app|version': return window.__appVersion;
        default: throw 'unmocked ' + cmd;
      }
    }
    if (window.__iap && cmd.startsWith('iap_')) return window.__iapInvoke(cmd, args ?? {});
    const r = await window.__bridgeInvoke(cmd, args ?? {}, window.__delays[cmd] || 0);
    if (r && r.__err !== undefined) throw r.__err;
    return r.__ok;
  },
};
window.Notification = function (title, options) { window.__TAURI_INTERNALS__.invoke('plugin:notification|notify', { options: Object.assign({}, options, { title }) }); };
window.Notification.permission = 'granted';
window.__emit = (event, payload) => {
  for (const l of (window.__listeners[event] || [])) {
    const cb = window.__cbs[l.handler];
    if (cb) cb({ event, id: l.id, payload });
  }
};
window.alert = (m) => { window.__alerts.push(String(m)); };
`;

async function assertDevServer() {
  try { await fetch(DEV_URL); }
  catch { throw new Error(`no dev server at ${DEV_URL} — run \`pnpm dev\` in frontend/ first`); }
}

let launches = 0;

/**
 * A browser and a bridge. `dataDir` is the bridge's store directory: by
 * default a fresh one per launch, so scenarios start with no workspace roots
 * and no recent files; pass the same one twice to act out a relaunch.
 * `pendingFiles` launches the app the way a double-click in Finder does:
 * the backend is holding those paths before the webview loads.
 * `viewport` / `deviceScaleFactor` are the window size and the pixel ratio —
 * the defaults are what the suite asserts against; `shots.mjs` raises them to
 * capture the App Store's @2x sizes.
 * `iap` puts a scripted App Store in front of the `iap_*` commands (start
 * from `FREE_STORE`); without it the bridge answers them and the app owns
 * the full version.
 * `locale` is the browser's, which is what the app starts in when no
 * language is saved (`systemLanguage` reads `navigator.language`): pinned
 * to English so the suite's selectors hold on a Japanese Mac. A saved
 * language in `localStorage` wins over it, as in the app.
 */
export async function launch({ browser = 'webkit', headless = true, localStorage: ls = {}, dataDir, pendingFiles = [], viewport = { width: 1280, height: 800 }, deviceScaleFactor = 1, iap = null, locale = 'en-US' } = {}) {
  await assertDevServer();
  if (!dataDir) {
    dataDir = path.join(OUT, 'data', `launch-${process.pid}-${++launches}`);
    rmSync(dataDir, { recursive: true, force: true });
  }
  mkdirSync(dataDir, { recursive: true });
  const bridge = new Bridge(dataDir, pendingFiles);
  const engine = browser === 'chromium' ? chromium : webkit;
  let b;
  try {
    b = await engine.launch({ headless });
    const ctx = await b.newContext({ viewport, deviceScaleFactor, locale });
    const page = await ctx.newPage();
    page.__errors = [];
    page.on('pageerror', (e) => page.__errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') page.__errors.push('console: ' + m.text()); });
    await page.exposeFunction('__bridgeInvoke', async (cmd, args, delayMs) => {
      try { return { __ok: await bridge.call(cmd, args, delayMs) }; }
      catch (e) { return { __err: e }; }
    });
    await page.addInitScript(INIT);
    await page.addInitScript(v => { window.__appVersion = v; }, APP_VERSION);
    await page.addInitScript((ls) => { for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); }, ls);
    if (iap) await page.addInitScript((store) => { window.__iap = store; }, iap);
    await page.goto(DEV_URL);
    await page.waitForSelector('text=/Parqsee|Drop/i', { timeout: 10000 }).catch(() => {});
    const close = async () => { try { await b.close(); } finally { bridge.close(); } };
    return { page, bridge, browser: b, dataDir, close };
  } catch (error) {
    try { await b?.close(); } finally { bridge.close(); }
    throw error;
  }
}

/** Deliver a file-drop the way lib.rs's drag-drop handler does. */
export async function dropFile(page, path) {
  await page.evaluate((p) => window.__emit('file-drop', [p]), path);
}

/**
 * Open files from Finder / the Dock / `open -a` while the window is up:
 * `deliver_opened` in lib.rs emits the same `file-drop` event once the
 * webview is listening (the cold start is `launch({ pendingFiles })`).
 */
export async function finderOpen(page, paths) {
  await page.evaluate((p) => window.__emit('file-drop', p), paths);
}

/**
 * The App Store as a free-tier launch sees it: the product with a price,
 * nothing owned, and a purchase that goes through. Spread and override —
 * `products: []` is the store that has no product (what an unsigned build
 * gets today), `productsError` / `purchaseError` / `restoreError` are the
 * rejections, `purchaseOutcome` is `purchased` / `cancelled` / `pending`,
 * `owned: true` makes Restore Purchases unlock. `status` is what
 * `iap_status` answers; `has_store: false` is a build without a store.
 */
export const FREE_STORE = Object.freeze({
  status: { state: 'free', store_error: null, has_store: true },
  products: [{ id: 'parqsee.full', display_name: 'Parqsee Full Version', description: 'Open as many tabs as you like.', display_price: '¥1,500' }],
  productsError: null,
  purchaseOutcome: 'purchased',
  purchaseError: null,
  restoreError: null,
  owned: false,
});

/** Change the scripted store mid-run (the next `iap_*` call sees it). */
export async function setStore(page, patch) {
  await page.evaluate((p) => { Object.assign(window.__iap, p); }, patch);
}

/**
 * Push a status the way the backend does after a transaction update from
 * the store — a purchase approved elsewhere, a refund — as the `iap-status`
 * event; the scripted store answers `iap_status` with it from then on.
 */
export async function pushIapStatus(page, status) {
  await page.evaluate((s) => { if (window.__iap) window.__iap.status = s; window.__emit('iap-status', s); }, status);
}

/**
 * Open `dir` as a workspace root through the Open Folder button (the folder
 * dialog is answered with `dir`), from the welcome screen or the workspace.
 */
export async function openFolder(page, dir) {
  await page.evaluate((p) => { window.__dialog.open = p; }, dir);
  const inWorkspace = page.locator('[title="Open Folder (⇧⌘O)"]').first();
  if (await inWorkspace.count()) await inWorkspace.click();
  else await page.locator('button:has-text("Open Folder")').first().click();
  await page.waitForFunction((d) => [...document.querySelectorAll('.py-1 [title]')].some(el => el.getAttribute('title') === d), dir, { timeout: 5000 });
}

/** Wait until the browse grid has settled (no spinner). */
export async function waitGrid(page, timeout = 15000) {
  await page.waitForFunction(() => !document.querySelector('.animate-spin'), null, { timeout });
  await page.waitForTimeout(50);
}

export async function gridRows(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('tbody tr')].filter(tr => !tr.hasAttribute('aria-hidden'));
    return rows.map(tr => [...tr.querySelectorAll('td')].filter(td => !td.hasAttribute('aria-hidden')).map(td => td.textContent));
  });
}

export async function headerCols(page) {
  return page.evaluate(() => [...document.querySelectorAll('thead th')].filter(th => !th.hasAttribute('aria-hidden')).map(th => th.querySelector('div')?.textContent ?? th.textContent));
}

export async function text(page, selector) {
  return page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector);
}

/**
 * What the screenshot scripts read from the environment: `SIZE=WxH` (the
 * viewport), `SCALE` (the device scale factor; `scale` is the script's own
 * default), `LANGS` and `THEMES` (comma-separated, every combination is
 * photographed).
 */
export function shotConfig({ scale = 1 } = {}) {
  const [W, H] = (process.env.SIZE ?? '1280x800').split('x').map(Number);
  return {
    W, H,
    SCALE: Number(process.env.SCALE ?? scale),
    LANGS: (process.env.LANGS ?? 'en,ja').split(','),
    THEMES: (process.env.THEMES ?? 'light,dark').split(','),
  };
}

/** The settings a screenshot run starts the app with, as `launch`'s `localStorage`. */
export const shotSettings = (lang, theme) => ({ 'parqsee-settings': JSON.stringify({ theme, language: lang, rowsPerPage: 50 }) });

/** A screenshot taker for one run: `<lang>-<theme>-<scene>-<pixel size>.png` into `dir`, each name logged. */
export function shooter(dir, { W, H, SCALE }, lang, theme) {
  return async (page, scene) => {
    const name = `${lang}-${theme}-${scene}-${W * SCALE}x${H * SCALE}.png`;
    await page.screenshot({ path: path.join(dir, name) });
    console.log('  ' + name);
  };
}

/** Photograph every language × theme into `dir` with `run(lang, theme)`, over the demo data. */
export async function shootAll(dir, { LANGS, THEMES }, run) {
  writeDemoData();
  mkdirSync(dir, { recursive: true });
  for (const lang of LANGS) for (const theme of THEMES) await run(lang, theme);
  console.log(`\n${dir}`);
}

export const results = [];
export function report(id, status, note) {
  results.push({ id, status, note });
  console.log(`[${status}] ${id} ${note ?? ''}`);
}
export async function check(id, cond, note) {
  report(id, cond ? 'PASS' : 'FAIL', note);
}
