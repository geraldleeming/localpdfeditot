import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
  type PDFContext,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';

import { displayBox, rotationAboutCentre } from './geometry.ts';
import {
  BASELINE_RATIO,
  LINE_HEIGHT_RATIO,
  TEXT_PADDING,
  toWinAnsiBytes,
  toWinAnsiText,
} from './metrics.ts';
import { normaliseFlat, segmentsToPdfOps, toPoints, toSegments } from './signature.ts';
import { BLACK, newId, type EditObj, type RGB, type SigObj, type TextObj } from './types.ts';

/**
 * Compiling the edit journal into real PDF annotations, and reading them back.
 *
 * Added text becomes a `/FreeText` annotation and a signature becomes an `/Ink`
 * annotation — the two objects the PDF spec already defines for exactly these
 * jobs. Because they live in the page's `/Annots` array rather than in the page
 * content stream, "remove the text I added" survives a save-and-reopen: it is
 * still one entry in an array, both for this app and for Acrobat or Preview.
 *
 * Every annotation is written with an explicit `/AP` appearance stream. Without
 * one, viewers disagree about how to render an annotation — some synthesise an
 * appearance from `/DA`, some show nothing at all. Writing the appearance
 * ourselves is the only way to guarantee the file looks the same everywhere.
 */

export class EncryptedPdfError extends Error {
  constructor() {
    super('This PDF is password-protected. Encrypted files are not supported yet.');
    this.name = 'EncryptedPdfError';
  }
}

export async function exportPdf(
  originalBytes: Uint8Array,
  objects: readonly EditObj[],
): Promise<Uint8Array> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(originalBytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof Error && /encrypt/i.test(err.message)) throw new EncryptedPdfError();
    throw err;
  }

  const pages = doc.getPages();
  const ctx = doc.context;

  // Embedded once and shared by every text annotation's appearance stream.
  // Helvetica is a standard-14 font, so this adds a font dictionary but no
  // font program.
  const needsFont = objects.some((o) => o.kind === 'text');
  const fontRef = needsFont ? (await doc.embedFont(StandardFonts.Helvetica)).ref : null;

  // Drop the annotations this app manages before writing the current set. On
  // load these are hydrated into the journal, so appending to them would write
  // a second copy of everything on every save-reopen-save cycle — and deleting
  // a hydrated object would never actually remove it from the file. The journal
  // is the single source of truth for FreeText and Ink; every other annotation
  // type in the document is left exactly as it was.
  for (const page of pages) removeManagedAnnotations(page);

  for (const obj of objects) {
    const page = pages[obj.page];
    if (!page) continue;
    const rotation = page.getRotation().angle;
    const ref =
      obj.kind === 'text'
        ? buildFreeText(ctx, obj, rotation, fontRef!)
        : buildInk(ctx, obj, rotation);
    page.node.addAnnot(ref);
  }

  return doc.save();
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The annotation subtypes this app owns — the ones `annotationsToObjects` adopts. */
const MANAGED_SUBTYPES = new Set(['/FreeText', '/Ink']);

function removeManagedAnnotations(page: PDFPage): void {
  const annots = page.node.Annots();
  if (!annots) return;
  // Backwards, because removing shifts every later index down.
  for (let i = annots.size() - 1; i >= 0; i--) {
    const dict = annots.lookupMaybe(i, PDFDict);
    const subtype = dict?.get(PDFName.of('Subtype'))?.toString();
    if (subtype && MANAGED_SUBTYPES.has(subtype)) annots.remove(i);
  }
}

/**
 * The appearance form's `/BBox` is set equal to the annotation `/Rect` with an
 * identity `/Matrix`. That makes form space and page space the same coordinate
 * system, so the drawing operators below can use absolute page coordinates
 * directly instead of a translated local frame.
 */
function apDict(rect: number[], extra: Record<string, unknown> = {}) {
  return {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: rect,
    Matrix: [1, 0, 0, 1, 0, 0],
    ...extra,
  };
}

function buildFreeText(ctx: PDFContext, obj: TextObj, rotation: number, fontRef: PDFRef): PDFRef {
  const rect = [obj.x, obj.y, obj.x + obj.width, obj.y + obj.height];
  // Glyphs cannot be pre-rotated point by point the way ink can, so a rotated
  // page gets a rotation applied to the whole text block instead.
  const box = displayBox(rotation, obj);
  const cm = rotationAboutCentre(rotation, obj);

  const da = `/Helv ${fmt(obj.size)} Tf ${rgbOps(obj.color, 'rg')}`;
  const lines = toWinAnsiText(obj.value).split('\n');
  const leading = obj.size * LINE_HEIGHT_RATIO;
  const firstBaseline = box.y + box.height - TEXT_PADDING - obj.size * BASELINE_RATIO;

  const ops: string[] = ['/Tx BMC', 'q'];
  if (cm) ops.push(`${cm.map(fmt).join(' ')} cm`);
  ops.push('BT', da, `${fmt(leading)} TL`, `${fmt(box.x + TEXT_PADDING)} ${fmt(firstBaseline)} Td`);
  lines.forEach((line, i) => {
    if (i > 0) ops.push('T*');
    ops.push(`${pdfLiteral(line)} Tj`);
  });
  ops.push('ET', 'Q', 'EMC');

  const apRef = ctx.register(
    ctx.flateStream(
      toWinAnsiBytes(ops.join('\n')),
      apDict(rect, { Resources: { Font: { Helv: fontRef } } }),
    ),
  );

  return ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'FreeText',
      Rect: rect,
      // /Contents keeps the original Unicode as UTF-16, so text search and
      // accessibility tools see what the user actually typed even where the
      // WinAnsi appearance had to substitute a character.
      Contents: PDFHexString.fromText(obj.value),
      DA: PDFString.of(da),
      // No border. FreeText defaults to a visible box, which is never what
      // someone adding a note to a form wants.
      BS: { W: 0, S: 'S' },
      // Print (bit 3). Without it the annotation shows on screen but vanishes
      // from paper and from most "flatten" operations.
      F: 4,
      NM: PDFString.of(obj.id),
      AP: { N: apRef },
    }),
  );
}

function buildInk(ctx: PDFContext, obj: SigObj, rotation: number): PDFRef {
  const rect = [obj.x, obj.y, obj.x + obj.width, obj.y + obj.height];
  const map = inkMapper(obj, rotation);

  const inkList: number[][] = [];
  const pathOps: string[] = [];
  for (const flat of obj.strokes) {
    const pts = toPoints(flat);
    if (pts.length === 0) continue;

    const absolute: number[] = [];
    for (const p of pts) {
      const [x, y] = map(p.x, p.y);
      absolute.push(x, y);
    }
    inkList.push(absolute);
    pathOps.push(`${segmentsToPdfOps(toSegments(pts), map)} S`);
  }

  const ops = [
    'q',
    rgbOps(obj.color, 'RG'),
    `${fmt(obj.thickness)} w`,
    '1 J', // round caps, so a dot or a stroke end is not a square
    '1 j', // round joins
    ...pathOps,
    'Q',
  ];

  const apRef = ctx.register(ctx.flateStream(ops.join('\n'), apDict(rect)));

  return ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Ink',
      Rect: rect,
      // /InkList carries the same geometry as the appearance stream, in page
      // coordinates. A viewer that regenerates the appearance gets the identical
      // signature rather than an unrotated or displaced one.
      InkList: inkList,
      C: [obj.color.r, obj.color.g, obj.color.b],
      BS: { W: obj.thickness, S: 'S' },
      F: 4,
      NM: PDFString.of(obj.id),
      AP: { N: apRef },
    }),
  );
}

/**
 * Maps a normalised stroke point (0..1, y down from the box top) to absolute
 * page coordinates, including the page's rotation. Ink is a set of points, so
 * unlike text it can be rotated directly and needs no `cm` in the appearance.
 */
function inkMapper(obj: SigObj, rotation: number): (u: number, v: number) => [number, number] {
  const box = displayBox(rotation, obj);
  const cm = rotationAboutCentre(rotation, obj);
  return (u, v) => {
    const x = box.x + u * box.width;
    const y = box.y + box.height - v * box.height;
    if (!cm) return [x, y];
    const [a, b, c, d, e, f] = cm as [number, number, number, number, number, number];
    return [a * x + c * y + e, b * x + d * y + f];
  };
}

function rgbOps({ r, g, b }: RGB, op: 'rg' | 'RG'): string {
  return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${op}`;
}

/** A PDF literal string: backslash, and both parens, must be escaped. */
function pdfLiteral(text: string): string {
  return `(${text.replace(/[\\()]/g, (m) => `\\${m}`)})`;
}

/**
 * PDF numbers have no exponent notation, so `toString` on a very small float
 * would emit something no parser accepts.
 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 10000) / 10000;
  return Object.is(rounded, -0) ? '0' : rounded.toFixed(4).replace(/\.?0+$/, '');
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

/** The pdf.js annotation fields we consume. Loosely typed on purpose. */
interface RawAnnotation {
  subtype?: string;
  rect?: number[];
  contentsObj?: { str?: string };
  contents?: string;
  defaultAppearanceData?: { fontSize?: number; fontColor?: ArrayLike<number> };
  inkLists?: ArrayLike<number>[];
  color?: ArrayLike<number> | null;
  borderStyle?: { width?: number };
}

/**
 * Turn a page's existing FreeText and Ink annotations into journal objects.
 *
 * This is what makes "remove the text I added" work after a save and reopen. It
 * deliberately adopts annotations this app did not create too, so a signature
 * dropped in by Preview or Acrobat is just as removable as one drawn here.
 *
 * Other annotation types (links, highlights, form widgets) are left in the file
 * untouched but are not editable, and the viewer renders pages with annotations
 * disabled so nothing is drawn twice.
 */
export function annotationsToObjects(pageIndex: number, annots: unknown[]): EditObj[] {
  const out: EditObj[] = [];
  for (const raw of annots as RawAnnotation[]) {
    const rect = normaliseRect(raw?.rect);
    if (!rect) continue;

    if (raw.subtype === 'FreeText') {
      const value = raw.contentsObj?.str ?? raw.contents ?? '';
      if (!value) continue;
      const declared = raw.defaultAppearanceData?.fontSize ?? 0;
      // A font size of 0 means "auto" in a /DA string; fall back to something
      // that fits the box rather than rendering an invisible zero-point font.
      const size = declared > 0 ? declared : clamp(rect.height / LINE_HEIGHT_RATIO, 6, 96);
      out.push({
        kind: 'text',
        id: newId('t'),
        page: pageIndex,
        ...rect,
        value,
        size,
        color: byteColor(raw.defaultAppearanceData?.fontColor) ?? BLACK,
      });
      continue;
    }

    if (raw.subtype === 'Ink' && raw.inkLists?.length) {
      const strokes = normaliseFlat(
        raw.inkLists.map((list) => Array.from(list)),
        rect,
      );
      if (!strokes.length) continue;
      out.push({
        kind: 'sig',
        id: newId('s'),
        page: pageIndex,
        ...rect,
        strokes,
        color: byteColor(raw.color) ?? BLACK,
        thickness: clamp(raw.borderStyle?.width ?? 1, 0.25, 20),
      });
    }
  }
  return out;
}

/** pdf.js hands back `[x1, y1, x2, y2]` with no guarantee about corner order. */
function normaliseRect(rect: number[] | undefined) {
  if (!rect || rect.length < 4) return null;
  const [a, b, c, d] = rect as [number, number, number, number];
  const x = Math.min(a, c);
  const y = Math.min(b, d);
  const width = Math.abs(c - a);
  const height = Math.abs(d - b);
  if (!(width > 0 && height > 0)) return null;
  return { x, y, width, height };
}

function byteColor(color: ArrayLike<number> | null | undefined): RGB | null {
  if (!color || color.length < 3) return null;
  return { r: (color[0] ?? 0) / 255, g: (color[1] ?? 0) / 255, b: (color[2] ?? 0) / 255 };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
