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
  // Dark mode deliberately: the interface inverts but a PDF page stays white,
  // so anything that wrongly inherits a UI colour becomes invisible on the page
  // exactly here and nowhere else.
  const context = await browser.newContext({ acceptDownloads: true, colorScheme: 'dark' });
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

  // The hint sits over the page. Being a status message it must not take taps —
  // otherwise the chip reading "tap where you want to sign" swallows exactly
  // that tap across the middle of the screen.
  const hintBlocks = await page.evaluate(() => {
    const hint = document.querySelector('#hint');
    if (!hint || hint.hidden) return false;
    const box = hint.getBoundingClientRect();
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hint.contains(at);
  });
  check('the placement hint does not swallow the tap it asks for', !hintBlocks);

  await firstPage.click({ position: { x: 200, y: 560 } });
  await page.waitForSelector('.obj-sig');
  check('signature object created', (await page.locator('.obj-sig').count()) === 1);

  const ink = await page.evaluate(() => {
    const svg = document.querySelector('.obj-sig svg');
    const cs = getComputedStyle(svg);
    return {
      stroke: cs.stroke,
      width: parseFloat(cs.strokeWidth),
      uiText: getComputedStyle(document.body).color,
    };
  });
  // The stylesheet's `svg` rule paints icons with `stroke: currentColor`, and a
  // CSS declaration outranks a presentation attribute — so setting the stroke
  // as an attribute left the signature taking the interface text colour.
  check(
    'the signature draws in its own ink, not the interface text colour',
    ink.stroke === 'rgb(17, 24, 39)' && ink.stroke !== ink.uiText,
    `stroke ${ink.stroke}, interface text ${ink.uiText}`,
  );
  check(
    'and at its own stroke width rather than the icon default',
    ink.width !== 1.75,
    `${ink.width}px`,
  );

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
  // Clearing an annotation from the page's array does not remove the object
  // itself, and pdf-lib writes every object it holds — so each save cycle used
  // to leave a dead copy behind. This save has strictly fewer annotations than
  // the last, so it must not have produced a larger file.
  check(
    'repeated saves do not accumulate dead objects',
    resavedBytes.length <= bytes.length,
    `${bytes.length} bytes then ${resavedBytes.length} bytes, with one fewer annotation`,
  );

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

  // A file that cannot be opened must not take the app down with it. The
  // failure modes that matter are being left on a blank viewer while documents
  // are still listed, and a failed open evicting the document already open.
  // Console errors are judged before the deliberate failure below, which is
  // expected to log one.
  const realErrors = consoleErrors.filter((e) => !/RenderingCancelled/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));

  console.log('\nOpening something that is not a PDF');
  // The document list only exists in the DOM while the sheet has been rendered,
  // so it has to be counted through the sheet rather than read stale.
  const countDocuments = async () => {
    await page.click('[data-action="files"]');
    await page.waitForSelector('#files-dialog[open]');
    const total = await page.locator('.doc-item').count();
    await page.click('[data-files="close"]');
    await page.waitForFunction(() => !document.querySelector('#files-dialog')?.open);
    return total;
  };

  const documentsBefore = await countDocuments();
  await page.setInputFiles('#file-input', {
    name: 'broken.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nthis is not a pdf at all\n'),
  });
  // Wait for the message itself, not merely for a visible toast — an earlier
  // "Saved" notice may still be on screen and would match instantly.
  const shownError = await page
    .waitForFunction(
      () => {
        const toast = document.querySelector('#toast');
        return !!toast && !toast.hidden && /could not be opened|password/i.test(toast.textContent ?? '');
      },
      undefined,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);
  check('a clear error is shown', shownError, await page.locator('#toast').textContent());

  // The fallback loads after the message appears, so wait for it rather than
  // reading the gap between the two.
  await page.waitForFunction(() => document.querySelectorAll('.page').length > 0, undefined, {
    timeout: 15_000,
  });
  check(
    'the app falls back to a document rather than a blank screen',
    (await page.locator('.page').count()) > 0,
    `${await page.locator('.page').count()} pages showing`,
  );
  check(
    'the unreadable file is not added, and the open ones are kept',
    (await countDocuments()) === documentsBefore,
    `${documentsBefore} documents before, ${await countDocuments()} after`,
  );

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
    const scale = new DOMMatrixReadOnly(cs.transform).a;
    return { fontPx: parseFloat(cs.fontSize), scale, onScreen: parseFloat(cs.fontSize) * scale };
  });
  check(
    'editor font size stays at or above the 16px zoom threshold',
    editor.fontPx >= 16,
    `${editor.fontPx}px`,
  );
  // Above the threshold no compensation is needed; below it the element is
  // scaled back down. What matters either way is that the user sees the real
  // text size, so assert that rather than the mechanism used to achieve it.
  // Guards the clamp as much as the target: a tight point-size ceiling would
  // quietly cap this well below what was asked for.
  check(
    'new text is large enough to read on a phone',
    editor.onScreen >= 19,
    `${editor.onScreen.toFixed(1)}px on screen`,
  );
  // Text must never be clipped. The box is measured with Helvetica's own
  // metrics, but the device renders with whatever substitute it has, so the
  // editor must not hide characters as they are typed and the committed box
  // must grow to contain what was actually drawn.
  await small.keyboard.type('Test values that run long');
  await small.waitForFunction(() => {
    const el = document.querySelector('.obj-editor');
    return el && el.value.endsWith('long');
  });
  const clippedWhileTyping = await small.evaluate(() => {
    const el = document.querySelector('.obj-editor');
    return el.scrollWidth - el.clientWidth;
  });
  check('nothing is clipped while typing', clippedWhileTyping === 0, `${clippedWhileTyping}px hidden`);

  await small.keyboard.press('Control+Enter');
  await small.waitForSelector('.obj-text');
  // The selection handles used to be centred on the box corners, so half of
  // each dot sat over the content. On a short line that hid the last characters
  // and read exactly like truncated text. Their visible dots must clear the box.
  const handles = await small.evaluate(() => {
    const box = document.querySelector('.obj-text').getBoundingClientRect();
    const DOT = 14; // the visible circle inside the larger touch target
    const clears = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const b = el.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      const dot = {
        left: cx - DOT / 2,
        right: cx + DOT / 2,
        top: cy - DOT / 2,
        bottom: cy + DOT / 2,
      };
      return (
        dot.right <= box.left ||
        dot.left >= box.right ||
        dot.bottom <= box.top ||
        dot.top >= box.bottom
      );
    };
    return { remove: clears('.handle-delete'), resize: clears('.handle-resize') };
  });
  check('the remove handle does not sit over the text', handles.remove);
  check('the resize handle does not sit over the text', handles.resize);

  await small.keyboard.press('Escape'); // drop the selection handles before measuring

  const fit = await small.evaluate(() => {
    const el = document.querySelector('.obj-text');
    const range = document.createRange();
    range.selectNodeContents(el.firstChild);
    const cs = getComputedStyle(el);
    const needed =
      range.getBoundingClientRect().width +
      parseFloat(cs.paddingLeft) +
      parseFloat(cs.paddingRight);
    return { box: el.getBoundingClientRect().width, needed };
  });
  check(
    'the committed box contains the rendered text',
    fit.box + 0.5 >= fit.needed,
    `box ${fit.box.toFixed(1)}px, text needs ${fit.needed.toFixed(1)}px`,
  );

  // Anything outside the page is simply not drawn by a PDF viewer, so a line
  // that grew past the edge would be cut off in the saved file no matter how
  // the box is measured.
  const onPage = await small.evaluate(() => {
    const text = document.querySelector('.obj-text').getBoundingClientRect();
    const page = document.querySelector('.page').getBoundingClientRect();
    return { overhang: +(text.right - page.right).toFixed(1), textW: +text.width.toFixed(1) };
  });
  check(
    'a long line is kept inside the page rather than running off it',
    onPage.overhang <= 1,
    `${onPage.overhang}px past the page edge`,
  );
  // After the keyboard has been up, the chrome must still be where it looks.
  // The failure this guards is iOS scrolling the window to reveal the field and
  // leaving it there: buttons render in one place and receive taps in another,
  // which reads as the interface having frozen. Hit-testing each control's own
  // centre is the only check that actually catches that.
  const chrome = await small.evaluate(() => {
    const receivesTaps = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const box = el.getBoundingClientRect();
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return el.contains(at);
    };
    const root = document.documentElement;
    return {
      documentScrolls: root.scrollHeight > root.clientHeight + 1,
      windowScrolled: window.scrollY,
      save: receivesTaps('[data-action="save"]'),
      files: receivesTaps('[data-action="files"]'),
      text: receivesTaps('[data-tool="text"]'),
      sign: receivesTaps('[data-tool="sign"]'),
    };
  });
  check('the document itself cannot scroll', !chrome.documentScrolls);
  check('the window is not left scrolled after typing', chrome.windowScrolled === 0, `${chrome.windowScrolled}px`);
  check('Save receives taps where it is drawn', chrome.save);
  check('the file switcher receives taps where it is drawn', chrome.files);
  check('the Text and Sign tools receive taps where they are drawn', chrome.text && chrome.sign);

  // And they must actually do something afterwards.
  await small.click('[data-tool="text"]');
  check(
    'a tool still responds after an edit',
    (await small.locator('.tool.is-active').getAttribute('data-tool')) === 'text',
  );
  // A pinch must zoom the document, not the browser. Browser zoom magnifies the
  // rasterised page (blurry), drags the fixed chrome around, and can push it off
  // screen. Dispatching a real two-finger sequence checks all three at once.
  console.log('\nChecking pinch zoom');
  const sample = () =>
    small.evaluate(() => {
      const canvas = document.querySelector('.page canvas');
      const bar = document.querySelector('.toolbar').getBoundingClientRect();
      return {
        cssWidth: parseFloat(canvas.style.width),
        backingWidth: canvas.width,
        // Device pixels per CSS pixel. If the page were merely magnified this
        // would fall as the zoom rose; re-rendering holds it constant.
        density: canvas.width / parseFloat(canvas.style.width),
        browserZoom: window.visualViewport.scale,
        toolbar: { top: bar.top, height: bar.height },
      };
    });

  const beforePinch = await sample();
  await small.evaluate(() => {
    const viewer = document.querySelector('.viewer');
    const box = viewer.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const touch = (id, x, y) =>
      new Touch({ identifier: id, target: viewer, clientX: x, clientY: y });
    const send = (type, points) =>
      viewer.dispatchEvent(
        new TouchEvent(type, {
          touches: points,
          targetTouches: points,
          changedTouches: points,
          bubbles: true,
          cancelable: true,
        }),
      );
    send('touchstart', [touch(1, cx - 50, cy), touch(2, cx + 50, cy)]);
    send('touchmove', [touch(1, cx - 100, cy), touch(2, cx + 100, cy)]);
    send('touchend', []);
  });
  await small.waitForFunction(
    (was) => parseFloat(document.querySelector('.page canvas').style.width) > was * 1.5,
    beforePinch.cssWidth,
    { timeout: 10_000 },
  );
  const afterPinch = await sample();

  check(
    'a pinch zooms the document',
    afterPinch.cssWidth > beforePinch.cssWidth * 1.5,
    `${beforePinch.cssWidth}px -> ${afterPinch.cssWidth}px`,
  );
  check(
    'the page is re-rendered at the new scale rather than magnified',
    Math.abs(afterPinch.density - beforePinch.density) < 0.05,
    `${beforePinch.density.toFixed(2)} device px per css px before, ${afterPinch.density.toFixed(2)} after`,
  );
  check(
    'the browser itself never zooms',
    afterPinch.browserZoom === 1,
    `visual viewport scale ${afterPinch.browserZoom}`,
  );
  check(
    'the toolbar does not move or resize when the document zooms',
    Math.abs(afterPinch.toolbar.top - beforePinch.toolbar.top) < 1 &&
      Math.abs(afterPinch.toolbar.height - beforePinch.toolbar.height) < 1,
    `top ${beforePinch.toolbar.top} -> ${afterPinch.toolbar.top}`,
  );

  // Belt and braces: if browser zoom ever does happen — accessibility zoom, or a
  // browser that ignores touch-action — the chrome must still be usable.
  console.log('\nChecking the chrome survives pinch zoom');
  const cdp = await phone.newCDPSession(small);
  const measureChrome = () =>
    small.evaluate(() => {
      const bar = document.querySelector('.toolbar').getBoundingClientRect();
      const vv = window.visualViewport;
      return {
        visualHeight: bar.height * vv.scale,
        bottom: bar.bottom,
        visibleUntil: vv.offsetTop + vv.height,
      };
    });

  const unzoomed = await measureChrome();
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.5 });
  // Wait for the app to have reacted, not merely for the viewport to report the
  // new scale — the two are a frame or more apart.
  await small
    .waitForFunction(() => {
      const inv = getComputedStyle(document.documentElement).getPropertyValue('--vv-inv');
      return window.visualViewport.scale > 2 && parseFloat(inv) < 0.9;
    }, { timeout: 5000 })
    .catch(() => {});
  const zoomed = await measureChrome();

  check(
    'the toolbar keeps its real size when the page is zoomed',
    Math.abs(zoomed.visualHeight - unzoomed.visualHeight) < 1,
    `${unzoomed.visualHeight.toFixed(1)}px unzoomed vs ${zoomed.visualHeight.toFixed(1)}px zoomed`,
  );
  check(
    'and stays inside the visible area rather than sliding off',
    zoomed.bottom <= zoomed.visibleUntil + 1,
    `bottom ${zoomed.bottom.toFixed(1)}, viewport ends ${zoomed.visibleUntil.toFixed(1)}`,
  );
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });

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
  const drawnPixels = await harness.evaluate(
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
  check(
    'the signature appearance stream draws inside its own rect',
    drawnPixels > 200,
    `${drawnPixels} dark pixels`,
  );
} finally {
  await browser.close();
  await server.close();
  await devServer.close();
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
