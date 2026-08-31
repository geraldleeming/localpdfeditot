import type { Rect } from './types.ts';

/**
 * Conversion between page-local CSS pixels and PDF user space.
 *
 * We never do this arithmetic by hand. pdf.js's viewport already encodes the
 * page's scale, its `/CropBox` offset, and its `/Rotate` value, so routing every
 * conversion through it means rotated and offset-cropped pages work without a
 * special case. The only rule is that a viewport must be built at the same
 * scale the page is *displayed* at, not the scale it is rasterised at.
 */

/** Structural subset of pdf.js's PageViewport that we depend on. */
export interface Viewportish {
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly scale: number;
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportPoint(x: number, y: number): number[];
}

export interface CssBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function cssPointToPdf(vp: Viewportish, cssX: number, cssY: number): { x: number; y: number } {
  const [x, y] = vp.convertToPdfPoint(cssX, cssY);
  return { x: x ?? 0, y: y ?? 0 };
}

export function pdfPointToCss(vp: Viewportish, x: number, y: number): { left: number; top: number } {
  const [left, top] = vp.convertToViewportPoint(x, y);
  return { left: left ?? 0, top: top ?? 0 };
}

/**
 * Convert a CSS box to a PDF rect.
 *
 * Both opposite corners are converted and then normalised, because a 90/270
 * degree page rotation swaps which screen corner maps to which PDF corner. For
 * rotations that are multiples of 90 the result stays axis-aligned, which is
 * all a PDF annotation `/Rect` can express.
 */
export function cssBoxToPdfRect(vp: Viewportish, box: CssBox): Rect {
  const a = cssPointToPdf(vp, box.left, box.top);
  const b = cssPointToPdf(vp, box.left + box.width, box.top + box.height);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

export function pdfRectToCssBox(vp: Viewportish, rect: Rect): CssBox {
  const a = pdfPointToCss(vp, rect.x, rect.y);
  const b = pdfPointToCss(vp, rect.x + rect.width, rect.y + rect.height);
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return { left, top, width: Math.abs(b.left - a.left), height: Math.abs(b.top - a.top) };
}

/**
 * How many PDF points one CSS pixel spans. Used to convert a font size or a
 * stroke width, which are scalars and so have no meaningful corner to convert.
 */
export function ptPerCssPx(vp: Viewportish): number {
  return 1 / vp.scale;
}

/** Keep a box inside the page, preserving its size where possible. */
export function clampToPage(rect: Rect, pageWidth: number, pageHeight: number): Rect {
  const width = Math.min(rect.width, pageWidth);
  const height = Math.min(rect.height, pageHeight);
  return {
    width,
    height,
    x: Math.max(0, Math.min(rect.x, pageWidth - width)),
    y: Math.max(0, Math.min(rect.y, pageHeight - height)),
  };
}

/**
 * A page displayed rotated needs its added content rotated to match, otherwise
 * text the user typed upright would export sideways. Returns the `cm` operands
 * for a rotation about the rect's centre, or null when no rotation is needed.
 */
export function rotationAboutCentre(degrees: number, rect: Rect): number[] | null {
  const rot = ((degrees % 360) + 360) % 360;
  if (rot === 0) return null;
  const rad = (rot * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  // translate(cx, cy) · rotate(rot) · translate(-cx, -cy)
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
}

/**
 * The box to lay content out in, in the page's *displayed* orientation. For a
 * 90/270 rotation the width and height swap relative to the annotation rect.
 */
export function displayBox(degrees: number, rect: Rect): Rect {
  const rot = ((degrees % 360) + 360) % 360;
  if (rot !== 90 && rot !== 270) return rect;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return {
    x: cx - rect.height / 2,
    y: cy - rect.width / 2,
    width: rect.height,
    height: rect.width,
  };
}
