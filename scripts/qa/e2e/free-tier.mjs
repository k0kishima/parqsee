// The app on the free tier, in a window you can click around in. Not a
// test: `pnpm tauri dev` owns the full version and never shows the badge,
// the prompt or the limit, so this drives the dev server in a headed WebKit
// with the scripted App Store from lib.mjs (`launch({ iap })`) — the price
// shows, Buy unlocks, Restore does nothing unless OWNED=1. There is no
// Finder to drop files from: Open Folder is answered with the demo folder
// (the sample as a few orders files), and paths given as arguments are
// opened at launch.
//
//   pnpm free-tier                          # Welcome screen, free, en / light
//   UI_LANG=ja THEME=dark pnpm free-tier
//   pnpm free-tier ~/data/a.parquet ~/data/b.parquet   # opened at launch
//   NO_PRICE=1 pnpm free-tier               # the store has no product (an unsigned build)
//   OWNED=1 pnpm free-tier                  # Restore Purchases unlocks
//
// Press Enter here to close the window.
import { stdin } from 'node:process';
import { launch, dropFile, writeDemoData, DEMO, FREE_STORE } from './lib.mjs';

const lang = process.env.UI_LANG ?? 'en';
const theme = process.env.THEME ?? 'light';
const files = process.argv.slice(2);

writeDemoData();
const { page, close } = await launch({
  headless: false,
  localStorage: { 'parqsee-settings': JSON.stringify({ theme, language: lang, rowsPerPage: 50 }) },
  iap: { ...FREE_STORE, products: process.env.NO_PRICE ? [] : FREE_STORE.products, owned: !!process.env.OWNED },
});
await page.evaluate((p) => { window.__dialog.open = p; }, DEMO);
for (const f of files) {
  await dropFile(page, f);
  await page.waitForTimeout(500);
}
console.log(`free tier up (${lang}/${theme}); Open Folder answers with ${DEMO}. Press Enter to close.`);
await new Promise((resolve) => { stdin.once('data', resolve); page.on('close', resolve); });
await close();
process.exit(0);
