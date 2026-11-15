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
    if (!/^(file|data):/u.test(request.url())) requests.push(request.url());
  });
  await page.goto(pathToFileURL(html).href);
  assert.equal(await page.locator('html').getAttribute('data-interactive'), 'ready');
  assert.equal(await page.locator('#model-svg .graph-node').count(), 3);
  const inspector = page.locator('.network-inspector');
  const edge = page.locator('[data-graph-link="edge-power"]');
  await page.locator('#model-svg [data-graph-link="node-grid"]').click();
  assert.equal(await inspector.locator('h3').innerText(), '电力供应');
  const sourceRow = inspector.locator('[data-exchange-id="power-out"]');
  await sourceRow.getByRole('link', { name: '电力' }).press('Enter');
  assert.equal(await inspector.locator('.process-header h3').innerText(), '电力供应');
  assert.match(await sourceRow.getAttribute('class'), /exchange-current/u);
  assert.equal(await sourceRow.locator('a').getAttribute('aria-current'), 'true');
  assert.equal(await edge.getAttribute('aria-current'), 'true');
  assert.equal(await sourceRow.locator('.exchange-amount').innerText(), '1');
  assert.equal(await inspector.locator('.connection-amount').innerText(), '2 kWh');
  await edge.locator('foreignObject').click();
  const targetRow = inspector.locator('[data-exchange-id="power-in"]');
  assert.match(await targetRow.getAttribute('class'), /exchange-current/u);
  assert.equal(await inspector.locator('.process-header h3').innerText(), '材料准备');
  assert.equal(await targetRow.locator('.exchange-amount').innerText(), '2');
  assert.equal(await inspector.locator('.connection-route [lang=en]').first().isVisible(), false);
  const catalog = page.locator('.catalog-toggle');
  assert.equal(await page.locator('#node-grid').isVisible(), false);
  await catalog.click();
  assert.equal(await page.locator('#node-grid').isVisible(), true);
  await catalog.click();
  assert.equal(await page.locator('#node-grid').isVisible(), false);
  await page.locator('#contribution-1 [data-graph-link="node-material"]').click();
  assert.equal(await inspector.locator('.process-header h3').innerText(), '材料准备');
  assert.equal(await page.locator('#sensitivity-1 .analysis-row').count(), 2);
  assert.equal(await page.locator('.result-summary .result-tile').count(), 1);
  assert.equal(
    await page
      .locator('img')
      .evaluateAll(
        (images) =>
          images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0),
      ),
    true,
  );
  await page.locator('.network-expand').click();
  assert.equal(await page.locator('.network-dialog').isVisible(), true);
  const firstWidth = await page
    .locator('#model-svg')
    .evaluate((el) => el.getBoundingClientRect().width);
  await page.locator('[data-zoom="in"]').click();
  assert.ok(
    (await page.locator('#model-svg').evaluate((el) => el.getBoundingClientRect().width)) >
      firstWidth,
  );
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.network-dialog').isVisible(), false);
  await page.locator('[data-zoom="fit"]').click();
  await page.screenshot({ path: path.join(directory, 'chinese.png'), fullPage: true });
  await page.locator('#report-language').selectOption('en');
  assert.equal(await page.locator('h1 [lang=zh]').isVisible(), false);
  assert.equal(await page.locator('h1 [lang=en]').isVisible(), true);
  await page.screenshot({ path: path.join(directory, 'english.png'), fullPage: true });
  await page.pdf({
    path: path.join(directory, 'report-en.pdf'),
    preferCSSPageSize: true,
    printBackground: true,
  });
  await page.locator('#report-language').selectOption('zh');
  assert.equal(await page.locator('h1 [lang=zh]').isVisible(), true);
  assert.equal(await page.locator('h1 [lang=en]').isVisible(), false);
  assert.equal(await page.locator('#report-language option').count(), 2);
  assert.equal(await page.title(), '可重复使用水瓶 · 生命周期研究');
  assert.equal(
    await page
      .locator('[data-language-text=en]:not([data-only])')
      .evaluateAll((items) => items.every((el) => getComputedStyle(el).display === 'none')),
    true,
  );
  assert.equal(await page.locator('.node-port').count(), 4);
  const rows = page.locator('#section-2 tbody tr');
  await page.locator('#section-2 input').fill('electricity');
  assert.equal(await rows.nth(1).isVisible(), false);
  assert.equal(await page.locator('#section-2 [role=status]').textContent(), '1 / 2');
  await page.emulateMedia({ media: 'print' });
  assert.equal(await rows.nth(1).isVisible(), true, 'print restores filtered rows');
  assert.equal(await page.locator('#node-assembly').isVisible(), true);
  assert.equal(await page.locator('#edge-power').isVisible(), true);
  assert.equal(await page.locator('#node-grid [data-exchange-id=power-out]').isVisible(), true);
  assert.equal(await inspector.isVisible(), false);
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
  await page.locator('[data-zoom="fit"]').click();
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
      'bidirectional exchange selection and separate connection amount',
      'collapsible complete process inventory',
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
