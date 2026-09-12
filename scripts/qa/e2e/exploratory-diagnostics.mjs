// Opt-in reproducer, deliberately outside the regression suite/CI.
// OBSERVE describes a defect, never a passing product requirement.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as pollDelay } from 'node:timers/promises';
import { FIX, OUT, dropFile, report } from './lib.mjs';
import { scenario, expectConsoleError, screenshot, finishSuite } from './runner.mjs';

await scenario('EX-01-session-save-failure', async ({ page, bridge, dataDir }) => {
  const active = page.locator('div[style*="position: absolute"][style*="display: flex"]');
  const storePath = path.join(dataDir, 'bookmarks.json');
  await dropFile(page, `${FIX}/multi_rowgroup.parquet`);
  await active.getByText('Showing 1 to 50 of 100,000 entries', { exact: true }).waitFor();
  const waitFor = async (predicate) => {
    const end = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > end) throw new Error('Diagnostic condition timed out');
      await pollDelay(20);
    }
  };
  const diskPage = () => JSON.parse(fs.readFileSync(storePath, 'utf8')).session?.tabs[0]?.state.current_page;
  await waitFor(() => diskPage() === 1);
  const call = bridge.call.bind(bridge);
  let attempts = 0;
  bridge.call = async (cmd, args, delay) => {
    if (cmd === 'save_session') {
      attempts++;
      if (attempts === 1) throw 'exploration save failure';
    }
    return call(cmd, args, delay);
  };
  await active.getByRole('button', { name: 'Next', exact: true }).click();
  await active.getByText('Showing 51 to 100 of 100,000 entries', { exact: true }).waitFor();
  await waitFor(() => page.__errors.includes('console: Failed to save the session: exploration save failure'));
  expectConsoleError(page, 'Failed to save the session: exploration save failure');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  // A subsequent real bridge roundtrip provides a boundary after pagehide.
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('list_session_tabs'));
  if (attempts !== 1 || diskPage() !== 1) throw new Error('EX-01 no longer reproduces; reassess diagnostic');
  report('EX-01', 'OBSERVE', JSON.stringify({ uiPage: 2, diskPage: diskPage(), attemptsAfterPagehide: attempts, injected: 'first save_session rejected before backend; following calls allowed' }));
  await screenshot(page, { path: `${OUT}/shots/EX-01-save-failure.png` });
  // A different snapshot recovers, limiting the diagnosis to the lost retry.
  await active.getByRole('button', { name: 'Next', exact: true }).click();
  await active.getByText('Showing 101 to 150 of 100,000 entries', { exact: true }).waitFor();
  await waitFor(() => diskPage() === 3);
  report('EX-01-recovery', 'OBSERVE', `Changing state again writes page 3; attempts=${attempts}`);
});
finishSuite();
