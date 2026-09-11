// The free tier and the purchase, photographed: every state of the Free
// badge, the upgrade prompt, the restore notice and Settings › Purchase, in
// en/ja × light/dark. Not a test — it asserts nothing. This is how those
// screens are looked at while they are being worked on: `pnpm tauri dev`
// and the bridge own the full version, and the signed store build shows the
// price only once the product exists in App Store Connect, so the App Store
// here is the scripted one from lib.mjs (`launch({ iap })`).
//
//   pnpm shots:license                  # 1280×800 @1x, en+ja, light+dark -> out/shots/license/
//   LANGS=en THEMES=light pnpm shots:license
//   SCALE=2 pnpm shots:license          # the App Store's @2x size
//
// Scenes: welcome (the badge on the Welcome screen), tabs (the badge in the
// tab bar with the limit reached), prompt (the price), prompt-cancelled,
// prompt-error, prompt-pending, settings-free, unlocked (past the limit,
// no badge), settings-unlocked, prompt-no-price (the store has no product:
// what an unsigned build sees today), prompt-price-error (the products
// call was rejected), prompt-store-error (the entitlements could not be
// read), restore-capped (a relaunch on the free tier with more tabs saved
// than it keeps).
import path from 'node:path';
import { launch, dropFile, waitGrid, setStore, pushIapStatus, shotConfig, shotSettings, shooter, shootAll, DEMO_FILES, FREE_STORE, OUT } from './lib.mjs';

const CONFIG = shotConfig({ scale: 1 });
const { W, H, SCALE } = CONFIG;
const SHOTS = path.join(OUT, 'shots', 'license');

// The strings the harness reads. The UI is localized, so a selector built
// from English text finds nothing in the Japanese run.
const T = {
  en: { settings: 'Settings' },
  ja: { settings: '設定' },
};

const prompt = (page) => page.locator('[data-testid="upgrade-prompt"]');
const buyButton = (page) => prompt(page).locator('button.btn-primary').first();
const badge = (page) => page.locator('[data-testid="free-badge"]');

async function openTabs(page, files) {
  for (const file of files) {
    await dropFile(page, file);
    await page.waitForFunction((n) => [...document.querySelectorAll('h1')].some(h => h.textContent === n && h.offsetParent !== null), path.basename(file), { timeout: 15000 });
    await waitGrid(page);
  }
}

async function openPrompt(page) {
  await badge(page).click();
  await prompt(page).waitFor({ timeout: 5000 });
  await page.waitForTimeout(200);
}

async function closePrompt(page) {
  await page.keyboard.press('Escape');
  await prompt(page).waitFor({ state: 'detached', timeout: 5000 });
}

async function openSettings(page, L) {
  await page.locator(`[title^="${L.settings}"]`).first().click();
  await page.locator('[data-testid="purchase-status"]').waitFor({ timeout: 5000 });
  await page.waitForTimeout(200);
}

async function run(lang, theme) {
  console.log(`${lang} / ${theme}`);
  const shoot = shooter(SHOTS, CONFIG, lang, theme);
  const L = T[lang];
  const opts = { viewport: { width: W, height: H }, deviceScaleFactor: SCALE, localStorage: shotSettings(lang, theme) };

  // The free tier from the Welcome screen to the purchase.
  {
    const { page, close } = await launch({ ...opts, iap: { ...FREE_STORE } });
    try {
      await page.waitForTimeout(300);
      await shoot(page, 'welcome');

      await openTabs(page, DEMO_FILES.slice(0, 3));
      await page.waitForTimeout(300);
      await shoot(page, 'tabs');

      // The fourth file: the prompt, and no tab.
      await dropFile(page, DEMO_FILES[3]);
      await prompt(page).waitFor({ timeout: 5000 });
      await page.waitForTimeout(300);
      await shoot(page, 'prompt');
      await closePrompt(page);

      await setStore(page, { purchaseOutcome: 'cancelled' });
      await openPrompt(page);
      await buyButton(page).click();
      await page.waitForTimeout(300);
      await shoot(page, 'prompt-cancelled');
      await closePrompt(page);

      await setStore(page, { purchaseError: 'The App Store is not reachable right now.' });
      await openPrompt(page);
      await buyButton(page).click();
      await prompt(page).locator('[role="alert"]').waitFor({ timeout: 5000 });
      await page.waitForTimeout(200);
      await shoot(page, 'prompt-error');
      await closePrompt(page);

      await setStore(page, { purchaseError: null, purchaseOutcome: 'pending' });
      await openPrompt(page);
      await buyButton(page).click();
      await prompt(page).locator('[role="status"]').waitFor({ timeout: 5000 });
      await page.waitForTimeout(200);
      await shoot(page, 'prompt-pending');
      await closePrompt(page);

      await openSettings(page, L);
      await shoot(page, 'settings-free');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);

      // The purchase goes through: the prompt closes, the badge goes, the
      // fourth and fifth files open.
      await setStore(page, { purchaseOutcome: 'purchased' });
      await openPrompt(page);
      await buyButton(page).click();
      await prompt(page).waitFor({ state: 'detached', timeout: 5000 });
      await openTabs(page, DEMO_FILES.slice(3));
      await page.waitForTimeout(300);
      await shoot(page, 'unlocked');

      await openSettings(page, L);
      await shoot(page, 'settings-unlocked');

      if (page.__errors.length) console.log('  errors:', page.__errors);
    } finally {
      await close();
    }
  }

  // The prompt over a store that has no product, one whose products call
  // fails, and one whose entitlements could not be read. Each needs its own
  // launch: the products are fetched once and kept.
  const variants = [
    ['prompt-no-price', { products: [] }],
    ['prompt-price-error', { productsError: 'The request timed out.' }],
    ['prompt-store-error', { status: { state: 'free', store_error: 'The receipt could not be verified.', has_store: true } }],
  ];
  for (const [scene, patch] of variants) {
    const { page, close } = await launch({ ...opts, iap: { ...FREE_STORE, ...patch } });
    try {
      await page.waitForTimeout(300);
      await openPrompt(page);
      await page.waitForTimeout(300);
      await shoot(page, scene);
      if (page.__errors.length) console.log('  errors:', page.__errors);
    } finally {
      await close();
    }
  }

  // A relaunch on the free tier with four tabs saved: three come back, the
  // fourth is named in the restore notice. The session is written unlocked
  // (the bridge's own store) so four tabs can be saved at all.
  {
    const first = await launch({ ...opts });
    let dataDir;
    try {
      dataDir = first.dataDir;
      await openTabs(first.page, DEMO_FILES.slice(0, 4));
      await first.page.waitForTimeout(600); // the session is saved 250 ms after a change
    } finally {
      await first.close();
    }
    const { page, close } = await launch({ ...opts, dataDir, iap: { ...FREE_STORE } });
    try {
      await page.locator('[data-testid="restore-notice-capped"]').waitFor({ timeout: 15000 });
      await waitGrid(page);
      await page.waitForTimeout(300);
      await shoot(page, 'restore-capped');
      // A refund, or a purchase approved on another device, arrives from
      // the store while the window is up.
      await pushIapStatus(page, { state: 'unlocked', store_error: null, has_store: true });
      await page.waitForTimeout(300);
      await shoot(page, 'restore-capped-unlocked');
      if (page.__errors.length) console.log('  errors:', page.__errors);
    } finally {
      await close();
    }
  }
}

await shootAll(SHOTS, CONFIG, run);
