// Playwright WebKit harness that drives the Parqsee frontend (Vite dev
// server) against the real Rust backend through backend/examples/bridge.rs.
//
// The page gets a fake `__TAURI_INTERNALS__` whose `invoke` forwards every
// app command to the bridge process and answers the plugin commands the UI
// uses (event, dialog, notification) in-process. See README.md.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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

for (const dir of [OUT, path.join(OUT, 'shots')]) mkdirSync(dir, { recursive: true });

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
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event, id) { const l = window.__listeners[event] || []; window.__listeners[event] = l.filter(x => x.id !== id); } };
let cbId = 0;
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
        default: throw 'unmocked ' + cmd;
      }
    }
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
 */
export async function launch({ browser = 'webkit', headless = true, localStorage: ls = {}, dataDir, pendingFiles = [], viewport = { width: 1280, height: 800 }, deviceScaleFactor = 1 } = {}) {
  await assertDevServer();
  if (!dataDir) {
    dataDir = path.join(OUT, 'data', `launch-${process.pid}-${++launches}`);
    rmSync(dataDir, { recursive: true, force: true });
  }
  mkdirSync(dataDir, { recursive: true });
  const bridge = new Bridge(dataDir, pendingFiles);
  const engine = browser === 'chromium' ? chromium : webkit;
  const b = await engine.launch({ headless });
  const ctx = await b.newContext({ viewport, deviceScaleFactor });
  const page = await ctx.newPage();
  page.__errors = [];
  page.on('pageerror', (e) => page.__errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') page.__errors.push('console: ' + m.text()); });
  await page.exposeFunction('__bridgeInvoke', async (cmd, args, delayMs) => {
    try { return { __ok: await bridge.call(cmd, args, delayMs) }; }
    catch (e) { return { __err: e }; }
  });
  await page.addInitScript(INIT);
  await page.addInitScript((ls) => { for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); }, ls);
  await page.goto(DEV_URL);
  await page.waitForSelector('text=/Parqsee|Drop/i', { timeout: 10000 }).catch(() => {});
  const close = async () => { await b.close(); bridge.close(); };
  return { page, bridge, browser: b, dataDir, close };
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
 * Open `dir` as a workspace root through the Open Folder button (the folder
 * dialog is answered with `dir`), from the welcome screen or the workspace.
 */
export async function openFolder(page, dir) {
  await page.evaluate((p) => { window.__dialog.open = p; }, dir);
  const inWorkspace = page.locator('[title="Open Folder (⌘⇧O)"]').first();
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

export const results = [];
export function report(id, status, note) {
  results.push({ id, status, note });
  console.log(`[${status}] ${id} ${note ?? ''}`);
}
export async function check(id, cond, note) {
  report(id, cond ? 'PASS' : 'FAIL', note);
}
