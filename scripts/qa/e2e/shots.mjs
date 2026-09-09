// Demo screenshots of the real app: the site's hero (#7) and the App Store
// listing (#16). Not a test — it asserts nothing; it drives the same harness
// the suite drives (real backend through the bridge, real frontend in WebKit)
// so what it captures is the app and not a mockup.
//
// The data is the bundled sample (`backend/resources/sample.parquet`, 1,500
// orders of a fictional web shop) — the file reviewers are pointed at — laid
// out as a folder of orders files by `writeDemoData` in lib.mjs, because the
// explorer needs a folder. The free tier's screens are `license-shots.mjs`.
//
// The App Store wants 1280×800, 1440×900, 2560×1600 and 2880×1800: the last
// two are the first two at @2x, which is what SCALE=2 (the default) captures.
//
//   pnpm shots                          # 1280×800 @2x -> 2560×1600, en+ja, light+dark
//   SIZE=1440x900 pnpm shots            # -> 2880×1800
//   SIZE=1280x800 SCALE=1 pnpm shots    # the 1x sizes
//   LANGS=en THEMES=light pnpm shots    # one combination
import fs from 'node:fs';
import path from 'node:path';
import { launch, waitGrid, writeDemoData, DEMO, OUT } from './lib.mjs';

const [W, H] = (process.env.SIZE ?? '1280x800').split('x').map(Number);
const SCALE = Number(process.env.SCALE ?? 2);
const LANGS = (process.env.LANGS ?? 'en,ja').split(',');
const THEMES = (process.env.THEMES ?? 'light,dark').split(',');

const SHOTS = path.join(OUT, 'shots', 'demo');

// The strings the harness clicks. The UI is localized, so a selector built
// from English text finds nothing in the Japanese run.
const T = {
  en: { openFolder: 'Open Folder', query: 'Query', run: 'Run' },
  ja: { openFolder: 'フォルダを開く', query: 'クエリ', run: '実行' },
};

const SQL = `SELECT country, category, COUNT(*) AS orders, ROUND(SUM(total), 2) AS revenue
FROM t
GROUP BY country, category
ORDER BY revenue DESC`;

/** An explorer row by its file name: only roots carry a `title`. */
const entry = (page, name) =>
  page.locator('div.group', { has: page.locator(`span:text-is("${name}")`) }).first();

async function shoot(page, lang, theme, scene) {
  const name = `${lang}-${theme}-${scene}-${W * SCALE}x${H * SCALE}.png`;
  await page.screenshot({ path: path.join(SHOTS, name) });
  console.log('  ' + name);
}

async function run(lang, theme) {
  console.log(`${lang} / ${theme}`);
  const { page, close } = await launch({
    viewport: { width: W, height: H },
    deviceScaleFactor: SCALE,
    localStorage: {
      'parqsee-settings': JSON.stringify({ theme, language: lang, rowsPerPage: 50 }),
    },
  });
  const L = T[lang];
  try {
    // 1. The Welcome screen, as the app opens with no history.
    await page.waitForTimeout(300);
    await shoot(page, lang, theme, 'welcome');

    // 2. The explorer and the grid: a folder open in the sidebar, a file in a tab.
    await page.evaluate((p) => { window.__dialog.open = p; }, DEMO);
    await page.locator(`button:has-text("${L.openFolder}")`).first().click();
    await page.waitForFunction((d) => [...document.querySelectorAll('div.group')].some(el => el.getAttribute('title') === d), DEMO, { timeout: 5000 });
    await entry(page, 'orders').click();      // expand the subfolder, so the tree has depth
    await page.waitForTimeout(300);
    await entry(page, 'orders.parquet').click();
    await waitGrid(page);
    await page.waitForTimeout(300);
    await shoot(page, lang, theme, 'viewer');

    // 3. The SQL view over the same file (registered as table `t`).
    await page.locator(`button:has-text("${L.query}")`).first().click();
    await page.waitForTimeout(200);
    await page.locator('textarea').first().fill(SQL);
    await page.locator(`button:has-text("${L.run}")`).first().click();
    await waitGrid(page);
    await page.waitForTimeout(400);
    await shoot(page, lang, theme, 'query');

    if (page.__errors.length) console.log('  errors:', page.__errors);
  } finally {
    await close();
  }
}

writeDemoData();
fs.mkdirSync(SHOTS, { recursive: true });
for (const lang of LANGS) for (const theme of THEMES) await run(lang, theme);
console.log(`\n${SHOTS}`);
