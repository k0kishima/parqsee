// Exercise the real event listeners AND the child suite's exit status.
// Requires the same server, WebKit and Rust bridge as `pnpm suite`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function run(body) {
  const out = mkdtempSync(path.join(tmpdir(), 'parqsee-error-gate-'));
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { scenario, expectConsoleError, finishSuite, screenshot } from './runner.mjs';
      ${body}
      finishSuite();
    `], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: { ...process.env, ONLY: '', E2E_OUT: out },
      encoding: 'utf8', timeout: 60000,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    const results = JSON.parse(readFileSync(path.join(out, 'suite_results.json'), 'utf8'));
    return { status: child.status, results, output: child.stdout + child.stderr };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test('uncaught exceptions, rejected promises and console errors fail the suite', () => {
  const result = run(`
    await scenario('injected', async ({ page }) => {
      await page.evaluate(() => {
        setTimeout(() => { throw new Error('injected exception'); }, 0);
        void Promise.reject(new Error('injected rejection'));
        console.error('injected console error');
      });
      await page.waitForTimeout(200);
    });
  `);
  assert.equal(result.status, 1, result.output);
  const failure = result.results.find(r => r.id === 'injected/page-errors');
  assert.equal(failure?.status, 'FAIL', result.output);
  for (const text of ['injected exception', 'injected rejection', 'injected console error']) {
    assert.ok(failure.note.includes(text), result.output);
  }
});

test('an explicitly expected console error and a screenshot pass', () => {
  const result = run(`
    await scenario('expected', async ({ page }) => {
      await page.evaluate(() => console.error('expected failure'));
      expectConsoleError(page, 'expected failure');
      await screenshot(page);
    });
  `);
  assert.equal(result.status, 0, result.output);
  assert.ok(result.results.some(r => r.id === 'expected-console-error'), result.output);
});

test('expected errors cannot hide duplicates, missing errors, or CSP violations', () => {
  const result = run(`
    await scenario('duplicate', async ({ page }) => {
      await page.evaluate(() => { console.error('expected'); console.error('expected'); });
      expectConsoleError(page, 'expected');
    });
    await scenario('missing', async ({ page }) => {
      expectConsoleError(page, 'never emitted');
    });
    await scenario('csp', async ({ page }) => {
      // Use a document with its own CSP so this test also works on Vite.
      await page.setContent('<meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;">');
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = 'body { color: red }';
        document.head.append(style);
      });
      await page.waitForTimeout(200);
      await screenshot(page);
    });
    await scenario('csp-during-screenshot', async ({ page }) => {
      await page.setContent('<meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;">');
      // This adds a second forbidden stylesheet during screenshot preparation.
      await screenshot(page, { style: 'body { color: red }' });
    });
  `);
  assert.equal(result.status, 1, result.output);
  for (const id of ['duplicate/page-errors', 'missing/exception', 'csp/page-errors', 'csp-during-screenshot/page-errors']) {
    assert.ok(result.results.some(r => r.id === id && ['FAIL', 'ERROR'].includes(r.status)), result.output);
  }
});
