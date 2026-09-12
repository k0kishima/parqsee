import fs from 'node:fs';
import { launch, report, results, OUT } from './lib.mjs';

// WebKit's Playwright screenshot preparation injects `body {}` to sync
// animations, even with caret: 'initial'. Permit only ONE exact diagnostic
// produced during this call; other CSP violations remain failures.
const SCREENSHOT_CSP_ERROR = "console: Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' appears in neither the style-src directive nor the default-src directive of the Content Security Policy.";
export async function screenshot(page, options = {}) {
  const start = page.__errors.length;
  try { return await page.screenshot(options); }
  finally {
    const index = page.__errors.indexOf(SCREENSHOT_CSP_ERROR, start);
    if (index !== -1) {
      page.__errors.splice(index, 1);
      report('screenshot/playwright-csp', 'OBSERVE', 'One WebKit screenshot stylesheet was blocked by CSP');
    }
  }
}

// Consume exactly one console message at the negative test that expects it.
// Uncaught exceptions and any additional messages remain failures.
export function expectConsoleError(page, message) {
  if (!message) throw new Error('An expected console error must not be empty');
  const index = page.__errors.indexOf(`console: ${message}`);
  if (index === -1) throw new Error(`Expected console error was not emitted: ${message}`);
  page.__errors.splice(index, 1);
  report('expected-console-error', 'PASS', message);
}

export async function scenario(name, fn, opts) {
  if (process.env.ONLY && !name.startsWith(process.env.ONLY)) return;
  console.log(`\n### ${name}`);
  let h;
  try {
    h = await launch(opts);
    await fn(h);
  } catch (e) {
    report(`${name}/exception`, 'ERROR', String(e));
    if (h) await screenshot(h.page, { path: `${OUT}/shots/${name}-error.png` }).catch(() => {});
  } finally {
    if (h) {
      try { await h.close(); }
      catch (e) { report(`${name}/cleanup`, 'ERROR', String(e)); }
      // Check after teardown too; keep every message in suite_results.json.
      if (h.page.__errors.length) report(`${name}/page-errors`, 'FAIL', JSON.stringify(h.page.__errors));
    }
  }
}

export function finishSuite() {
  console.log('\n\n===== SUMMARY =====');
  for (const r of results) console.log(`${r.status.padEnd(7)} ${r.id}  ${r.note ?? ''}`);
  fs.writeFileSync(`${OUT}/suite_results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter(r => r.status === 'FAIL' || r.status === 'ERROR').length;
  console.log(`\n${results.filter(r => r.status === 'PASS').length} PASS, ${failed} FAIL/ERROR, ${results.filter(r => r.status === 'OBSERVE').length} OBSERVE`);
  process.exitCode = failed ? 1 : 0;
}
