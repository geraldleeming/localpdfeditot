import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

import { chromium } from 'playwright-core';

/**
 * Deployment check for GitHub Pages.
 *
 * A project site is served from a subdirectory, not the domain root, which is
 * where static builds usually break: absolute asset paths 404, and a service
 * worker registered from the wrong place gets a scope that cannot control the
 * app. So this serves `dist/` under a subpath exactly as Pages does and then
 * pulls the network out from under it — if the offline reload still opens and
 * renders a PDF, the "no server" claim holds literally.
 */

const BASE = '/localpdfeditot';
const PORT = 4400;
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.pdf': 'application/pdf',
  '.map': 'application/json',
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
];

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const executablePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!executablePath) throw new Error('No Chromium binary found. Set CHROME_PATH.');
if (!existsSync('dist/index.html')) throw new Error('No build found. Run: npm run build');
if (!existsSync('test/fixtures/sample.pdf')) throw new Error('Run: npm run fixture');

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (!path.startsWith(BASE)) {
    res.writeHead(404).end();
    return;
  }
  path = path.slice(BASE.length) || '/';
  if (path === '/') path = '/index.html';
  try {
    const body = await readFile(join('dist', normalize(path)));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await chromium.launch({ executablePath });
try {
  const context = await browser.newContext();
  const page = await context.newPage();

  const problems = [];
  page.on('requestfailed', (r) => problems.push(`failed ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));

  console.log(`\nServing dist/ at ${BASE}/ (as a Pages project site would)`);
  await page.goto(`http://localhost:${PORT}${BASE}/`);
  await page.waitForFunction(() => navigator.serviceWorker.ready);

  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    return { scope: r.scope, script: r.active?.scriptURL };
  });
  check(
    'service worker scope covers the app, not just /assets/',
    reg.scope === `http://localhost:${PORT}${BASE}/`,
    reg.scope,
  );
  check('service worker served from the site root', reg.script?.endsWith(`${BASE}/sw.js`), reg.script);

  console.log('\nCutting the network');
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();

  await page.setInputFiles('#file-input', 'test/fixtures/sample.pdf');
  await page.waitForSelector('.page.is-rendered', { timeout: 30_000 });
  check('app opens and renders a PDF with the network off', (await page.locator('.page').count()) === 3);
  check('page is controlled by the service worker', await page.evaluate(() => !!navigator.serviceWorker.controller));

  const real = problems.filter((p) => !/favicon/.test(p));
  check('no 404s or page errors', real.length === 0, real.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failures === 0 ? '\nDeployment checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
