import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/** Builds the multi-page PDF the smoke test edits. */

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, 'fixtures/sample.pdf');

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);

for (let i = 1; i <= 3; i++) {
  const page = doc.addPage([595.28, 841.89]); // A4
  page.drawText(`Sample document — page ${i}`, {
    x: 56,
    y: 760,
    size: 20,
    font,
    color: rgb(0.1, 0.1, 0.12),
  });
  page.drawText('Signature:', { x: 56, y: 180, size: 12, font, color: rgb(0.35, 0.35, 0.4) });
  page.drawLine({
    start: { x: 130, y: 176 },
    end: { x: 380, y: 176 },
    thickness: 0.75,
    color: rgb(0.6, 0.6, 0.65),
  });
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, await doc.save());
console.log(`wrote ${out}`);
