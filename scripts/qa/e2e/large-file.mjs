// Large-file timing: open the gen_huge.py file, jump to the last page, and
// then open the column profile beside the grid — the panel is one to three
// scans of the column it charts, so a file this size is where its cost shows.
// Reports the page read, the render, and per column the time from the click to
// bars (or to the error the backend answered with), a page move made while a
// profile is still running, and what clicking along the header costs. Use
// BRIDGE_BIN with a release build for representative numbers.
import { launch, dropFile, waitGrid, gridRows, ACTIVE_PANEL, FIX, OUT } from './lib.mjs';
const HUGE = process.env.HUGE ?? `${FIX}/huge.parquet`;
const PROFILE_COLUMNS = (process.env.PROFILE_COLUMNS ?? 'category,id,token,ts').split(',').filter(Boolean);
const { page, bridge, close } = await launch();
const t0 = Date.now();
const origCall = bridge.call.bind(bridge);
bridge.call = (cmd, args, d) => {
  const t = Date.now() - t0;
  const p = origCall(cmd, args, d);
  p.then(r => console.log(`  <- ${cmd} ok after ${Date.now() - t0 - t} ms (${Array.isArray(r) ? r.length + ' rows' : typeof r === 'object' ? 'obj' : r})`), e => console.log(`  <- ${cmd} ERR ${String(e).slice(0, 150)}`));
  console.log(`  -> +${t}ms ${cmd} ${JSON.stringify(args).slice(0, 120)}`);
  return p;
};
await dropFile(page, HUGE);
await page.waitForSelector('h1', { timeout: 20000 });
await waitGrid(page, 30000);
const active = ACTIVE_PANEL;
console.log('opened in', Date.now() - t0, 'ms; footer:', (await page.locator(`${active} footer, ${active} [class*="border-t"]`).last().textContent().catch(() => ''))?.slice(0, 120));
const lastBtn = page.locator(`${active} button:has(path[d="M13 5l7 7-7 7M5 5l7 7-7 7"])`);
console.log('last-page button count:', await lastBtn.count(), 'disabled:', await lastBtn.first().isDisabled());
const tClick = Date.now();
await lastBtn.first().click();
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(500);
  const spinner = await page.evaluate(() => !!document.querySelector('.animate-spin'));
  const loadingText = await page.evaluate(() => document.body.innerText.includes('Loading data'));
  if (!spinner && !loadingText) {
    const rows = await gridRows(page);
    console.log(`settled after ${Date.now() - tClick} ms: ${rows.length} rows, first id=${rows[0]?.[0]}`);
    console.log('pager text:', (await page.evaluate(() => [...document.querySelectorAll('input[type="text"], input[type="number"]')].map(i => i.value))).join(','));
    break;
  }
  if (i % 10 === 9) console.log(`still loading after ${Date.now() - tClick} ms (spinner=${spinner})`);
}
await page.screenshot({ path: `${OUT}/shots/huge_lastpage.png` });

// ---------------------------------------------------------------- the profile
const PANEL = `${active} aside[aria-label^="Profile of "]`;
const profileButton = (column) => page.locator(`${active} thead th button[aria-label="Profile column ${column}"]`);
// The dev server runs React in development, where StrictMode mounts an
// effect twice: every panel opened here asks the backend twice, and a
// production build asks once. Counting per column is what makes that visible.
const profileCalls = () => bridge.log.filter(l => l.cmd === 'profile_column_counts').map(l => l.args.column);
const countPerColumn = (calls) => [...calls.reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map())].map(([c, n]) => `${c}x${n}`).join(' ');
// The counts are the first of the panel's two scans: it shows them without
// waiting for the chart, so they are timed separately.
const counted = (timeout = 180000) => page.waitForFunction(
  sel => {
    const panel = document.querySelector(sel);
    return !!panel && (!!panel.querySelector('dd') || !!panel.querySelector('p[role="alert"]'));
  },
  PANEL, { timeout, polling: 50 }
);
// Settled means the panel has everything to show: its bars, or the message a
// refused profile leaves behind.
const settle = (timeout = 180000) => page.waitForFunction(
  sel => {
    const panel = document.querySelector(sel);
    return !!panel && (!!panel.querySelector('ul button') || !!panel.querySelector('p[role="alert"]'));
  },
  PANEL, { timeout, polling: 50 }
);
const panelState = () => page.evaluate(sel => {
  const panel = document.querySelector(sel);
  if (!panel) return { open: false };
  const alert = panel.querySelector('p[role="alert"]');
  return {
    open: true,
    of: panel.getAttribute('aria-label'),
    error: alert?.textContent ?? null,
    stats: [...panel.querySelectorAll('dd')].map(d => d.textContent),
    bars: [...panel.querySelectorAll('ul button')].slice(0, 3).map(b => b.getAttribute('aria-label')),
  };
}, PANEL);

for (const column of PROFILE_COLUMNS) {
  const button = profileButton(column);
  if (!(await button.count())) {
    console.log(`profile ${column}: no header button (the column is not rendered)`);
    continue;
  }
  const tProfile = Date.now();
  await button.click();
  let countsMs = null;
  try {
    await counted();
    countsMs = Date.now() - tProfile;
    await settle();
  } catch {
    console.log(`profile ${column}: nothing after ${Date.now() - tProfile} ms (counts at ${countsMs ?? 'never'})`);
    await button.click();
    continue;
  }
  const state = await panelState();
  const took = Date.now() - tProfile;
  console.log(`profile ${column}: counts ${countsMs} ms, chart ${took} ms (${countPerColumn(profileCalls().slice(-4))}) — ${state.error ? `ERROR ${state.error.slice(0, 140)}` : `${state.stats.join(' / ')} — ${state.bars.join(' | ')}`}`);
  await page.screenshot({ path: `${OUT}/shots/huge_profile_${column}.png` });
  await button.click();
}

// A page move made while a profile is still running: the grid's own request
// is what the user is waiting for, and the profile is still scanning behind it.
const busy = PROFILE_COLUMNS[PROFILE_COLUMNS.length - 1];
const nextButton = page.locator(`${active} button`, { hasText: /^Next$/ });
await page.locator(`${active} button:has(path[d="M11 19l-7-7 7-7m8 14l-7-7 7-7"])`).first().click();
await waitGrid(page, 30000);
const before = await gridRows(page);
const tBusy = Date.now();
await profileButton(busy).click();
await nextButton.first().click();
await page.waitForFunction(
  ([sel, first]) => {
    const rows = document.querySelectorAll(`${sel} tbody tr`);
    return rows.length > 0 && rows[0].textContent !== first;
  },
  [active, before[0]?.join('')], { timeout: 60000, polling: 50 }
).catch(() => {});
console.log(`page move while ${busy} was being profiled: ${Date.now() - tBusy} ms`);
await settle().catch(() => {});
console.log(`  its profile settled after ${Date.now() - tBusy} ms in total`);
await profileButton(busy).click();

// Clicking along the header: one profile per column, none of them cancelled.
const tPile = Date.now();
const callsBefore = profileCalls().length;
for (const column of PROFILE_COLUMNS) {
  const button = profileButton(column);
  if (await button.count()) {
    await button.click();
    await page.waitForTimeout(150);
  }
}
await settle().catch(() => {});
const last = await panelState();
console.log(
  `clicking along ${PROFILE_COLUMNS.length} columns: ${last.of} showed after ${Date.now() - tPile} ms, `
  + `${countPerColumn(profileCalls().slice(callsBefore))}, ${last.error ? `ERROR ${last.error.slice(0, 120)}` : last.bars.join(' | ')}`
);
await page.screenshot({ path: `${OUT}/shots/huge_profile_pileup.png` });

console.log('errors:', page.__errors);
await close();
