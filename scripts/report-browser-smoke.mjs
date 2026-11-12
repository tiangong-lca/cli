import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// Repeatable rendered-HTML qualification. Uses the project's pinned dev browser only.
const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv[2])
  throw new Error('Usage: node scripts/report-browser-smoke.mjs <new-output-directory>');
const directory = path.resolve(process.argv[2]);
mkdirSync(directory, { recursive: false });
const html = path.join(directory, 'report.html');
const input = path.join(root, 'assets/report/example.json');
const result = spawnSync(
  process.execPath,
  [
    path.join(root, 'bin/tiangong-lca.js'),
    'report',
    'render',
    '--input',
    input,
    '--output',
    html,
    '--json',
  ],
  { cwd: directory, encoding: 'utf8', shell: false },
);
assert.equal(result.status, 0, result.stdout + result.stderr);
assert.equal(JSON.parse(result.stdout).outcome, 'report_rendered');
const browser = await chromium.launch({ headless: true });
const failures = [];
const requests = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    offline: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith('file:')) requests.push(request.url());
  });
  await page.goto(pathToFileURL(html).href);
  assert.equal(await page.locator('html').getAttribute('data-interactive'), 'ready');
  assert.equal(await page.locator('#model-svg .graph-node').count(), 3);
  await page.locator('[data-graph-link="node-grid"]').click();
  assert.match(await page.locator('#node-grid').getAttribute('class'), /selected/u);
  await page.locator('[data-graph-link="edge-power"]').click();
  assert.match(await page.locator('#edge-power').getAttribute('class'), /selected/u);
  assert.ok(!(await page.locator('#node-grid').getAttribute('class')).includes('selected'));
  await page.locator('#graph-zoom').focus();
  await page.locator('#graph-zoom').press('End');
  await page.locator('#graph-zoom').dispatchEvent('input');
  assert.equal(await page.locator('#model-svg').evaluate((el) => el.style.width), '180%');
  await page.locator('#graph-fit').click();
  assert.equal(await page.locator('#model-svg').evaluate((el) => el.style.width), '100%');
  await page.locator('#report-language').selectOption('en');
  assert.equal(await page.locator('h1 [lang=zh]').isVisible(), false);
  assert.equal(await page.locator('h1 [lang=en]').isVisible(), true);
  await page.locator('#report-language').selectOption('zh');
  assert.equal(await page.locator('h1 [lang=zh]').isVisible(), true);
  assert.equal(await page.locator('h1 [lang=en]').isVisible(), false);
  await page.locator('#report-language').selectOption('bilingual');
  const rows = page.locator('#section-2 tbody tr');
  await page.locator('#section-2 input').fill('electricity');
  assert.equal(await rows.nth(1).isVisible(), false);
  assert.equal(await page.locator('#section-2 [role=status]').textContent(), '1 / 2');
  await page.emulateMedia({ media: 'print' });
  assert.equal(await rows.nth(1).isVisible(), true, 'print restores filtered rows');
  assert.equal(await page.locator('#node-assembly').isVisible(), true);
  assert.equal(await page.locator('#edge-power').isVisible(), true);
  assert.equal(await page.locator('.toolbar').isVisible(), false);
  const pdf = path.join(directory, 'report.pdf');
  await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
  assert.equal(readFileSync(pdf).subarray(0, 5).toString(), '%PDF-');
  assert.ok(readFileSync(pdf).length > 10000);
  await page.emulateMedia({ media: 'screen' });
  await page.locator('#section-2 input').fill('');
  await page.evaluate(() => {
    window.print = () => {
      document.documentElement.dataset.printCalled = 'yes';
    };
  });
  await page.locator('#report-print').click();
  assert.equal(await page.locator('html').getAttribute('data-print-called'), 'yes');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(directory, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.locator('#graph-fit').click();
  assert.equal(
    await page.locator('.graph-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
    'Fit shows the entire graph at mobile width',
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(directory, 'mobile.png'), fullPage: true });
  const noJs = await browser.newContext({ javaScriptEnabled: false, offline: true });
  const staticPage = await noJs.newPage();
  await staticPage.goto(pathToFileURL(html).href);
  assert.equal(await staticPage.locator('#node-grid').isVisible(), true);
  assert.equal(await staticPage.locator('#section-2 tbody tr').count(), 2);
  assert.deepEqual(failures, []);
  assert.deepEqual(requests, []);
  const receipt = {
    status: 'passed',
    browser: browser.version(),
    offline: true,
    checks: [
      'graph details',
      'zoom',
      'language switching',
      'table filter',
      'complete print rows/details',
      'PDF bytes',
      'print control',
      'mobile overflow',
      'no-JavaScript content',
    ],
    html,
    pdf,
  };
  writeFileSync(path.join(directory, 'verification.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
}
