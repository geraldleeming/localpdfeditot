/**
 * The edit journal's object model.
 *
 * Nothing here knows about the DOM, pdf.js, or pdf-lib. These objects are the
 * single source of truth while editing; the overlay renders them, and the
 * exporter compiles them into PDF annotations.
 *
 * Coordinates are always **PDF user space**: origin bottom-left, y up, units of
 * points (1/72"). `x`/`y` is the bottom-left corner of the object's box, which
 * matches a PDF annotation's `/Rect` exactly.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ObjBase extends Rect {
  id: string;
  /** 0-based page index. */
  page: number;
}

export interface TextObj extends ObjBase {
  kind: 'text';
  value: string;
  /** Font size in points. */
  size: number;
  color: RGB;
}

export interface SigObj extends ObjBase {
  kind: 'sig';
  /**
   * Strokes normalised to the object's box: each entry is a flat
   * `[x0, y0, x1, y1, ...]` list with values in 0..1, y measured **downward**
   * from the top of the box (i.e. natural drawing orientation). The exporter
   * flips y when writing PDF coordinates.
   */
  strokes: number[][];
  color: RGB;
  /** Stroke width in points, at the object's natural size. */
  thickness: number;
}

export type EditObj = TextObj | SigObj;

export const BLACK: RGB = { r: 0, g: 0, b: 0 };

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}
