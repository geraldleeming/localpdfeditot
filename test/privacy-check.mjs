import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import { preview } from 'vite';

/**
 * Evidence for the only claim this app really makes: your PDF never leaves the
 * device.
 *
 * Reading the source is not enough. The app ships two large third-party
 * libraries, and pdf.js in particular will fetch CMaps and standard font data
 * when it is given a URL to fetch them from. So this observes the running
 * application instead:
 *
 *  1. **Every request is recorded** during a complete edit — open, add text,
 *     draw and place a signature, save — and each one must be same-origin, a
 *     GET, and carry no request body. A file being uploaded would show up as a
 *     body, a cross-origin host, or both.
 *  2. **The whole flow is then repeated with the network switched off.** This
 *     is the stronger half: if any part of opening, editing or saving depended
 *     on reaching a server, it would fail outright. Passing offline means the
 *     editing path makes no requests at all, rather than merely making ones
 *     that look harmless.
 *
 * Also watched: WebSockets, and `navigator.sendBeacon`, which is the usual way
 * telemetry leaves a page without appearing as an ordinary request.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, 'fixtures/sample.pdf');
const second = resolve(here, 'fixtures/second.pdf');

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
if (!existsSync(fixture)) throw new Error('Run: npm run fixture');

const server = await preview({ preview: { port: 4340, strictPort: true } });
const base = server.resolvedUrls.local[0];
const origin = new URL(base).origin;
const browser = await chromium.launch({ executablePath });

/** Drives a full edit: text, signature, save. */
async function edit(page, file) {
  await page.setInputFiles('#file-input', file);
  await page.waitForSelector('.page.is-rendered', { timeout: 30_000 });

  await page.click('[data-tool="text"]');
  await page.locator('.page').first().click({ position: { x: 90, y: 260 } });
  await page.waitForSelector('.obj-editor');
  await page.keyboard.type('Confidential note');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.obj-text');

  await page.click('[data-tool="sign"]');
  await page.waitForSelector('#sig-dialog[open]');
  const pad = await page.locator('#sig-canvas').boundingBox();
  await page.mouse.move(pad.x + 40, pad.y + 120);
  await page.mouse.down();
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    await page.mouse.move(pad.x + 40 + t * 200, pad.y + 120 - Math.sin(t * Math.PI * 2) * 35);
  }
  await page.mouse.up();
  await page.click('[data-sig="use"]');
  await page.waitForFunction(() => !document.querySelector('#sig-dialog')?.open);
  await page.locator('.page').first().click({ position: { x: 200, y: 420 } });
  await page.waitForSelector('.obj-sig');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.click('[data-action="save"]'),
  ]);
  return download;
}

try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const requests = [];
  const sockets = [];
  const failed = [];
  page.on('request', (r) =>
    requests.push({
      url: r.url(),
      method: r.method(),
      type: r.resourceType(),
      body: r.postData(),
    }),
  );
  page.on('websocket', (ws) => sockets.push(ws.url()));
  page.on('requestfailed', (r) => failed.push(r.url()));

  // sendBeacon does not surface as an ordinary request in every case, so it is
  // observed directly.
  await page.addInitScript(() => {
    window.__beacons = [];
    const original = navigator.sendBeacon?.bind(navigator);
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: (url, data) => {
        window.__beacons.push(String(url));
        return original ? original(url, data) : true;
      },
    });
  });

  console.log('\nEditing a PDF with the network available, recording every request');
  await page.goto(base);
  await edit(page, fixture);

  const external = requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith('blob:'));
  const withBodies = requests.filter((r) => r.body);
  const nonGet = requests.filter((r) => !['GET', 'HEAD'].includes(r.method));
  const beacons = await page.evaluate(() => window.__beacons ?? []);

  console.log(`  (${requests.length} requests observed, all listed below)`);
  for (const url of [...new Set(requests.map((r) => r.url.replace(origin, '')))]) {
    console.log(`    · ${url || '/'}`);
  }

  check(
    'every request stays on the app’s own origin',
    external.length === 0,
    external.map((r) => `${r.method} ${r.url}`).join(', '),
  );
  check(
    'no request carries a body — nothing is uploaded',
    withBodies.length === 0,
    withBodies.map((r) => `${r.method} ${r.url}`).join(', '),
  );
  check(
    'every request is a plain GET for an app asset',
    nonGet.length === 0,
    nonGet.map((r) => `${r.method} ${r.url}`).join(', '),
  );
  check('no WebSocket is opened', sockets.length === 0, sockets.join(', '));
  check('navigator.sendBeacon is never called', beacons.length === 0, beacons.join(', '));

  // The decisive half. If any part of the flow needed a server, it breaks here.
  console.log('\nRepeating the whole edit with the network switched off');
  failed.length = 0;
  const before = requests.length;
  await context.setOffline(true);

  const offlineDownload = await edit(page, second);
  check('a PDF still opens, edits and saves with no network at all', Boolean(offlineDownload));
  check(
    'the saved file is produced offline',
    (await offlineDownload.path()) !== null,
    'no file written',
  );
  check(
    'nothing in the editing path even attempted to reach the network',
    failed.length === 0,
    failed.join(', '),
  );

  const offlineExternal = requests
    .slice(before)
    .filter((r) => !r.url.startsWith(origin) && !r.url.startsWith('blob:'));
  check(
    'and no off-origin request was attempted while offline',
    offlineExternal.length === 0,
    offlineExternal.map((r) => r.url).join(', '),
  );
} finally {
  await browser.close();
  await server.close();
}

console.log(
  failures === 0
    ? '\nPrivacy checks passed: the document never leaves the device.\n'
    : `\n${failures} privacy check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
