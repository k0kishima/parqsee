import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as pollDelay } from 'node:timers/promises';
import { FIX, OUT, dropFile, check, FREE_STORE, setStore, pushIapStatus, activePanel } from './lib.mjs';
import { scenario, screenshot } from './runner.mjs';

const active = activePanel;
const tabs = page => page.locator('[title^="Close tab"]');
const footer = page => active(page).getByText(/^Showing .* entries$/);
const firstCell = page => active(page).locator('tbody tr:not([aria-hidden]) td:not([aria-hidden])').first();
async function open(page, file) {
  await dropFile(page, file);
  await active(page).getByRole('heading', { name: path.basename(file), exact: true }).waitFor();
  await footer(page).waitFor();
}
async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await pollDelay(20);
  }
}
async function apply(page, column, value) {
  const form = active(page).locator('form').first();
  await form.locator('select').first().selectOption(column);
  await form.locator('input[type=text]').fill(value);
  await form.locator('button[type=submit]').click();
}

export async function exploratoryScenarios() {
  await scenario('S15-close-during-read', async ({ page, bridge }) => {
    const file = `${FIX}/multi_rowgroup.parquet`;
    await open(page, file);
    // Hold a real filtered read result until eviction and a new tab have completed.
    const call = bridge.call.bind(bridge);
    let release, held = false;
    const gate = new Promise(resolve => { release = resolve; });
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
        const value = await invoke(cmd, args);
        if (cmd === 'read_parquet_data' && args.filter) window.__exploratoryReadDelivered = true;
        return value;
      };
    });
    bridge.call = async (cmd, args, delay) => {
      const value = await call(cmd, args, delay);
      if (cmd === 'read_parquet_data' && args.filter && !held) {
        held = true;
        await gate;
      }
      return value;
    };
    try {
      await apply(page, 'grp', '3');
      await until(() => held, 'real filtered read completed');
      await tabs(page).first().click();
      await page.getByText('Drop your Parquet file here').waitFor();
      await until(() => bridge.log.some(l => l.cmd === 'evict_cache') && bridge.pending.size === 0, 'eviction complete');
      await open(page, `${FIX}/one_row.parquet`);
      release();
      await page.waitForFunction(() => window.__exploratoryReadDelivered === true);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check('S15.otherTab', await active(page).getByRole('heading', { name: 'one_row.parquet', exact: true }).isVisible() && (await footer(page).textContent()).includes('of 1 '), 'Late result leaves the other tab intact');
      await open(page, file);
      await footer(page).filter({ hasText: 'of 100,000' }).waitFor();
      check('S15.reopen', await firstCell(page).textContent() === '0' && await tabs(page).count() === 2 && await active(page).locator('.animate-spin').count() === 0, 'Reopened tab starts at id 0 with no filter or spinner');
      await active(page).getByRole('button', { name: 'Next', exact: true }).click();
      await footer(page).filter({ hasText: 'Showing 51 to 100' }).waitFor();
      check('S15.continue', await firstCell(page).textContent() === '50', 'Pagination remains usable after the stale read');
    } finally { release(); }
  });

  await scenario('S16-export-retry', async ({ page, dataDir }) => {
    await open(page, `${FIX}/multi_rowgroup.parquet`);
    await apply(page, 'id', '5');
    await footer(page).filter({ hasText: 'of 1 entries' }).waitFor();
    await active(page).getByRole('button', { name: 'Export', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.locator('input[value=json]').check();
    // A regular file as the parent gives deterministic ENOTDIR, even as root.
    const blocker = path.join(dataDir, 'not-a-directory');
    fs.writeFileSync(blocker, 'keep-existing-bytes');
    await page.evaluate(p => { window.__dialog.save = p; }, `${blocker}/out.json`);
    await modal.getByRole('button', { name: 'Export', exact: true }).click();
    await modal.getByRole('alert').waitFor();
    check('S16.failure', fs.readFileSync(blocker, 'utf8') === 'keep-existing-bytes' && await modal.getByRole('button', { name: 'Export', exact: true }).isEnabled(), await modal.getByRole('alert').textContent());
    const output = path.join(dataDir, 'retry.json');
    await page.evaluate(p => { window.__dialog.save = p; }, output);
    await modal.getByRole('button', { name: 'Export', exact: true }).click();
    await modal.getByText('Export Complete', { exact: true }).waitFor();
    const rows = JSON.parse(fs.readFileSync(output, 'utf8'));
    check('S16.retry', rows.length === 1 && String(rows[0].id) === await firstCell(page).textContent() && rows[0].name === 'row-5', JSON.stringify(rows));
    await modal.locator('button.btn-primary').filter({ hasText: /^Close$/ }).click();
    check('S16.recovered', await footer(page).isVisible() && await active(page).getByRole('button', { name: 'Export', exact: true }).isEnabled(), 'Successful retry closes modal and preserves filtered grid');
  });

  const sessionDir = path.join(OUT, 'data', `s17-${process.pid}`);
  await scenario('S17-flush-session', async ({ page, bridge, dataDir }) => {
    const file = `${FIX}/multi_rowgroup.parquet`;
    await open(page, file);
    await open(page, `${FIX}/one_row.parquet`);
    await page.locator(`span[title="${file}"]`).click();
    await active(page).getByRole('heading', { name: 'multi_rowgroup.parquet', exact: true }).waitFor();
    await active(page).getByRole('button', { name: 'Next', exact: true }).click();
    await footer(page).filter({ hasText: 'Showing 51 to 100' }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await until(() => {
      const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'bookmarks.json'), 'utf8'));
      return store.session?.tabs[0]?.state.current_page === 2 && store.session.active === file;
    }, 'page 2 written to real store');
    const saved = await bridge.call('list_session_tabs');
    check('S17.disk', saved.tabs.map(t => path.basename(t.path)).join() === 'multi_rowgroup.parquet,one_row.parquet' && saved.tabs[0].state.current_page === 2, JSON.stringify(saved));
  }, { dataDir: sessionDir });
  await scenario('S17-relaunch', async ({ page }) => {
    await footer(page).filter({ hasText: 'Showing 51 to 100' }).waitFor();
    check('S17.restore', await tabs(page).count() === 2 && await firstCell(page).textContent() === '50', 'Fresh browser and Rust process restore persisted page, order and selection');
  }, { dataDir: sessionDir });

  await scenario('S18-store-recovery', async ({ page }) => {
    for (const name of ['one_row', 'dict', 'numeric']) await open(page, `${FIX}/${name}.parquet`);
    await dropFile(page, `${FIX}/nan.parquet`);
    const prompt = page.getByTestId('upgrade-prompt');
    await prompt.waitFor();
    const buy = prompt.locator('button.btn-primary');
    const restore = prompt.locator('button.btn-secondary');
    await setStore(page, { purchaseError: 'exploration purchase failure' });
    await buy.click();
    await prompt.getByRole('alert').filter({ hasText: 'exploration purchase failure' }).waitFor();
    check('S18.failed', await buy.isEnabled() && await restore.isEnabled() && await tabs(page).count() === 3, 'Purchase failure releases both controls and preserves three tabs');
    await setStore(page, { purchaseError: null, purchaseOutcome: 'pending' });
    await buy.click();
    await prompt.getByRole('status').filter({ hasText: /pending|approval/i }).waitFor();
    check('S18.pending', await buy.isEnabled() && await page.getByTestId('free-badge').isVisible(), 'Pending purchase remains free and permits retry');
    await pushIapStatus(page, { state: 'unlocked', store_error: null, has_store: true });
    await prompt.waitFor({ state: 'detached' });
    await open(page, `${FIX}/nan.parquet`);
    await pushIapStatus(page, { state: 'free', store_error: null, has_store: true });
    await page.getByTestId('free-badge').waitFor();
    await dropFile(page, `${FIX}/big_ints.parquet`);
    await prompt.waitFor();
    await setStore(page, { restoreError: 'exploration restore failure' });
    await restore.click();
    await prompt.getByRole('alert').filter({ hasText: 'exploration restore failure' }).waitFor();
    check('S18.refund', await tabs(page).count() === 4 && await restore.isEnabled(), 'Refund retains existing four tabs, refuses fifth; failed restore can retry');
    await setStore(page, { restoreError: null, owned: true });
    await restore.click();
    await prompt.waitFor({ state: 'detached' });
    await open(page, `${FIX}/big_ints.parquet`);
    check('S18.restored', await tabs(page).count() === 5 && await page.getByTestId('free-badge').count() === 0, 'Restore retry unlocks fifth tab');
    await screenshot(page, { path: `${OUT}/shots/S18-recovered.png` });
  }, { iap: { ...FREE_STORE } });
}
