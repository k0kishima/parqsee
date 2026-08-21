// Large-file timing: open the gen_huge.py file, jump to the last page, and
// report how long the page read and the render took. Use BRIDGE_BIN with a
// release build for representative numbers.
import { launch, dropFile, waitGrid, gridRows, FIX, OUT } from './lib.mjs';
const HUGE = process.env.HUGE ?? `${FIX}/huge.parquet`;
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
const active = 'div[style*="position: absolute"][style*="display: flex"]';
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
console.log('errors:', page.__errors);
await close();
