// Smallest possible end-to-end check: drop one file, print what the grid shows.
import { launch, dropFile, waitGrid, gridRows, headerCols, FIX, OUT } from './lib.mjs';

const { page, close } = await launch();
await dropFile(page, `${FIX}/one_row.parquet`);
// The Welcome screen has an h1 too; wait for the tab's, which carries the file name.
await page.waitForSelector('h1:has-text("one_row.parquet")', { timeout: 10000 });
await waitGrid(page);
console.log('h1:', await page.textContent('h1'));
console.log('cols:', await headerCols(page));
console.log('rows:', await gridRows(page));
await page.screenshot({ path: `${OUT}/shots/smoke.png` });
console.log('errors:', page.__errors);
await close();
