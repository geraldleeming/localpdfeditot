import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import { PDFDocument, PDFName } from 'pdf-lib';
import { createServer, preview } from 'vite';

/**
 * End-to-end smoke test.
 *
 * The claim this project has to earn is that the file it writes is a real,
 * well-formed PDF that other software understands. Unit tests cannot show that,
 * so this drives the actual UI in a browser, saves a file, and then reopens the
 * bytes it produced to check the annotation structure.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, 'fixtures/sample.pdf');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
];

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const executablePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!executablePath) throw new Error('No Chromium binary found. Set CHROME_PATH.');
if (!existsSync(fixture)) throw new Error('Missing fixture. Run: node test/make-fixture.mjs');

// The app is exercised through `preview`, so the test drives the real
// production bundle. The render harness needs to import pdf.js from source, so
// it gets a dev server of its own.
const server = await preview({ preview: { port: 4318, strictPort: true } });
const base = server.resolvedUrls.local[0];
const devServer = await (await createServer({ server: { port: 4319, strictPort: true } })).listen();
const devBase = devServer.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath });

try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  console.log('\nOpening the app');
  await page.goto(base);
  await page.setInputFiles('#file-input', fixture);
  await page.waitForSelector('.page.is-rendered', { timeout: 30_000 });
  const pageCount = await page.locator('.page').count();
  check('all 3 pages laid out', pageCount === 3, `saw ${pageCount}`);

  console.log('\nAdding text');
  await page.click('[data-tool="text"]');
  const firstPage = page.locator('.page').first();
  await firstPage.click({ position: { x: 90, y: 300 } });
  await page.waitForSelector('.obj-editor');
  await page.keyboard.type('Approved — 31 Aug');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.obj-text');
  check('text object created', (await page.locator('.obj-text').count()) === 1);

  console.log('\nAdding a signature');
  await page.click('[data-tool="sign"]');
  await page.waitForSelector('#sig-dialog[open]');
  const pad = page.locator('#sig-canvas');
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 40, box.y + 130);
  await page.mouse.down();
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    await page.mouse.move(
      box.x + 40 + t * 240,
      box.y + 130 - Math.sin(t * Math.PI * 2.2) * 45,
    );
  }
  await page.mouse.up();
  await page.click('[data-sig="use"]');
  await page.waitForFunction(() => !document.querySelector('#sig-dialog')?.open);
  await firstPage.click({ position: { x: 200, y: 560 } });
  await page.waitForSelector('.obj-sig');
  check('signature object created', (await page.locator('.obj-sig').count()) === 1);

  console.log('\nSaving');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.click('[data-action="save"]'),
  ]);
  const savedPath = await download.path();
  check('download named from the source file', download.suggestedFilename() === 'sample-edited.pdf',
    download.suggestedFilename());

  console.log('\nInspecting the saved PDF');
  const bytes = await readFile(savedPath);
  const out = await PDFDocument.load(bytes);
  check('page count preserved', out.getPageCount() === 3);

  const annots = out.getPage(0).node.Annots();
  check('annotations written to page 1', annots?.size() === 2, `saw ${annots?.size() ?? 0}`);

  const subtypes = [];
  let inkRect = null;
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const dict = annots.lookup(i);
    const subtype = dict.get(PDFName.of('Subtype'))?.toString();
    subtypes.push(subtype);
    if (subtype === '/Ink') {
      inkRect = dict
        .lookup(PDFName.of('Rect'))
        .asArray()
        .map((n) => n.asNumber());
    }
    const ap = dict.get(PDFName.of('AP'));
    check(
      `annotation ${i + 1} carries an appearance stream`,
      Boolean(ap),
      'missing /AP — viewers would render it inconsistently',
    );
  }
  check('one FreeText annotation', subtypes.includes('/FreeText'), subtypes.join(', '));
  check('one Ink annotation', subtypes.includes('/Ink'), subtypes.join(', '));
  check('later pages untouched', !out.getPage(1).node.Annots()?.size());

  console.log('\nReopening the saved file in the app');
  await page.setInputFiles('#file-input', {
    name: 'sample-edited.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await page.waitForSelector('.page.is-rendered', { timeout: 30_000 });
  await page.waitForSelector('.obj-text', { timeout: 10_000 });
  check('saved text is editable again', (await page.locator('.obj-text').count()) === 1);
  check('saved signature is editable again', (await page.locator('.obj-sig').count()) === 1);

  console.log('\nRemoving');
  await page.locator('.obj-text').click();
  await page.waitForSelector('.obj.is-selected .handle-delete');
  await page.locator('.handle-delete').click();
  await page.waitForSelector('.obj-text', { state: 'detached' });
  check('text removed', (await page.locator('.obj-text').count()) === 0);
  check('signature untouched by the removal', (await page.locator('.obj-sig').count()) === 1);

  // Saving a file that was already saved once must not append a second copy of
  // annotations that are already in it and already hydrated into the journal,
  // and a removal made after reopening has to actually reach the file. Both
  // failed until export started clearing the annotations it manages.
  console.log('\nSaving again after reopening and removing');
  const [second] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.click('[data-action="save"]'),
  ]);
  const resavedBytes = await readFile(await second.path());
  const resaved = await PDFDocument.load(resavedBytes);
  const resavedAnnots = resaved.getPage(0).node.Annots();
  const resavedSubtypes = [];
  for (let i = 0; i < (resavedAnnots?.size() ?? 0); i++) {
    resavedSubtypes.push(resavedAnnots.lookup(i).get(PDFName.of('Subtype'))?.toString());
  }
  check(
    'no duplicate annotations after a second save',
    resavedSubtypes.length === 1,
    `expected 1, saw ${resavedSubtypes.length}: ${resavedSubtypes.join(', ')}`,
  );
  check('the removed text is gone from the file', !resavedSubtypes.includes('/FreeText'));
  check('the signature survived the round trip', resavedSubtypes.includes('/Ink'));

  // Several documents can be open at once, each holding its own edits. The
  // failure mode worth guarding is edits leaking between them, or a switch
  // quietly resetting the document you came back to.
  console.log('\nWorking with more than one document');
  await page.setInputFiles('#file-input', resolve(here, 'fixtures/second.pdf'));
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 2);
  check('the second document opens with its own page count', (await page.locator('.page').count()) === 2);
  check('the second document starts with no edits', (await page.locator('.obj').count()) === 0);

  await page.click('[data-action="files"]');
  await page.waitForSelector('#files-dialog[open]');
  check('every open document is listed', (await page.locator('.doc-item').count()) === 3);
  check(
    'the active document is marked',
    (await page.locator('.doc-item.is-active .doc-name').textContent()) === 'second.pdf',
  );

  await page.locator('.doc-item', { hasText: 'sample-edited.pdf' }).locator('.doc-pick').click();
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 3);
  check('switching back restores that document', (await page.locator('.page').count()) === 3);
  check(
    'its edits survived the round trip through another document',
    (await page.locator('.obj-sig').count()) === 1,
  );
  check('and the removed text did not come back', (await page.locator('.obj-text').count()) === 0);

  const realErrors = consoleErrors.filter((e) => !/RenderingCancelled/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));

  // iOS Safari zooms the whole page when a field is focused with a computed
  // font size under 16px. At phone width a 12pt annotation renders around 7px,
  // so the text editor has to hold the font at the threshold and scale itself
  // down instead. Only reproducible on a narrow viewport.
  console.log('\nChecking the text editor cannot trigger iOS focus-zoom');
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const small = await phone.newPage();
  await small.goto(base);
  await small.setInputFiles('#file-input', fixture);
  await small.waitForSelector('.page.is-rendered', { timeout: 30_000 });
  await small.click('[data-tool="text"]');
  await small.locator('.page').first().click({ position: { x: 60, y: 200 } });
  await small.waitForSelector('.obj-editor');

  const editor = await small.evaluate(() => {
    const el = document.querySelector('.obj-editor');
    const cs = getComputedStyle(el);
    return { fontPx: parseFloat(cs.fontSize), transform: cs.transform, width: el.getBoundingClientRect().width };
  });
  check(
    'editor font size stays at or above the 16px zoom threshold',
    editor.fontPx >= 16,
    `${editor.fontPx}px`,
  );
  check(
    'and is scaled back down so it still looks the right size',
    editor.transform !== 'none' && editor.width < 90,
    `transform ${editor.transform}, rendered ${editor.width.toFixed(1)}px wide`,
  );
  await phone.close();

  // Structure is not proof. The app renders pages with annotations disabled and
  // draws its own overlay, so only an independent render with annotations ON
  // shows whether the appearance streams we hand-wrote actually paint anything.
  console.log('\nRendering the saved PDF with annotations enabled');
  const harness = await context.newPage();
  await harness.goto(`${devBase}test/render-harness.html`);
  await harness.waitForFunction(() => window.harnessReady);

  // Sample precisely the rect the Ink annotation claims to occupy. The source
  // document draws nothing there, so any dark pixel came from our appearance
  // stream — and it lands where the annotation says it should.
  const ink = await harness.evaluate(
    async ({ arr, rect }) => {
      const { scale, height: canvasH } = await window.renderPdf(arr);
      const canvas = document.getElementById('c');
      const [x0, y0, x1, y1] = rect;
      const left = Math.max(0, Math.floor(x0 * scale));
      const right = Math.min(canvas.width, Math.ceil(x1 * scale));
      const top = Math.max(0, Math.floor(canvasH - y1 * scale));
      const bottom = Math.min(canvasH, Math.ceil(canvasH - y0 * scale));

      const { data, width } = canvas
        .getContext('2d')
        .getImageData(0, 0, canvas.width, canvas.height);
      let dark = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          if (data[(y * width + x) * 4] < 128) dark++;
        }
      }
      return dark;
    },
    { arr: Array.from(bytes), rect: inkRect },
  );
  check('the signature appearance stream draws inside its own rect', ink > 200, `${ink} dark pixels`);
} finally {
  await browser.close();
  await server.close();
  await devServer.close();
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
