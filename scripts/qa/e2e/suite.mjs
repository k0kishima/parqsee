import fs from 'node:fs';
import path from 'node:path';
// Regression suite: every scenario drives the UI against the real backend.
// Run with `pnpm suite` (see README.md); ONLY=S3 runs one scenario prefix.
import { launch, dropFile, finderOpen, openFolder, waitGrid, gridRows, headerCols, text, report, check, results, FIX, OUT, ROOT } from './lib.mjs';

const base = (p) => p.split('/').pop();

async function openFile(page, path, { expectTab = true } = {}) {
  await dropFile(page, path);
  if (!expectTab) { await page.waitForTimeout(300); return; }
  await page.waitForFunction((n) => [...document.querySelectorAll('h1')].some(h => h.textContent === n && h.offsetParent !== null), base(path), { timeout: 15000 });
  await waitGrid(page);
}
const act = (page) => page.locator('div[style*="position: absolute"][style*="display: flex"]');
const footer = (page) => act(page).locator('text=/Showing .* entries/').first().textContent().catch(() => null);
const summary = (page) => act(page).locator('text=/^[\\d,]+ rows × \\d+ columns$/').first().textContent().catch(() => null);
const dataError = (page) => act(page).locator('text=The condition could not be run').isVisible().catch(() => false);
const activeTabName = (page) => act(page).locator('h1').first().textContent().catch(() => null);
const tabNames = (page) => page.evaluate(() => [...document.querySelectorAll('[title="Close tab"]')].map(b => b.parentElement?.querySelector('span')?.textContent));
const visibleGrid = async (page) => page.evaluate(() => {
  const tables = [...document.querySelectorAll('table')].filter(t => t.offsetParent !== null);
  const tb = tables[0]?.querySelector('tbody');
  if (!tb) return [];
  return [...tb.querySelectorAll('tr')].filter(tr => !tr.hasAttribute('aria-hidden')).map(tr => [...tr.querySelectorAll('td')].filter(td => !td.hasAttribute('aria-hidden')).map(td => td.textContent));
});
const visibleHeader = async (page) => page.evaluate(() => {
  const tables = [...document.querySelectorAll('table')].filter(t => t.offsetParent !== null);
  return [...(tables[0]?.querySelectorAll('thead th') ?? [])].filter(th => !th.hasAttribute('aria-hidden')).map(th => th.querySelector('div')?.firstChild?.textContent ?? th.textContent);
});

async function scenario(name, fn, opts) {
  if (process.env.ONLY && !name.startsWith(process.env.ONLY)) return;
  console.log(`\n### ${name}`);
  const h = await launch(opts);
  try { await fn(h); }
  catch (e) { report(`${name}/exception`, 'ERROR', String(e).slice(0, 300)); await h.page.screenshot({ path: `${OUT}/shots/${name}-error.png` }).catch(() => {}); }
  finally {
    if (h.page.__errors.length) report(`${name}/page-errors`, 'OBSERVE', JSON.stringify(h.page.__errors.slice(0, 3)).slice(0, 500));
    await h.close();
  }
}

// ---------------------------------------------------------------- S1 data fidelity
await scenario('S1-fidelity', async ({ page }) => {
  await page.setViewportSize({ width: 2600, height: 900 });
  await openFile(page, `${FIX}/paths/UPPER.PARQUET`);
  check('S1.upper', (await summary(page))?.startsWith('3 rows') && (await visibleGrid(page)).length === 3, `summary=${await summary(page)} rows=${(await visibleGrid(page)).length} footer=${await footer(page)}`);

  await openFile(page, `${FIX}/paths/glob[1].parquet`);
  check('S1.glob', (await visibleGrid(page)).length === 3, `rows=${(await visibleGrid(page)).length} dataError=${await dataError(page)}`);

  await openFile(page, `${FIX}/nan.parquet`);
  const nan = await visibleGrid(page);
  check('S1.nan', nan[0][1] !== 'NULL' && nan[1][1] !== 'NULL', `x column renders as ${JSON.stringify(nan.map(r => r[1]))}`);

  await openFile(page, `${FIX}/big_ints.parquet`);
  const bi = await visibleGrid(page);
  check('S1.bigints', bi[0][0] === '9007199254740993' && bi[0][1] === '18446744073709551615', JSON.stringify(bi[0]));

  await openFile(page, `${FIX}/numeric.parquet`);
  const nm = await visibleGrid(page);
  const cols = await visibleHeader(page);
  const at = (r, c) => nm[r][cols.indexOf(c)];
  check('S1.numeric', at(0, 'd128') === '12345.67' && at(1, 'u64') === '18446744073709551615' && at(0, 'd256') === '1111111111111111111111111111111111111111.5', `d128=${at(0, 'd128')} u64=${at(1, 'u64')} f64=${at(0, 'f64')} f32row1=${at(1, 'f32')} i64min=${at(0, 'i64')}`);
  report('S1.numeric.types', 'OBSERVE', `header type labels: ${await page.evaluate(() => [...document.querySelectorAll('table:not([hidden]) thead th')].filter(th => th.offsetParent).map(th => th.querySelectorAll('div')[1]?.textContent).join(', '))}`);

  await openFile(page, `${FIX}/temporal.parquet`);
  const tp = await visibleGrid(page); const tc = await visibleHeader(page);
  const tat = (r, c) => tp[r][tc.indexOf(c)];
  report('S1.temporal', 'OBSERVE', `d32=${tat(0, 'd32')} d64=${tat(0, 'd64')} t32ms=${tat(0, 't32ms')} ts_us=${tat(0, 'ts_us')} ts_utc=${tat(0, 'ts_utc')} ts_tokyo=${tat(0, 'ts_tokyo')} dur=${tat(0, 'dur')} types=${await page.evaluate(() => [...document.querySelectorAll('table thead th')].filter(th => th.offsetParent).map(th => th.querySelectorAll('div')[1]?.textContent).join(','))}`);
  check('S1.temporal.date64', !tat(0, 'd64').includes('T00:00:00'), `Date64 renders as ${tat(0, 'd64')}`);

  await openFile(page, `${FIX}/text_binary.parquet`);
  const tb = await visibleGrid(page); const tbc = await visibleHeader(page);
  const bat = (r, c) => tb[r][tbc.indexOf(c)];
  report('S1.text', 'OBSERVE', `empty string row -> ${JSON.stringify(bat(2, 's'))}, null row -> ${JSON.stringify(bat(3, 's'))}, newline row -> ${JSON.stringify(bat(4, 's'))}, bin=${bat(0, 'bin')}, uuid=${bat(0, 'uuid')}`);
  check('S1.text.emptyVsNull', bat(2, 's') !== bat(3, 's'), `empty string and NULL distinguishable: "${bat(2, 's')}" vs "${bat(3, 's')}"`);

  await openFile(page, `${FIX}/nested.parquet`);
  const ns = await visibleGrid(page); const nc = await visibleHeader(page);
  report('S1.nested', 'OBSERVE', `li=${ns[0][nc.indexOf('li')]} st=${ns[0][nc.indexOf('st')]} mp=${ns[0][nc.indexOf('mp')]} deep=${ns[0][nc.indexOf('deep')]} st_big=${ns[0][nc.indexOf('st_big')]} st_dec=${ns[0][nc.indexOf('st_dec')]} emptyList=${ns[1][nc.indexOf('li')]} nullList=${ns[2][nc.indexOf('li')]}`);

  await openFile(page, `${FIX}/dup_names.parquet`, { expectTab: false });
  { const al = await page.evaluate(() => window.__alerts.splice(0)); check('S1.dup', al[0]?.includes('more than one column'), `dup column names refused: ${JSON.stringify(al)}`); }

  await openFile(page, `${FIX}/all_null.parquet`);
  const an = await visibleGrid(page);
  report('S1.allnull', 'OBSERVE', `row0=${JSON.stringify(an[0])} types=${await page.evaluate(() => [...document.querySelectorAll('table thead th')].filter(th => th.offsetParent).map(th => th.querySelectorAll('div')[1]?.textContent).join(','))}`);

  await openFile(page, `${FIX}/empty_rows.parquet`);
  report('S1.empty', 'OBSERVE', `summary=${await summary(page)} footer=${await footer(page)} pageOf=${await page.locator('text=/^of \\d+$/').first().textContent().catch(() => '?')}`);
  await act(page).locator('button:has-text("Export")').first().click();
  const exportDisabled = await act(page).locator('.fixed button:has-text("Export")').isDisabled();
  check('S1.empty.export', exportDisabled, `export disabled on empty file: ${exportDisabled}; message: ${await act(page).locator('text=No rows match').isVisible()}`);
  await act(page).locator('.fixed button:has-text("Cancel")').click();

  await openFile(page, `${FIX}/long_text.parquet`);
  const lt = await visibleGrid(page);
  report('S1.longtext', 'OBSERVE', `200KB cell rendered length=${lt[0][1]?.length} title attr set=${await page.evaluate(() => !!document.querySelector('table:not([hidden]) tbody td[title]'))}`);

  for (const f of ['corrupt.parquet', 'notparquet.parquet', 'empty_file.parquet', 'truncated.parquet']) {
    const before = await page.evaluate(() => document.querySelectorAll('[title="Close tab"]').length);
    await openFile(page, `${FIX}/${f}`, { expectTab: false });
    const after = await page.evaluate(() => document.querySelectorAll('[title="Close tab"]').length);
    const alerts = await page.evaluate(() => window.__alerts.splice(0));
    check(`S1.broken.${f}`, after === before && alerts.length === 1, `alerts=${JSON.stringify(alerts).slice(0, 200)}`);
  }

  // Valid footer, corrupted data pages: the file is unreadable as a whole, so
  // the tab shows the file-level error, not "100,000 rows" over an empty grid.
  await openFile(page, `${FIX}/bad_page.parquet`, { expectTab: false });
  const badPageError = await page.locator('text=Error Loading File').waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false);
  check('S1.badpage', badPageError && !(await dataError(page)), `errorScreen=${badPageError} dataError=${await dataError(page)}`);
  await act(page).locator('button:has-text("Close")').first().click();

  await openFile(page, `${FIX}/wide.parquet`);
  const hc1 = await visibleHeader(page);
  await page.evaluate(() => { const s = [...document.querySelectorAll('.overflow-auto')].find(e => e.offsetParent && e.querySelector('table')); s.scrollLeft = 50000; });
  await page.waitForTimeout(300);
  const hc2 = await visibleHeader(page);
  check('S1.wide.virtual', hc1[0] === 'col_000' && hc2.includes('col_599'), `first=${hc1.slice(0, 2)} after scroll=${hc2.slice(-2)} rendered=${hc2.length}`);
  await page.screenshot({ path: `${OUT}/shots/S1-wide.png` });
});

// ---------------------------------------------------------------- S2 pagination
await scenario('S2-pagination', async ({ page }) => {
  const mr = `${FIX}/multi_rowgroup.parquet`;
  await openFile(page, mr);
  const ids = async () => (await visibleGrid(page)).map(r => r[0]);
  check('S2.first', (await footer(page)) === 'Showing 1 to 50 of 100,000 entries' && (await ids())[0] === '0', await footer(page));
  check('S2.prevDisabled', await act(page).locator('button:has-text("Previous")').isDisabled());
  await act(page).locator('button:has-text("Next")').click(); await waitGrid(page);
  check('S2.next', (await ids())[0] === '50' && (await ids()).length === 50, `first id ${(await ids())[0]}`);
  const pageInput = act(page).locator('input[inputmode="numeric"]');
  await pageInput.fill('1500'); await pageInput.press('Enter'); await waitGrid(page);
  check('S2.jump', (await ids())[0] === '74950', `first id ${(await ids())[0]} footer=${await footer(page)}`);
  await pageInput.fill('abc'); await pageInput.press('Enter'); await waitGrid(page);
  check('S2.badInput', await pageInput.inputValue() === '1500', `input reverted to ${await pageInput.inputValue()}`);
  await pageInput.fill('0'); await pageInput.press('Enter'); await waitGrid(page);
  check('S2.zeroInput', await pageInput.inputValue() === '1500', `input now ${await pageInput.inputValue()}`);
  await pageInput.fill('99999'); await pageInput.press('Enter'); await waitGrid(page);
  check('S2.tooBig', await pageInput.inputValue() === '1500', `input now ${await pageInput.inputValue()}`);
  await pageInput.fill(' 7 '); await pageInput.press('Enter'); await waitGrid(page);
  report('S2.spaceInput', 'OBSERVE', `' 7 ' -> page ${await pageInput.inputValue()}, first id ${(await ids())[0]}`);
  // last page
  const lastBtn = page.locator('button:has-text("Next") + button');
  await lastBtn.click(); await waitGrid(page);
  check('S2.last', (await ids())[0] === '99950' && await act(page).locator('button:has-text("Next")').isDisabled(), `first id ${(await ids())[0]} footer=${await footer(page)}`);
  // rows per page
  const rpp = act(page).locator('select').filter({ hasText: '500' }).first();
  await rpp.selectOption('25'); await waitGrid(page);
  check('S2.rpp25', (await ids()).length === 25 && (await ids())[0] === '0' && await pageInput.inputValue() === '1', `rows=${(await ids()).length} ids=${(await ids()).slice(0, 3)} page=${await pageInput.inputValue()} footer=${await footer(page)}`);
  await rpp.selectOption('500'); await waitGrid(page);
  check('S2.rpp500', (await ids()).length === 500, `rows=${(await ids()).length}`);
  await rpp.selectOption('50'); await waitGrid(page);

  // Race: slow filtered load, then immediate clear.
  await page.evaluate(() => { window.__delays['count_parquet_data'] = 1200; });
  const form = act(page).locator('form').first();
  await form.locator('select').nth(0).selectOption('grp');
  await form.locator('input[type=text]').fill('3');
  await form.locator('button[type=submit]').click();
  await page.waitForTimeout(100);
  await page.evaluate(() => { window.__delays['count_parquet_data'] = 0; });
  await act(page).locator('button[title="Clear"]').click();
  await page.waitForTimeout(2500); await waitGrid(page);
  const raceIds = await ids();
  const filterInputVal = await form.locator('input[type=text]').inputValue();
  check('S2.race.filterThenClear', raceIds[0] === '0' && raceIds[1] === '1' && (await footer(page)).includes('100,000'), `after clear: ids=${raceIds.slice(0, 3)} footer=${await footer(page)} filterInput="${filterInputVal}" clearBtnVisible=${await act(page).locator('button[title="Clear"]').isVisible()}`);

  // Race: two rapid Next clicks with slow reads
  await page.evaluate(() => { window.__delays['read_parquet_data'] = 400; });
  await pageInput.fill('1'); await pageInput.press('Enter'); await waitGrid(page);
  await act(page).locator('button:has-text("Next")').click(); await act(page).locator('button:has-text("Next")').click();
  await page.waitForTimeout(1500); await waitGrid(page);
  check('S2.race.doubleNext', (await ids())[0] === '100' && await pageInput.inputValue() === '3', `page=${await pageInput.inputValue()} first id=${(await ids())[0]}`);
  await page.evaluate(() => { window.__delays['read_parquet_data'] = 0; });

  // Refresh keeps or resets?
  await pageInput.fill('5'); await pageInput.press('Enter'); await waitGrid(page);
  await act(page).locator('button:has-text("Refresh")').click(); await waitGrid(page);
  report('S2.refresh', 'OBSERVE', `after refresh page=${await pageInput.inputValue()} first id=${(await ids())[0]}`);
});

// ---------------------------------------------------------------- S3 filter bar
await scenario('S3-filter', async ({ page }) => {
  const mr = `${FIX}/multi_rowgroup.parquet`;
  await openFile(page, mr);
  const form = () => act(page).locator('form').first();
  const row = (i) => form().locator('xpath=./div').nth(i);
  const apply = async () => { await form().locator('button[type=submit]').click(); await page.waitForTimeout(100); await waitGrid(page); };
  const setRow = async (i, col, op, val) => {
    const r = row(i);
    await r.locator('select').nth(0).selectOption(col);
    await r.locator('select').nth(1).selectOption(op);
    if (val !== undefined) await r.locator('input[type=text]').fill(val);
  };
  await setRow(0, 'name', '=', 'row-5'); await apply();
  check('S3.eqText', (await footer(page)) === 'Showing 1 to 1 of 1 entries' && (await visibleGrid(page))[0][0] === '5', await footer(page));
  check('S3.summaryFollowsFilter', (await summary(page))?.startsWith('1 rows'), `summary=${await summary(page)}`);
  await setRow(0, 'name', 'LIKE', '%row-99%'); await apply();
  check('S3.like', (await footer(page)).includes('of 1,111'), await footer(page));
  await setRow(0, 'id', '>', '99990'); await apply();
  check('S3.gtInt', (await footer(page)).includes('of 9 '), await footer(page));
  await setRow(0, 'id', '=', 'abc'); await apply();
  report('S3.intGarbage', await dataError(page) ? 'PASS' : 'OBSERVE', `id = 'abc' -> dataError=${await dataError(page)} footer=${await footer(page)}`);
  await setRow(0, 'val', '>', ' 0.5 '); await apply();
  { // `val` is uniform on [0, 1): the point is that the padded value still applies, so accept the statistical range.
    const m = (await footer(page))?.match(/of ([\d,]+) entries/); const n = m ? Number(m[1].replace(/,/g, '')) : 0;
    check('S3.floatTrim', n > 49_000 && n < 51_000, await footer(page)); }
  await setRow(0, 'name', '=', "it's"); await apply();
  check('S3.apostrophe', (await footer(page)).includes('of 0 ') && !(await dataError(page)), `footer=${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'name', '=', ''); await apply();
  report('S3.emptyValue', 'OBSERVE', `empty value apply -> footer=${await footer(page)} (filter treated as none?)`);
  await setRow(0, 'id', '=', '9007199254740993'); await apply();
  check('S3.bigLiteral', (await footer(page)).includes('of 0 ') && !(await dataError(page)), `footer=${await footer(page)} err=${await dataError(page)}`);
  // Two conditions
  await setRow(0, 'grp', '=', '3');
  await form().locator('button[title="Add Condition"]').click();
  await setRow(1, 'id', '<', '100'); await apply();
  check('S3.and', (await footer(page)).includes('of 14 '), await footer(page));
  // remove second row -> requires Apply
  await row(1).locator('button[title="Remove condition"]').click(); await page.waitForTimeout(100);
  report('S3.removeNeedsApply', 'OBSERVE', `after removing 2nd condition without Apply footer=${await footer(page)}`);
  await apply();
  check('S3.afterRemove', (await footer(page)).includes('14,286'), await footer(page));
  // paging inside a filter, then export modal text
  await act(page).locator('button:has-text("Next")').click(); await waitGrid(page);
  const firstFiltered = (await visibleGrid(page))[0][0];
  check('S3.pageInFilter', firstFiltered === '353', `second page of grp=3 starts at id ${firstFiltered}`);
  await act(page).locator('button:has-text("Export")').first().click();
  report('S3.exportModal', 'OBSERVE', `modal: ${await act(page).locator('.fixed label:has-text("All rows")').textContent()} | ${await act(page).locator('.fixed label:has-text("Current page")').textContent()} | notice=${await act(page).locator('.fixed').locator('text=active filter').isVisible()}`);
  await act(page).locator('.fixed button:has-text("Cancel")').click();
  // Clear
  await act(page).locator('button[title="Clear"]').click(); await waitGrid(page);
  check('S3.clear', (await footer(page)).includes('100,000') && await row(0).locator('input[type=text]').inputValue() === '', await footer(page));
  // Error path with nested column
  await openFile(page, `${FIX}/nested.parquet`);
  await setRow(0, 'st', '=', 'x'); await apply();
  check('S3.nestedError', await dataError(page) && (await visibleGrid(page)).length === 3, `dataError=${await dataError(page)} rows=${(await visibleGrid(page)).length} text=${await act(page).locator('.font-mono.break-words').textContent().catch(() => '')}`);
  await setRow(0, 'st', 'LIKE', '%x%'); await apply();
  report('S3.nestedLike', 'OBSERVE', `LIKE on struct: dataError=${await dataError(page)} footer=${await footer(page)}`);
  await setRow(0, 'li', 'IS NULL'); await apply();
  check('S3.isNull', (await footer(page)).includes('of 1 '), `IS NULL on list: ${await footer(page)} err=${await dataError(page)}`);
  // binary / temporal / boolean / decimal comparisons
  await openFile(page, `${FIX}/text_binary.parquet`);
  await setRow(0, 'uuid', 'IS NOT NULL'); await apply();
  check('S3.binaryNotNull', (await footer(page)).includes('of 6 '), await footer(page));
  await setRow(0, 'bin', '=', '0001ff'); await apply();
  report('S3.binaryEqHex', 'OBSERVE', `bin = '0001ff' (as displayed) -> footer=${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 's', 'LIKE', '%🎉%'); await apply();
  check('S3.emoji', (await footer(page)).includes('of 1 '), await footer(page));
  await openFile(page, `${FIX}/temporal.parquet`);
  await setRow(0, 'd32', '>', '2000-01-01'); await apply();
  check('S3.date', (await footer(page)).includes('of 1 '), `d32 > '2000-01-01': ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'ts_us', '<', '2000-01-01 00:00:00'); await apply();
  check('S3.timestamp', (await footer(page)).includes('of 1 '), `ts_us < '2000-01-01 00:00:00': ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'ts_tokyo', '=', '2024-01-02T03:04:05.678901+09:00'); await apply();
  report('S3.tsTokyoEqDisplayed', (await footer(page)).includes('of 1 ') ? 'PASS' : 'FAIL', `ts_tokyo = displayed value: ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'd32', '=', '2024-02-29'); await apply();
  check('S3.dateEq', (await footer(page)).includes('of 1 '), `d32 = '2024-02-29': ${await footer(page)}`);
  await setRow(0, 'd64', '=', '2024-02-29'); await apply();
  report('S3.date64Eq', (await footer(page)).includes('of 1 ') ? 'PASS' : 'FAIL', `d64 = '2024-02-29': ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'dur', '>', '0'); await apply();
  report('S3.duration', 'OBSERVE', `dur > 0: ${await footer(page)} err=${await dataError(page)}`);
  await openFile(page, `${FIX}/numeric.parquet`);
  await setRow(0, 'b', '=', 'true'); await apply();
  check('S3.bool', (await footer(page)).includes('of 1 '), `b = true: ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'b', '=', 'yes'); await apply();
  report('S3.boolGarbage', 'OBSERVE', `b = 'yes': ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'd128', '>', '0'); await apply();
  check('S3.decimal', (await footer(page)).includes('of 1 '), `d128 > 0: ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'd128', '=', '12345.67'); await apply();
  check('S3.decimalEq', (await footer(page)).includes('of 1 '), `d128 = 12345.67: ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'd256', '=', '0'); await apply();
  report('S3.decimal256Eq', (await footer(page)).includes('of 1 ') ? 'PASS' : 'FAIL', `d256 = 0: ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'u64', '=', '18446744073709551615'); await apply();
  report('S3.u64max', (await footer(page)).includes('of 1 ') ? 'PASS' : 'FAIL', `u64 = max: ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'f64', '=', '1e300'); await apply();
  check('S3.f64sci', (await footer(page)).includes('of 1 '), `f64 = 1e300: ${await footer(page)}`);
  await openFile(page, `${FIX}/names.parquet`);
  await setRow(0, 'qu"ote', '=', '1'); await apply();
  check('S3.quoteName', (await footer(page)).includes('of 1 '), `"qu\\"ote" = 1: ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'MixedCase', '=', '1'); await apply();
  check('S3.mixedCase', (await footer(page)).includes('of 1 '), `MixedCase = 1: ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, '', '=', '1'); await apply();
  report('S3.emptyName', 'OBSERVE', `"" = 1: ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'select', '=', '1'); await apply();
  check('S3.reservedName', (await footer(page)).includes('of 1 '), `select = 1: ${await footer(page)} err=${await dataError(page)}`);
  await setRow(0, 'a.b', '=', '1'); await apply();
  check('S3.dotName', (await footer(page)).includes('of 1 '), `"a.b" = 1: ${await footer(page)} err=${await dataError(page)}`);
});

// ---------------------------------------------------------------- S4 search
await scenario('S4-search', async ({ page }) => {
  await openFile(page, `${FIX}/multi_rowgroup.parquet`);
  await page.keyboard.press('Meta+f');
  const sb = act(page).locator('input[placeholder*="press Enter"]');
  check('S4.cmdF', await sb.isVisible(), 'search bar opens with Cmd+F');
  await sb.fill('row-1'); await sb.press('Enter'); await page.waitForTimeout(300);
  const counter = await page.locator('text=/\\d+\\s*\\/\\s*\\d+/').first().textContent().catch(() => null);
  report('S4.count', 'OBSERVE', `counter after "row-1": ${counter}`);
  const highlighted = await page.evaluate(() => document.querySelectorAll('td.bg-yellow-100, td.bg-orange-200').length);
  check('S4.highlight', highlighted > 0, `highlighted cells=${highlighted}`);
  await sb.press('Enter'); await page.waitForTimeout(200);
  const counter2 = await page.locator('text=/\\d+\\s*\\/\\s*\\d+/').first().textContent().catch(() => null);
  check('S4.nextMatch', counter2 !== counter, `${counter} -> ${counter2}`);
  await sb.fill('GRP'); await sb.press('Enter'); await page.waitForTimeout(200);
  const thHi = await page.evaluate(() => document.querySelectorAll('th.bg-yellow-100').length);
  check('S4.headerMatch', thHi === 1, `header matches for "GRP" (case-insensitive)=${thHi}`);
  // search across pages? only current page
  await sb.fill('row-99999'); await sb.press('Enter'); await page.waitForTimeout(200);
  report('S4.scope', 'OBSERVE', `"row-99999" (on last page only) counter=${await page.locator('text=/\\d+\\s*\\/\\s*\\d+/').first().textContent().catch(() => 'none')}`);
  await sb.press('Escape'); await page.waitForTimeout(100);
  check('S4.escape', !(await sb.isVisible()) && (await page.evaluate(() => document.querySelectorAll('td.bg-yellow-100').length)) === 0, 'Esc closes search and clears highlights');
  // wide file: far column match scrolls horizontally
  await openFile(page, `${FIX}/wide.parquet`);
  await page.keyboard.press('Meta+f');
  await sb.fill('col_599'); await sb.press('Enter'); await page.waitForTimeout(800);
  const sl = await page.evaluate(() => { const s = [...document.querySelectorAll('.overflow-auto')].find(e => e.offsetParent && e.querySelector('table')); return s.scrollLeft; });
  const hc = await visibleHeader(page);
  check('S4.wideScroll', sl > 0 && hc.includes('col_599'), `scrollLeft=${sl} header has col_599=${hc.includes('col_599')}`);
  // search while in query view?
  await act(page).locator('button:has-text("Query")').click(); await page.waitForTimeout(200);
  await page.keyboard.press('Meta+f'); await page.waitForTimeout(300);
  report('S4.cmdFinQuery', 'OBSERVE', `Cmd+F in query view: search bar visible=${await sb.isVisible()} query editor still visible=${await act(page).locator('textarea').isVisible()}`);
});

// ---------------------------------------------------------------- S5 SQL view
await scenario('S5-sql', async ({ page }) => {
  const mr = `${FIX}/multi_rowgroup.parquet`;
  await openFile(page, mr);
  await act(page).locator('button:has-text("Query")').click();
  const ta = act(page).locator('textarea');
  const run = async (q) => { await ta.fill(q); await act(page).locator('button:has-text("Run")').click(); await page.waitForTimeout(200); await page.waitForFunction(() => ![...document.querySelectorAll('span')].some(s => s.textContent === 'Executing query...')); await page.waitForTimeout(100); };
  const status = () => act(page).locator('span').filter({ hasText: /^\d+ rows/ }).first().textContent().catch(() => null);
  const qerr = () => act(page).locator('.whitespace-pre-wrap').first().textContent().catch(() => null);
  await act(page).locator('button:has-text("Run")').click(); await page.waitForTimeout(800);
  check('S5.default', (await status())?.startsWith('100 rows'), `default query: ${await status()}`);
  await run('SELECT * FROM t');
  check('S5.truncated', (await status())?.startsWith('10000 rows') && await act(page).locator('text=Showing the first 10,000').isVisible(), `${await status()}`);
  const qg = await visibleGrid(page);
  report('S5.rowVirt', 'OBSERVE', `rendered rows for 10000-row result: ${qg.length}`);
  await page.evaluate(() => { const s = [...document.querySelectorAll('.overflow-auto')].find(e => e.offsetParent && e.querySelector('table') && e.closest('.z-10')); s.scrollTop = 1e9; });
  await page.waitForTimeout(300);
  const lastRows = await visibleGrid(page);
  check('S5.scrollBottom', lastRows.at(-1)?.[0] === '9999', `last rendered id=${lastRows.at(-1)?.[0]}`);
  await run('SELECT bogus FROM t');
  check('S5.error', (await qerr())?.includes('bogus'), `${(await qerr())?.slice(0, 120)}`);
  await run('');
  report('S5.emptyQuery', 'OBSERVE', `empty query -> ${(await qerr())?.slice(0, 120)}`);
  await run('SELECT id AS "a b", id AS "日本語", COUNT(*) OVER () AS c FROM t LIMIT 1');
  check('S5.aliases', (await visibleHeader(page)).join('|').includes('a b') && (await visibleGrid(page))[0]?.length === 3, `${(await visibleHeader(page)).join('|')} ${JSON.stringify((await visibleGrid(page))[0])}`);
  await run('SELECT CAST(id AS DECIMAL(20,4)) AS d, id * 1000000000000 AS big, ARROW_CAST(id, \'Utf8\') AS s FROM t WHERE id = 9999');
  report('S5.derivedTypes', 'OBSERVE', `${(await visibleHeader(page)).join('|')} -> ${JSON.stringify((await visibleGrid(page))[0])}`);
  await run('SELECT NOW() AS n, CURRENT_DATE AS d, INTERVAL \'1 day\' AS i, [1,2] AS arr, {\'a\': 1} AS st');
  report('S5.specialTypes', (await qerr()) ? 'FAIL' : 'OBSERVE', `${(await qerr())?.slice(0, 160) ?? JSON.stringify((await visibleGrid(page))[0])}`);
  // Cmd+Enter
  await ta.fill('SELECT 42 AS answer'); await ta.press('Meta+Enter'); await page.waitForTimeout(500);
  check('S5.cmdEnter', (await visibleGrid(page))[0]?.[0] === '42', `Cmd+Enter result ${JSON.stringify((await visibleGrid(page))[0])}`);
  // query result persists across view toggle and tab switch
  await act(page).locator('button:has-text("Content")').click(); await page.waitForTimeout(100);
  await act(page).locator('button:has-text("Query")').click(); await page.waitForTimeout(100);
  check('S5.persistToggle', (await visibleGrid(page))[0]?.[0] === '42', 'result kept after toggling Content/Query');
  await openFile(page, `${FIX}/one_row.parquet`);
  await page.click(`span[title="${mr}"]`); await page.waitForTimeout(300);
  check('S5.persistTab', await ta.isVisible() && (await ta.inputValue()) === 'SELECT 42 AS answer', `query view restored on tab switch: textarea visible=${await ta.isVisible()} value=${await ta.inputValue()}`);
  // DROP TABLE t
  await run('DROP TABLE t');
  report('S5.drop', 'OBSERVE', `DROP TABLE t -> status=${await status()} err=${await qerr()}`);
  await act(page).locator('button:has-text("Content")').click(); await page.waitForTimeout(100);
  await act(page).locator('button:has-text("Next")').click(); await waitGrid(page);
  check('S5.dropBreaksBrowse', !(await dataError(page)), `after DROP TABLE t in SQL view, paging: dataError=${await dataError(page)} msg=${await act(page).locator('.font-mono.break-words').textContent().catch(() => '')}`);
  await act(page).locator('button:has-text("Refresh")').click(); await waitGrid(page);
  check('S5.refreshRecovers', !(await dataError(page)) && (await visibleGrid(page)).length === 50, `refresh after drop: rows=${(await visibleGrid(page)).length}`);
  // SET partitions then paging determinism
  await act(page).locator('button:has-text("Query")').click();
  await run('SET datafusion.execution.target_partitions = 8');
  await run('SELECT COUNT(*) FROM t');
  await act(page).locator('button:has-text("Content")').click();
  const pageInput = act(page).locator('input[inputmode="numeric"]');
  const seen = new Set();
  for (let i = 0; i < 4; i++) { await pageInput.fill('1234'); await pageInput.press('Enter'); await waitGrid(page); seen.add((await visibleGrid(page))[0][0]); await pageInput.fill('1'); await pageInput.press('Enter'); await waitGrid(page); }
  report('S5.setPartitions', seen.size === 1 ? 'OBSERVE' : 'FAIL', `after SET target_partitions=8, page 1234 first ids over 4 loads: ${[...seen]}`);
});

// ---------------------------------------------------------------- S6 export
// The store is shared with S6-restore, which checks that the last export
// folder survives a relaunch.
const S6_DATA = path.join(OUT, 'data', 's6');
fs.rmSync(S6_DATA, { recursive: true, force: true });
const S6_OUT = `${OUT}/e2e_exports`;
await scenario('S6-export', async ({ page, bridge }) => {
  const mr = `${FIX}/multi_rowgroup.parquet`;
  const outDir = S6_OUT; fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir);
  await openFile(page, mr);
  // Record the defaultPath passed to the save dialog by wrapping invoke.
  await page.evaluate(() => { const orig = window.__TAURI_INTERNALS__.invoke; window.__TAURI_INTERNALS__.invoke = async (c, a) => { if (c === 'plugin:dialog|save') window.__lastSave = a; return orig(c, a); }; });
  const lastSave = () => page.evaluate(() => window.__lastSave?.options?.defaultPath);
  const openModal = async () => { await act(page).locator('button:has-text("Export")').first().click(); await act(page).locator('.fixed h2:has-text("Export Data")').waitFor(); };
  const modal = () => act(page).locator('.fixed').filter({ hasText: 'Export Data' });
  const doExport = async (path) => { await page.evaluate((p) => { window.__dialog.save = p; }, path); await modal().locator('button:has-text("Export")').click(); await page.waitForTimeout(300); await page.waitForFunction(() => !document.querySelector('.fixed h2') || ![...document.querySelectorAll('button')].some(b => b.textContent === 'Exporting...'), null, { timeout: 60000 }); const done = act(page).locator('.fixed').filter({ hasText: 'Export Complete' }); if (await done.count()) { report('S6.doneState', 'OBSERVE', (await done.locator('p').first().textContent())); await done.locator('button:has-text("Close")').click(); await page.waitForTimeout(150); } };
  const lines = (p) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length : -1;
  await openModal();
  await doExport(`${outDir}/all.csv`);
  check('S6.defaultPath.none', (await lastSave()) === 'multi_rowgroup.csv', `no root, no earlier export: defaultPath=${await lastSave()}`);
  const notes = await page.evaluate(() => window.__notifications.splice(0));
  check('S6.all', lines(`${outDir}/all.csv`) === 100001 && notes.length === 1, `lines=${lines(`${outDir}/all.csv`)} notif=${JSON.stringify(notes)}`);
  // current page (page 3)
  const pageInput = act(page).locator('input[inputmode="numeric"]');
  await pageInput.fill('3'); await pageInput.press('Enter'); await waitGrid(page);
  await openModal();
  await modal().locator('input[value=current]').check();
  report('S6.currentLabel', 'OBSERVE', await modal().locator('label:has-text("Current page")').textContent());
  await doExport(`${outDir}/page3.csv`);
  check('S6.defaultPath.lastExport', (await lastSave()) === `${outDir}/multi_rowgroup.csv`, `after an export to ${outDir}: defaultPath=${await lastSave()}`);
  const p3 = fs.readFileSync(`${outDir}/page3.csv`, 'utf8').split('\n');
  check('S6.currentPage', p3.length - 2 === 50 && p3[1].startsWith('100,') && p3[50].startsWith('149,'), `rows=${p3.length - 2} first=${p3[1].slice(0, 10)} last=${p3[50].slice(0, 10)}`);
  // custom range
  await openModal();
  await modal().locator('input[value=custom]').check();
  const start = modal().locator('input[type=number]').nth(0), end = modal().locator('input[type=number]').nth(1);
  await start.fill('10'); await end.fill('20');
  await doExport(`${outDir}/custom.csv`);
  const cu = fs.readFileSync(`${outDir}/custom.csv`, 'utf8').split('\n');
  check('S6.custom', cu.length - 2 === 11 && cu[1].startsWith('9,'), `rows=${cu.length - 2} first=${cu[1].slice(0, 8)}`);
  // invalid range
  await openModal();
  await modal().locator('input[value=custom]').check();
  await start.fill('20'); await end.fill('10');
  check('S6.invalidRange', await modal().locator('button:has-text("Export")').isDisabled() && await modal().locator('text=Enter a range').isVisible(), 'export disabled with message');
  // clearing the start field
  await start.fill('');
  report('S6.clearStart', 'OBSERVE', `after clearing Start Row the field shows "${await start.inputValue()}"; typing 5 now gives "${await (async () => { await start.press('End'); await start.type('5'); return start.inputValue(); })()}"`);
  await end.fill(''); report('S6.clearEnd', 'OBSERVE', `after clearing End Row the field shows "${await end.inputValue()}"`);
  await start.fill('100001');
  report('S6.startOverMax', 'OBSERVE', `start=100001 -> value "${await start.inputValue()}" disabled=${await modal().locator('button:has-text("Export")').isDisabled()}`);
  await modal().locator('button:has-text("Cancel")').click();
  // cancel save dialog
  await openModal();
  await page.evaluate(() => { window.__dialog.save = null; });
  await modal().locator('button:has-text("Export")').click(); await page.waitForTimeout(300);
  check('S6.cancelDialog', await modal().isVisible() && !(await modal().locator('button:has-text("Exporting")').isVisible()), 'modal stays open after cancelled save dialog');
  // unwritable path
  await doExport('/nonexistent/dir/out.csv');
  check('S6.unwritable', await modal().isVisible() && await modal().locator('.bg-red-50').isVisible(), `error shown: ${await modal().locator('.bg-red-50').textContent().catch(() => 'none')}`);
  check('S6.defaultPath.failedExportNotRecorded', (await bridge.call('export_default_dir', { sourcePath: mr })) === outDir, `after a failed export: ${await bridge.call('export_default_dir', { sourcePath: mr })}`);
  await modal().locator('button:has-text("Cancel")').click();
  // filtered export + json
  const form = act(page).locator('form').first();
  await form.locator('select').nth(0).selectOption('grp'); await form.locator('input[type=text]').fill('6'); await form.locator('button[type=submit]').click(); await waitGrid(page);
  await openModal();
  await modal().locator('input[value=json]').check();
  report('S6.filteredLabel', 'OBSERVE', `${await modal().locator('label:has-text("All rows")').textContent()} notice=${await modal().locator('text=active filter').isVisible()}`);
  await doExport(`${outDir}/filtered.json`);
  const fj = JSON.parse(fs.readFileSync(`${outDir}/filtered.json`, 'utf8'));
  check('S6.filteredJson', fj.length === 14285 && fj.every(r => r.grp === 6), `rows=${fj.length}`);
  // Export while a filter is rejected (rollback) -> uses last good
  // Export of special files
  for (const f of ['nested.parquet', 'numeric.parquet', 'text_binary.parquet', 'nan.parquet', 'temporal.parquet']) {
    await openFile(page, `${FIX}/${f}`);
    for (const fmt of ['csv', 'json']) {
      await openModal(); await modal().locator(`input[value=${fmt}]`).check();
      await doExport(`${outDir}/${f}.${fmt}`);
      const err = await modal().locator('.bg-red-50').textContent().catch(() => null);
      if (err) { report(`S6.${f}.${fmt}`, 'FAIL', err); await modal().locator('button:has-text("Cancel")').click(); }
      else report(`S6.${f}.${fmt}`, 'PASS', fs.readFileSync(`${outDir}/${f}.${fmt}`, 'utf8').slice(0, 160).replace(/\n/g, '\\n'));
    }
  }
  // A file inside an open workspace root: the panel starts in its own
  // folder, ahead of the last export folder. The name drops .PARQUET.
  await openFolder(page, FIX);
  await openFile(page, `${FIX}/paths/UPPER.PARQUET`);
  await openModal();
  await doExport(null);
  check('S6.defaultPath.sourceInRoot', (await lastSave()) === `${FIX}/paths/UPPER.csv`, `save dialog default for UPPER.PARQUET under the root: ${await lastSave()}`);
}, { dataDir: S6_DATA });

// "Relaunch" on the same store: the last export folder is still known.
await scenario('S6-restore', async ({ bridge }) => {
  const stored = JSON.parse(fs.readFileSync(path.join(S6_DATA, 'bookmarks.json'), 'utf8')).last_export;
  check('S6r.stored', stored?.path === S6_OUT, `bookmarks.json last_export=${JSON.stringify(stored)}`);
  check('S6r.lastExportRestored', (await bridge.call('export_default_dir', { sourcePath: '/elsewhere/x.parquet' })) === S6_OUT, 'a file outside every root starts in the last export folder');
  check('S6r.sourceInRootRestored', (await bridge.call('export_default_dir', { sourcePath: `${FIX}/multi_rowgroup.parquet` })) === FIX, 'a file under the restored root starts in its own folder');
  fs.rmSync(S6_OUT, { recursive: true, force: true });
  check('S6r.deletedFolderSkipped', (await bridge.call('export_default_dir', { sourcePath: '/elsewhere/x.parquet' })) === null, 'a deleted last export folder is not offered');
}, { dataDir: S6_DATA });

// ---------------------------------------------------------------- S7 tabs / workspace / welcome
await scenario('S7-tabs', async ({ page, bridge }) => {
  const A = `${FIX}/one_row.parquet`, B = `${FIX}/nan.parquet`, C = `${FIX}/dict.parquet`;
  await openFile(page, A); await openFile(page, B); await openFile(page, C);
  const tabs = () => page.evaluate(() => [...document.querySelectorAll('[title="Close tab"]')].map(b => b.parentElement.querySelector('span').textContent));
  check('S7.three', (await tabs()).join(',') === 'one_row.parquet,nan.parquet,dict.parquet' && (await activeTabName(page)) === 'dict.parquet', `${await tabs()} active=${await activeTabName(page)}`);
  await page.click(`span[title="${A}"]`); await page.waitForTimeout(300);
  check('S7.select', (await page.evaluate(() => [...document.querySelectorAll('h1')].find(h => h.offsetParent)?.textContent)) === 'one_row.parquet');
  await page.keyboard.press('Meta+w'); await page.waitForTimeout(300);
  check('S7.cmdW', (await tabs()).join(',') === 'nan.parquet,dict.parquet' && (await page.evaluate(() => [...document.querySelectorAll('h1')].find(h => h.offsetParent)?.textContent)) === 'nan.parquet', `${await tabs()} active=${await page.evaluate(() => [...document.querySelectorAll('h1')].find(h => h.offsetParent)?.textContent)}`);
  const evicted = bridge.log.filter(l => l.cmd === 'evict_cache').map(l => l.args.path);
  check('S7.evict', evicted.includes(A), `evict calls: ${evicted.map(base)}`);
  await openFile(page, B);
  check('S7.reopenExisting', (await tabs()).length === 2, `reopen already-open file: tabs=${await tabs()}`);
  await openFile(page, A);
  check('S7.reopenClosed', (await tabs()).length === 3 && (await visibleGrid(page)).length === 1, `reopen closed file works: rows=${(await visibleGrid(page)).length}`);
  await page.keyboard.press('Meta+1'); await page.waitForTimeout(300);
  check('S7.cmd1', (await page.evaluate(() => [...document.querySelectorAll('h1')].find(h => h.offsetParent)?.textContent)) === 'nan.parquet');
  await page.keyboard.press('Meta+Shift+]'); await page.waitForTimeout(300);
  check('S7.cycle', (await page.evaluate(() => [...document.querySelectorAll('h1')].find(h => h.offsetParent)?.textContent)) === 'dict.parquet');
  // same basename in different dirs
  await openFile(page, `${FIX}/paths/dir with space/inner.parquet`);
  check('S7.pathsWithSpace', (await visibleGrid(page)).length === 3);
  // Close all -> welcome, recent files
  for (let i = 0; i < 4; i++) { await page.locator('[title="Close tab"]').first().click(); await page.waitForTimeout(150); }
  check('S7.welcome', await page.locator('text=Drop your Parquet file here').isVisible(), 'welcome after closing all tabs');
  // Recent files live in the bridge's store (bookmarks.json), not localStorage.
  const recent = (await bridge.call('list_recent_files')).map(f => f.name);
  check('S7.recent', recent[0] === 'inner.parquet' && recent.length === 4, `recent=${recent}`);
  check('S7.recentNoLocalStorage', (await page.evaluate(() => localStorage.getItem('parqsee-recent-files'))) === null, 'legacy key cleared');
  const recentUi = await page.locator('text=Recent Files').isVisible();
  check('S7.recentUi', recentUi);
  // click a recent file
  await page.click('text=inner.parquet'); await page.waitForTimeout(500); await waitGrid(page);
  check('S7.recentClick', (await visibleGrid(page)).length === 3);
  await page.locator('[title="Close tab"]').first().click(); await page.waitForTimeout(200);
  // A recent file that has since been deleted: greyed out on reload, an alert and gone on click.
  const goneDir = `${OUT}/gone`; fs.rmSync(goneDir, { recursive: true, force: true }); fs.mkdirSync(goneDir);
  fs.copyFileSync(`${FIX}/one_row.parquet`, `${goneDir}/missing.parquet`);
  await openFile(page, `${goneDir}/missing.parquet`);
  await page.locator('[title="Close tab"]').first().click(); await page.waitForTimeout(200);
  fs.rmSync(`${goneDir}/missing.parquet`);
  await page.reload(); await page.waitForSelector('text=missing.parquet');
  check('S7.unavailableRecent', await page.locator('text=No longer available').isVisible(), 'deleted file marked unavailable after reload');
  await page.click('text=missing.parquet'); await page.waitForTimeout(500);
  const al = await page.evaluate(() => window.__alerts.splice(0));
  check('S7.missingRecent', al.length === 1 && al[0].includes('not found') && !(await page.locator('text=missing.parquet').isVisible()), `alerts=${al} stillListed=${await page.locator('text=missing.parquet').isVisible()}`);
  check('S7.missingRecentForgotten', !(await bridge.call('list_recent_files')).some(f => f.name === 'missing.parquet'), 'removed from the store too');
  // drop non-parquet
  await page.evaluate(() => window.__emit('file-drop', ['/etc/hosts'])); await page.waitForTimeout(200);
  check('S7.dropOther', (await page.evaluate(() => window.__alerts.splice(0)))[0]?.includes('.parquet'), 'alert for non-parquet drop');
  // drop two parquet files at once
  await page.evaluate((p) => window.__emit('file-drop', p), [A, B]); await page.waitForTimeout(800);
  report('S7.dropTwo', 'OBSERVE', `dropping 2 files opened tabs: ${await page.evaluate(() => [...document.querySelectorAll('[title="Close tab"]')].map(b => b.parentElement.querySelector('span').textContent))}`);
  // Browse button via dialog
  for (let i = 0; i < 2; i++) { await page.locator('[title="Close tab"]').first().click().catch(() => {}); await page.waitForTimeout(150); }
  await page.evaluate((p) => { window.__dialog.open = p; }, C);
  // Scoped to the drop zone: its button and the header's now carry the same
  // "Open File" label, so an unscoped has-text matches both.
  await page.locator('[class*="border-dashed"] button:has-text("Open File")').click(); await page.waitForTimeout(500); await waitGrid(page);
  check('S7.browse', (await activeTabName(page)) === 'dict.parquet', `browse dialog opens file: ${await activeTabName(page)}`);
  // Cmd+O in workspace?
  await page.evaluate((p) => { window.__dialog.open = p; }, A);
  await page.keyboard.press('Meta+o'); await page.waitForTimeout(500);
  report('S7.cmdOInWorkspace', 'OBSERVE', `Cmd+O with a tab open -> tabs=${await page.evaluate(() => document.querySelectorAll('[title="Close tab"]').length)}`);
  // settings reachable?
  report('S7.settingsInWorkspace', 'OBSERVE', `settings button in workspace: ${await page.locator('[title^="Settings"]').count()}`);
  // per-tab state isolation: filter in one tab doesn't leak
  await openFile(page, `${FIX}/multi_rowgroup.parquet`);
  const form = act(page).locator('form').first();
  await form.locator('select').nth(0).selectOption('grp'); await form.locator('input[type=text]').fill('1'); await form.locator('button[type=submit]').click(); await waitGrid(page);
  await page.click(`span[title="${C}"]`); await page.waitForTimeout(300);
  const otherFooter = await act(page).locator('text=/Showing .* entries/').first().textContent();
  check('S7.tabIsolation', otherFooter.includes('of 5 '), `dict tab footer=${otherFooter}`);
  await page.click(`span[title="${FIX}/multi_rowgroup.parquet"]`); await page.waitForTimeout(300);
  check('S7.tabStateKept', (await act(page).locator('text=/Showing .* entries/').first().textContent()).includes('14,286'), 'filter kept when returning');
});

// ---------------------------------------------------------------- S8 settings
// The dialog applies every change at once and closes on Escape / ✕ / the
// backdrop; there is no Save. The grid's own display settings (density,
// column types) are in the viewer's View options, Clear all is on the
// Welcome screen's Recent Files heading.
await scenario('S8-settings', async ({ page, bridge }) => {
  await page.click('[title^="Settings"]');
  await page.waitForSelector('h2:has-text("Settings")');
  await page.locator('select').nth(0).selectOption('ja'); await page.waitForTimeout(300);
  check('S8.ja', (await page.evaluate(() => document.body.innerText)).includes('ファイル'), `applies at once; body sample: ${(await page.evaluate(() => document.body.innerText)).slice(0, 80).replace(/\n/g, ' ')}`);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('parqsee-settings')));
  check('S8.persist', saved.language === 'ja', JSON.stringify(saved));
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  check('S8.escapeCloses', (await page.locator('h2:has-text("設定")').count()) === 0 && (await page.evaluate(() => JSON.parse(localStorage.getItem('parqsee-settings')).language)) === 'ja', 'Escape closes the dialog and keeps the change');
  await page.reload(); await page.waitForTimeout(500);
  check('S8.reloadJa', (await page.evaluate(() => document.body.innerText)).includes('ファイル'), 'language survives reload');
  await page.click('[title^="設定"]');
  await page.waitForTimeout(200);
  await page.locator('select').nth(0).selectOption('en'); await page.waitForTimeout(200);
  // theme dark via the segmented control
  const themeBtn = page.locator('[role=dialog] button:has-text("Dark")').first();
  if (await themeBtn.count()) await themeBtn.click(); else report('S8.themeCtl', 'OBSERVE', 'no Dark button; skipping');
  await page.waitForTimeout(300);
  check('S8.dark', await page.evaluate(() => document.documentElement.classList.contains('dark')), 'html.dark applied at once');
  check('S8.noViewerSettings', !/Rows per page|Row Density|Column Type/.test(await page.locator('[role=dialog]').innerText()), 'the grid\'s own settings are not in the dialog');
  check('S8.purchaseHidden', (await page.locator('[data-testid="purchase-status"]').count()) === 0, 'no purchase section in a build without a store (has_store false)');
  await page.locator('[role=dialog] [title="Close"]').click(); await page.waitForTimeout(200);
  check('S8.closeButton', (await page.locator('h2:has-text("Settings")').count()) === 0, '✕ closes the dialog');
  await page.screenshot({ path: `${OUT}/shots/S8-dark-welcome.png` });
  // view options in the viewer: density and column types apply at once
  await openFile(page, `${FIX}/multi_rowgroup.parquet`);
  await page.screenshot({ path: `${OUT}/shots/S8-dark-viewer.png` });
  await act(page).locator('[title="View options"]').click(); await page.waitForTimeout(100);
  await act(page).locator('[role=radio]:has-text("Compact")').click(); await page.waitForTimeout(100);
  await act(page).locator('[role=radio]:has-text("Physical")').click(); await page.waitForTimeout(300);
  const viewSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('parqsee-settings')));
  check('S8.viewOptions', viewSaved.rowDensity === 'compact' && viewSaved.typeDisplay === 'physical', JSON.stringify({ rowDensity: viewSaved.rowDensity, typeDisplay: viewSaved.typeDisplay }));
  check('S8.physicalTypes', (await act(page).locator('th').allInnerTexts()).some(x => /INT64|INT32|BYTE_ARRAY/.test(x)), 'header labels switch to the physical types');
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  check('S8.viewOptionsEscape', (await act(page).locator('[role=dialog][aria-label="View options"]').count()) === 0, 'Escape closes the popover');
  await act(page).locator('[title="View options"]').click(); await page.waitForTimeout(100);
  await act(page).locator('[role=radio]:has-text("Comfortable")').click();
  await act(page).locator('[role=radio]:has-text("Logical")').click();
  await page.mouse.click(5, 300); await page.waitForTimeout(100);
  check('S8.viewOptionsOutside', (await act(page).locator('[role=dialog][aria-label="View options"]').count()) === 0, 'a click elsewhere closes the popover');
  await act(page).locator('button:has-text("Query")').click(); await page.waitForTimeout(100);
  // change rows per page through footer select is hidden in query view; use the other tab? settings unreachable -> change via localStorage event? Instead test: in query view, change rpp by switching to content? Skip; test that changing rpp resets view mode:
  await act(page).locator('button:has-text("Content")').click();
  const rpp = act(page).locator('select').filter({ hasText: '500' }).first();
  await act(page).locator('button:has-text("Query")').click(); await page.waitForTimeout(100);
  const qVisibleBefore = await page.locator('textarea').isVisible();
  await rpp.selectOption('100', { force: true }).catch(() => {});
  await page.waitForTimeout(500);
  report('S8.rppInQueryView', 'OBSERVE', `query view visible before=${qVisibleBefore} after rows/page change=${await page.locator('textarea').isVisible()}`);
  // clear recent files from the Welcome screen, after a confirmation
  for (let i = 0; i < 1; i++) { await page.locator('[title="Close tab"]').first().click(); await page.waitForTimeout(150); }
  check('S8.recentBefore', (await bridge.call('list_recent_files')).length > 0, 'a recent entry to clear');
  await page.evaluate(() => { window.confirm = () => false; });
  await page.click('button:has-text("Clear all")'); await page.waitForTimeout(200);
  check('S8.clearRecentDeclined', (await bridge.call('list_recent_files')).length > 0, 'declining the confirmation keeps the list');
  await page.evaluate(() => { window.confirm = () => true; });
  await page.click('button:has-text("Clear all")'); await page.waitForTimeout(200);
  check('S8.clearRecent', (await bridge.call('list_recent_files')).length === 0 && (await page.locator('button:has-text("Clear all")').count()) === 0, 'recent cleared in the store, the button gone with the list');
  // corrupt localStorage
  await page.evaluate(() => { localStorage.setItem('parqsee-settings', '{"rowsPerPage":"x"}'); });
  await page.reload(); await page.waitForTimeout(800);
  check('S8.corruptStorage', await page.locator('text=Drop your Parquet file here').isVisible(), `app survives corrupt localStorage; errors=${JSON.stringify(page.__errors.slice(0, 2)).slice(0, 200)}`);
});

// A corrupt store on disk must not keep the app from starting.
const CORRUPT_DATA = path.join(OUT, 'data', 's8-corrupt');
fs.rmSync(CORRUPT_DATA, { recursive: true, force: true }); fs.mkdirSync(CORRUPT_DATA, { recursive: true });
fs.writeFileSync(path.join(CORRUPT_DATA, 'bookmarks.json'), '{not json');
await scenario('S8-corrupt-store', async ({ page, bridge }) => {
  check('S8.corruptStore', await page.locator('text=Drop your Parquet file here').isVisible() && (await bridge.call('list_workspace_roots')).length === 0, `errors=${JSON.stringify(page.__errors.slice(0, 2)).slice(0, 200)}`);
  await openFile(page, `${FIX}/one_row.parquet`);
  check('S8.corruptStoreOverwritten', JSON.parse(fs.readFileSync(path.join(CORRUPT_DATA, 'bookmarks.json'), 'utf8')).recent.length === 1, 'the next change rewrites the store');
}, { dataDir: CORRUPT_DATA });

// ---------------------------------------------------------------- S9 file explorer
// The explorer browses workspace roots the user opens (Open Folder); both
// scenarios share a store directory so the second one acts out a relaunch.
const S9_DATA = path.join(OUT, 'data', 's9');
fs.rmSync(S9_DATA, { recursive: true, force: true });
/** Close the workspace root at `dir` from its row's hover button. */
async function removeRoot(page, dir) {
  const row = page.locator(`.py-1 .group[title="${dir}"]`).first();
  await row.scrollIntoViewIfNeeded(); await row.hover();
  await row.locator('[title="Remove folder from workspace"]').click();
  await page.waitForTimeout(300);
}
await scenario('S9-explorer', async ({ page, bridge }) => {
  // Rows of the tree, top to bottom: the root first, then what is expanded under it.
  const names = () => page.evaluate(() => [...document.querySelectorAll('.overflow-y-auto .py-1 .group')].map(d => d.textContent?.trim()).filter(Boolean));
  const crumbs = () => page.evaluate(() => [...document.querySelectorAll('nav[aria-label="breadcrumb"] button')].map(b => b.textContent));
  // No folder open yet: the welcome screen offers Open Folder; a dropped file shows an empty sidebar.
  await openFile(page, `${FIX}/one_row.parquet`);
  check('S9.emptyState', await page.locator('text=Open a folder to browse Parquet files').isVisible(), 'sidebar empty state with a file open but no folder');
  check('S9.noListingOutsideRoots', !bridge.log.some(l => l.cmd === 'list_directory'), `list_directory calls: ${bridge.log.filter(l => l.cmd === 'list_directory').length}`);
  await page.locator('[title="Close tab"]').first().click(); await page.waitForTimeout(200);
  check('S9.welcomeOpenFolder', await page.locator('button:has-text("Open Folder")').isVisible(), 'welcome screen has Open Folder');
  // Open the fixtures folder from the welcome screen.
  await openFolder(page, FIX);
  await page.waitForTimeout(400);
  const roots = await bridge.call('list_workspace_roots');
  check('S9.rootStored', roots.length === 1 && roots[0].path === FIX && roots[0].name === 'fixtures', JSON.stringify(roots));
  check('S9.workspaceWithoutTabs', await page.locator('text=Drop your Parquet file here').isVisible() && (await names())[0] === 'fixtures', 'tree next to the welcome content, no tab yet');
  const n1 = await names();
  report('S9.list', n1.length > 10 ? 'PASS' : 'FAIL', `explorer entries: ${n1.slice(0, 6)}… (${n1.length})`);
  check('S9.dirsFirst', n1[1]?.startsWith('paths'), `first entry under the root ${n1[1]}`);
  // expand paths
  await page.click('.py-1 >> text=paths'); await page.waitForTimeout(400);
  const n2 = await names();
  check('S9.expand', n2.some(n => n.includes('glob[1].parquet')), `expanded: contains glob[1]? ${n2.some(n => n.includes('glob[1]'))}`);
  report('S9.folderParquet', 'OBSERVE', `folder.parquet rendered as: ${await page.evaluate(() => { const el = [...document.querySelectorAll('.py-1 *')].find(e => e.textContent?.trim() === 'folder.parquet'); return el ? el.closest('div')?.outerHTML.slice(0, 200) : 'not found'; })}`);
  // noperm
  await page.click('.py-1 >> text=noperm'); await page.waitForTimeout(400);
  report('S9.noperm', 'OBSERVE', `clicking noperm dir: errors=${JSON.stringify(page.__errors.filter(e => e.includes('directory')).slice(0, 1))} any UI error=${await page.locator('text=/denied|error/i').count()}`);
  // click UPPER.PARQUET entry
  await page.click('.py-1 >> text=UPPER.PARQUET'); await page.waitForTimeout(500); await waitGrid(page);
  check('S9.openUpper', (await activeTabName(page)) === 'UPPER.PARQUET', `active=${await activeTabName(page)}`);
  // broken link
  await page.click('.py-1 >> text=broken_link.parquet'); await page.waitForTimeout(500);
  const al = await page.evaluate(() => window.__alerts.splice(0));
  check('S9.brokenLink', al.length === 1, `alerts=${al}`);
  // The breadcrumb starts at the root and stops there: no "/" above it.
  const c1 = await crumbs();
  check('S9.crumbBounded', c1.join('/') === 'fixtures/paths' && (await page.locator('nav[aria-label="breadcrumb"]').getAttribute('title')) === `${FIX}/paths`, `crumbs=${c1}`);
  // Collapse paths in the tree, then bring it back from the crumb.
  await page.click('.py-1 >> text=paths'); await page.waitForTimeout(200);
  check('S9.collapse', !(await names()).some(n => n.startsWith('UPPER.PARQUET')));
  await page.locator('nav[aria-label="breadcrumb"] button', { hasText: 'paths' }).click(); await page.waitForTimeout(400);
  check('S9.crumbReveal', (await names()).some(n => n.startsWith('UPPER.PARQUET')) && (await names()).some(n => n.startsWith('nan.parquet')), `tree after crumb click: ${(await names()).slice(0, 4)}`);
  // search box: the whole loaded tree, keeping the folders above a match
  await page.fill('input[placeholder="Filter files..."]', 'nan'); await page.waitForTimeout(200);
  const n3 = await names();
  check('S9.search', n3.length === 2 && n3[0] === 'fixtures' && n3[1].startsWith('nan.parquet'), `${n3}`);
  await page.fill('input[placeholder="Filter files..."]', 'GLOB'); await page.waitForTimeout(200);
  const n3b = await names();
  check('S9.searchDeep', n3b.length === 3 && n3b[1] === 'paths' && n3b[2].startsWith('glob[1]'), `case-insensitive, through the subfolder: ${n3b}`);
  await page.click('[title="Clear search"]');
  // context menu
  await page.click('.py-1 >> text=dict.parquet', { button: 'right' }); await page.waitForTimeout(200);
  check('S9.contextMenu', await page.locator('text="Open"').isVisible());
  await page.click('text="Open"'); await page.waitForTimeout(500); await waitGrid(page);
  check('S9.openNewTab', (await activeTabName(page)) === 'dict.parquet');
  await page.click('.py-1 >> text=dict.parquet', { button: 'right' }); await page.waitForTimeout(200);
  await page.click('text="Open"'); await page.waitForTimeout(300);
  report('S9.openNewTabDup', 'OBSERVE', `"Open" on an already-open file: tabs=${await page.evaluate(() => document.querySelectorAll('[title="Close tab"]').length)}`);
  // selecting a tab highlights the file in the explorer
  await page.click(`span[title="${FIX}/paths/UPPER.PARQUET"]`); await page.waitForTimeout(300);
  check('S9.highlight', (await page.evaluate(() => [...document.querySelectorAll('.py-1 .group.bg-selected')].map(d => d.textContent?.trim()))).some(n => n?.startsWith('UPPER.PARQUET')), `selected rows: ${await page.evaluate(() => [...document.querySelectorAll('.py-1 .group.bg-selected')].map(d => d.textContent?.trim().slice(0, 30)))}`);
  // A second root: the tree keeps the first one as it was.
  await openFolder(page, `${FIX}/paths/dir with space`);
  await page.waitForTimeout(300);
  const n4 = await names();
  check('S9.secondRoot', n4[0] === 'fixtures' && n4.includes('dir with space') && n4.some(n => n.startsWith('inner.parquet')) && n4.some(n => n.startsWith('UPPER.PARQUET')), `${n4.slice(-4)} (${n4.length})`);
  check('S9.rootsStored', (await bridge.call('list_workspace_roots')).length === 2);
  // Remove the second root from its row.
  await removeRoot(page, `${FIX}/paths/dir with space`);
  // (paths/dir with space is still listed as a subfolder of the first root; only its root row goes.)
  check('S9.removeRoot', (await page.locator(`.py-1 .group[title="${FIX}/paths/dir with space"]`).count()) === 0 && (await bridge.call('list_workspace_roots')).length === 1, `roots=${JSON.stringify(await bridge.call('list_workspace_roots'))}`);
  // hide sidebar
  await page.click('[title^="Hide sidebar"]');
  // The sidebar collapses to width 0 with overflow hidden; its children keep their own size, so
  // Playwright still reports them "visible" — assert on the collapsed container instead.
  const collapsed = await page.waitForFunction(() => {
    const input = document.querySelector('input[placeholder="Filter files..."]');
    return input?.closest('.overflow-hidden')?.clientWidth === 0;
  }, null, { timeout: 2000 }).then(() => true, () => false);
  check('S9.hideSidebar', collapsed);
  await page.screenshot({ path: `${OUT}/shots/S9.png` });
}, { dataDir: S9_DATA });

// "Relaunch": a fresh browser and bridge on the same store. The tabs open
// at the end of S9-explorer come back too (S11 covers that in depth).
await scenario('S9-restore', async ({ page, bridge }) => {
  const roots = await bridge.call('list_workspace_roots');
  check('S9r.rootRestored', roots.length === 1 && roots[0].path === FIX, JSON.stringify(roots));
  const rootRow = page.locator(`.py-1 .group[title="${FIX}"]`);
  await rootRow.waitFor({ timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelectorAll('[title="Close tab"]').length === 2, null, { timeout: 15000 }).catch(() => {});
  check('S9r.workspaceOnLaunch', await rootRow.isVisible() && (await tabNames(page)).join(',') === 'UPPER.PARQUET,dict.parquet', `the tree is back, and so are the tabs: ${await tabNames(page)}`);
  await page.waitForTimeout(400);
  check('S9r.treeLoaded', (await page.evaluate(() => [...document.querySelectorAll('.overflow-y-auto .py-1 .group')].length)) > 10, 'root expanded and listed');
  const recent = (await bridge.call('list_recent_files')).map(f => f.name);
  check('S9r.recentRestored', recent.includes('UPPER.PARQUET') && recent.includes('dict.parquet'), `recent=${recent}`);
  check('S9r.recentUi', await page.locator('text=UPPER.PARQUET').first().isVisible(), 'recent files listed next to the tree');
  await page.locator('.py-1 >> text=dict.parquet').click(); await page.waitForTimeout(500); await waitGrid(page);
  check('S9r.openFromTree', (await activeTabName(page)) === 'dict.parquet');
  // Removing the last root with a tab open keeps the workspace, with the empty sidebar.
  await removeRoot(page, FIX);
  check('S9r.removeLastRoot', await page.locator('text=Open a folder to browse Parquet files').isVisible() && (await activeTabName(page)) === 'dict.parquet', 'empty sidebar, tab stays');
  while (await page.locator('[title="Close tab"]').count()) {
    await page.locator('[title="Close tab"]').first().click(); await page.waitForTimeout(300);
  }
  check('S9r.welcomeAgain', await page.locator('text=Drop your Parquet file here').isVisible() && !(await page.locator('[title^="Hide sidebar"]').isVisible()), 'no roots, no tabs: the welcome screen');
}, { dataDir: S9_DATA });

// ---------------------------------------------------------------- S10 the file changes under an open tab
await scenario('S10-external-change', async ({ page }) => {
  const dir = `${OUT}/external`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  const target = `${dir}/changing.parquet`;
  fs.copyFileSync(`${FIX}/multi_rowgroup.parquet`, target);
  await openFile(page, target);
  check('S10.open', (await footer(page))?.includes('100,000'), await footer(page));
  const errorScreen = () => page.locator('text=Error Loading File').waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false);
  const refresh = () => act(page).locator('button:has-text("Refresh")').first().click();

  // Replaced on disk: Refresh drops the cached session and shows the new contents.
  fs.copyFileSync(`${FIX}/one_row.parquet`, target);
  await refresh(); await waitGrid(page); await page.waitForTimeout(200);
  check('S10.replaced', (await footer(page))?.includes('of 1 ') && (await visibleHeader(page)).includes('only'), `footer=${await footer(page)} cols=${await visibleHeader(page)}`);

  // Deleted: Refresh shows the file-level error naming the path, and Close drops the tab.
  fs.rmSync(target);
  await refresh();
  const shown = await errorScreen();
  const message = shown ? await act(page).locator('text=Error Loading File').locator('xpath=following-sibling::p').first().textContent() : null;
  check('S10.deleted', shown && message?.includes('changing.parquet'), `errorScreen=${shown} message=${message}`);
  await act(page).locator('button:has-text("Close")').first().click(); await page.waitForTimeout(300);
  check('S10.closeAfterError', await page.evaluate(() => document.querySelectorAll('[title="Close tab"]').length) === 0, 'tab gone after Close');
});

// ---------------------------------------------------------------- S11 session restore
// Three tabs — one on its second page, one in the query view — with the
// middle one active; the relaunch below shares the store. The middle file
// is a copy that is deleted between the launches.
const S11_DATA = path.join(OUT, 'data', 's11');
fs.rmSync(S11_DATA, { recursive: true, force: true });
const S11_DIR = `${OUT}/session`; fs.rmSync(S11_DIR, { recursive: true, force: true }); fs.mkdirSync(S11_DIR);
const S11_GONE = `${S11_DIR}/gone.parquet`;
fs.copyFileSync(`${FIX}/dict.parquet`, S11_GONE);
const queryViewShown = (page) => act(page).locator('button:has-text("Run")').isVisible().catch(() => false);
const sessionPaths = (s) => s.tabs.map(t => `${t.path.split('/').pop()}${t.available ? '' : '(gone)'}`);

await scenario('S11-session', async ({ page, bridge }) => {
  await openFile(page, `${FIX}/multi_rowgroup.parquet`);
  await act(page).locator('button:has-text("Next")').first().click(); await waitGrid(page);
  check('S11.page2', (await footer(page))?.startsWith('Showing 51 to 100'), await footer(page));
  await openFile(page, S11_GONE);
  await openFile(page, `${FIX}/one_row.parquet`);
  await act(page).locator('button:has-text("Query")').first().click(); await page.waitForTimeout(200);
  check('S11.queryView', await queryViewShown(page), 'one_row.parquet switched to the query view');
  await page.locator(`span[title="${S11_GONE}"]`).click(); await page.waitForTimeout(300);
  check('S11.activeMiddle', (await activeTabName(page)) === 'gone.parquet', `active=${await activeTabName(page)}`);
  // Saved a moment after the last change.
  await page.waitForTimeout(600);
  const saved = await bridge.call('list_session_tabs');
  check('S11.saved', sessionPaths(saved).join(',') === 'multi_rowgroup.parquet,gone.parquet,one_row.parquet' && saved.active === S11_GONE, `${sessionPaths(saved)} active=${saved.active}`);
  check('S11.savedState', saved.tabs[0].state.current_page === 2 && saved.tabs[2].state.view_mode === 'query', JSON.stringify(saved.tabs.map(t => t.state)));
  check('S11.recentUntouched', (await bridge.call('list_recent_files')).map(f => f.name).join(',') === 'one_row.parquet,gone.parquet,multi_rowgroup.parquet', 'recent files are the opens, newest first');
}, { dataDir: S11_DATA });

fs.rmSync(S11_GONE);

// "Relaunch": the two surviving tabs come back as they were; the deleted
// file's tab does not, and the notice says so.
await scenario('S11-session-restore', async ({ page, bridge }) => {
  await page.waitForFunction(() => document.querySelectorAll('[title="Close tab"]').length === 2, null, { timeout: 15000 }).catch(() => {});
  await waitGrid(page);
  check('S11r.tabs', (await tabNames(page)).join(',') === 'multi_rowgroup.parquet,one_row.parquet', `tabs=${await tabNames(page)}`);
  check('S11r.activeFallsBackToFirst', (await activeTabName(page)) === 'multi_rowgroup.parquet', `active=${await activeTabName(page)} (the active tab's file is gone)`);
  check('S11r.page2', (await footer(page))?.startsWith('Showing 51 to 100'), await footer(page));
  const notice = page.locator('[data-testid="restore-notice"]');
  check('S11r.notice', await notice.isVisible() && (await notice.textContent())?.includes('1 file from the last session could not be reopened') && (await notice.textContent())?.includes('gone.parquet'), `notice=${await notice.textContent().catch(() => null)}`);
  check('S11r.recentUntouched', (await bridge.call('list_recent_files')).map(f => f.name).join(',') === 'one_row.parquet,gone.parquet,multi_rowgroup.parquet' && !bridge.log.some(l => l.cmd === 'remember_file'), `remember_file calls: ${bridge.log.filter(l => l.cmd === 'remember_file').length}`);
  await page.locator(`span[title="${FIX}/one_row.parquet"]`).click(); await page.waitForTimeout(300);
  check('S11r.queryView', (await activeTabName(page)) === 'one_row.parquet' && await queryViewShown(page), 'one_row.parquet is back in the query view');
  await notice.locator('button[aria-label="Dismiss"]').click();
  check('S11r.dismiss', !(await notice.isVisible()));
  // The first save after the restore drops the missing file.
  await page.waitForTimeout(600);
  const saved = await bridge.call('list_session_tabs');
  check('S11r.pruned', sessionPaths(saved).join(',') === 'multi_rowgroup.parquet,one_row.parquet' && saved.active === `${FIX}/one_row.parquet`, `${sessionPaths(saved)} active=${saved.active}`);
  await page.screenshot({ path: `${OUT}/shots/S11.png` });
}, { dataDir: S11_DATA });

// With the setting off nothing is restored, and nothing is even asked for.
await scenario('S11-session-off', async ({ page, bridge }) => {
  await page.waitForTimeout(800);
  check('S11o.welcome', await page.locator('text=Drop your Parquet file here').isVisible() && (await tabNames(page)).length === 0, 'the welcome screen, no tabs');
  check('S11o.notAsked', !bridge.log.some(l => l.cmd === 'list_session_tabs'), `commands: ${[...new Set(bridge.log.map(l => l.cmd))]}`);
}, { dataDir: S11_DATA, localStorage: { 'parqsee-settings': JSON.stringify({ restoreTabs: false }) } });

// ---------------------------------------------------------------- S12 opening from Finder
// Double-click / Dock drop / `open -a` reach the webview as the same
// `file-drop` event a drag and drop does (`deliver_opened` in lib.rs). Cold
// start — the event arrives before the webview listens — is acted out by
// seeding the bridge's PendingOpen; warm start is the event itself.
const S12_DATA = path.join(OUT, 'data', 's12');
fs.rmSync(S12_DATA, { recursive: true, force: true });
const S12_JA = `${FIX}/paths/日本語ファイル.parquet`;
const S12_HASH = `${FIX}/paths/hash#1.parquet`;

// One tab, so the relaunch below has a session to restore first.
await scenario('S12-finder-seed', async ({ page }) => {
  await openFile(page, `${FIX}/multi_rowgroup.parquet`);
  await page.waitForTimeout(600);
}, { dataDir: S12_DATA });

await scenario('S12-finder', async ({ page, bridge }) => {
  await page.waitForFunction(() => document.querySelectorAll('[title="Close tab"]').length === 2, null, { timeout: 15000 }).catch(() => {});
  await waitGrid(page);
  check('S12.coldTabs', (await tabNames(page)).join(',') === 'multi_rowgroup.parquet,日本語ファイル.parquet', `tabs=${await tabNames(page)}`);
  check('S12.coldActive', (await activeTabName(page)) === '日本語ファイル.parquet', `active=${await activeTabName(page)} (the file must not be pushed behind the restored tabs)`);
  check('S12.coldGrid', (await footer(page))?.startsWith('Showing 1 to 3'), await footer(page));
  const cmds = bridge.log.map(l => l.cmd);
  check('S12.askedOnceAfterRestore',
    cmds.filter(c => c === 'take_pending_files').length === 1 && cmds.indexOf('take_pending_files') > cmds.indexOf('list_session_tabs'),
    `command order: ${cmds.join(',')}`);
  // The same path a manual open takes: under the sandbox this is what makes
  // the bookmark, so Recent Files can reopen it after a relaunch.
  check('S12.recorded', (await bridge.call('list_recent_files'))[0]?.path === S12_JA, `recent=${(await bridge.call('list_recent_files')).map(f => f.name)}`);

  // Warm start: the window is already up.
  await finderOpen(page, [S12_HASH]);
  await page.waitForFunction(() => document.querySelectorAll('[title="Close tab"]').length === 3, null, { timeout: 15000 }).catch(() => {});
  await waitGrid(page);
  check('S12.warm', (await activeTabName(page)) === 'hash#1.parquet' && (await footer(page))?.startsWith('Showing 1 to 3'), `active=${await activeTabName(page)} footer=${await footer(page)}`);

  // `open -a Parqsee notes.csv` reaches the same handler.
  await finderOpen(page, [`${OUT}/notes.csv`]);
  await page.waitForTimeout(300);
  const alerts = await page.evaluate(() => window.__alerts);
  check('S12.notParquet', (await tabNames(page)).length === 3 && alerts.includes('Parqsee can only open .parquet files'), `tabs=${(await tabNames(page)).length} alerts=${JSON.stringify(alerts)}`);
  await page.screenshot({ path: `${OUT}/shots/S12.png` });
}, { dataDir: S12_DATA, pendingFiles: [S12_JA] });

// ---------------------------------------------------------------- S13 the bundled sample file
// "Open the sample file" on the Welcome screen, for anyone with no Parquet
// file at hand (App Store reviewers, #16). The bridge answers
// `sample_file_path` with the checkout's backend/resources/sample.parquet —
// the same bytes the bundle carries. A tab like any other, kept in the
// session, but never in Recent Files.
const S13_DATA = path.join(OUT, 'data', 's13');
fs.rmSync(S13_DATA, { recursive: true, force: true });
const S13_SAMPLE = path.join(ROOT, 'backend', 'resources', 'sample.parquet');

await scenario('S13-sample', async ({ page, bridge }) => {
  await openFile(page, `${FIX}/one_row.parquet`);
  // From the workspace's welcome content (a folder is not needed: the
  // welcome content also shows when tabs are closed), and from the Welcome
  // screen proper — both carry the link.
  await page.locator('[title="Close tab"]').first().click();
  await page.locator('button:has-text("Open the sample file")').first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('h1')].some(h => h.textContent === 'sample.parquet' && h.offsetParent !== null), null, { timeout: 15000 });
  await waitGrid(page);
  check('S13.path', bridge.log.some(l => l.cmd === 'open_parquet_file' && l.args.path === S13_SAMPLE), `open_parquet_file paths: ${bridge.log.filter(l => l.cmd === 'open_parquet_file').map(l => l.args.path)}`);
  check('S13.grid', (await summary(page))?.startsWith('1,500 rows') && (await footer(page))?.startsWith('Showing 1 to 50'), `summary=${await summary(page)} footer=${await footer(page)}`);
  const cols = await visibleHeader(page);
  check('S13.columns', cols[0] === 'order_id' && cols.includes('unit_price') && cols.includes('shipped_at'), `columns=${cols}`);
  check('S13.notRecent', !bridge.log.some(l => l.cmd === 'remember_file' && l.args.path === S13_SAMPLE) && (await bridge.call('list_recent_files')).every(f => f.name !== 'sample.parquet'), `recent=${(await bridge.call('list_recent_files')).map(f => f.name)}`);

  // Clicking the link again with the sample open only activates its tab.
  await openFile(page, `${FIX}/one_row.parquet`);
  await page.locator('span[title="' + S13_SAMPLE + '"]').click();
  await page.waitForTimeout(200);
  check('S13.oneTab', (await tabNames(page)).join(',') === 'sample.parquet,one_row.parquet', `tabs=${await tabNames(page)}`);
  await page.waitForTimeout(600);
  const saved = await bridge.call('list_session_tabs');
  check('S13.session', sessionPaths(saved).join(',') === 'sample.parquet,one_row.parquet' && saved.active === S13_SAMPLE, `${sessionPaths(saved)} active=${saved.active}`);
  await page.screenshot({ path: `${OUT}/shots/S13.png` });
}, { dataDir: S13_DATA });

await scenario('S13-sample-restore', async ({ page }) => {
  await page.waitForFunction(() => document.querySelectorAll('[title="Close tab"]').length === 2, null, { timeout: 15000 }).catch(() => {});
  await waitGrid(page);
  check('S13r.tabs', (await tabNames(page)).join(',') === 'sample.parquet,one_row.parquet' && (await activeTabName(page)) === 'sample.parquet', `tabs=${await tabNames(page)} active=${await activeTabName(page)}`);
  check('S13r.grid', (await summary(page))?.startsWith('1,500 rows'), await summary(page));
}, { dataDir: S13_DATA });

console.log('\n\n===== SUMMARY =====');
for (const r of results) console.log(`${r.status.padEnd(7)} ${r.id}  ${r.note ?? ''}`);
fs.writeFileSync(`${OUT}/suite_results.json`, JSON.stringify(results, null, 2));
const failed = results.filter(r => r.status === 'FAIL' || r.status === 'ERROR').length;
console.log(`\n${results.filter(r => r.status === 'PASS').length} PASS, ${failed} FAIL/ERROR, ${results.filter(r => r.status === 'OBSERVE').length} OBSERVE`);
process.exit(failed ? 1 : 0);
