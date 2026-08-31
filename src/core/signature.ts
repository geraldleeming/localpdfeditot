/**
 * Signature stroke maths: capture cleanup, simplification, and curve fitting.
 *
 * Deliberately constant-width. Variable (velocity-driven) width looks nicer on
 * screen but cannot survive export: a PDF `/Ink` annotation carries a single
 * border width, and faking taper would mean emitting filled outlines instead of
 * stroked paths, which bloats the file and stops the annotation being a real
 * Ink annotation that other viewers understand.
 */

export interface Pt {
  x: number;
  y: number;
}

export type Seg =
  | { t: 'M'; x: number; y: number }
  | { t: 'L'; x: number; y: number }
  | { t: 'Q'; cx: number; cy: number; x: number; y: number };

/**
 * Ramer-Douglas-Peucker. Pointer events fire far denser than a signature needs
 * — a phone can emit several hundred points per second with coalesced events —
 * and every surviving point costs bytes in `/InkList` and time on every repaint.
 */
export function simplify(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const toleranceSq = tolerance * tolerance;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDistSq = 0;
    let index = -1;
    const a = points[first]!;
    const b = points[last]!;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistSq(points[i]!, a, b);
      if (d > maxDistSq) {
        maxDistSq = d;
        index = i;
      }
    }
    if (index !== -1 && maxDistSq > toleranceSq) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]!);
  return out;
}

function perpendicularDistSq(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return ex * ex + ey * ey;
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const ex = p.x - cx;
  const ey = p.y - cy;
  return ex * ex + ey * ey;
}

/**
 * Midpoint quadratic smoothing: each captured point becomes a control point and
 * the curve passes through the midpoints between them. Cheap, stable, and it
 * never overshoots the way a Catmull-Rom fit can on a sharp corner.
 */
export function toSegments(points: Pt[]): Seg[] {
  if (points.length === 0) return [];
  const first = points[0]!;
  if (points.length === 1) {
    // A dot: a zero-length line still renders with a round cap.
    return [
      { t: 'M', x: first.x, y: first.y },
      { t: 'L', x: first.x, y: first.y },
    ];
  }
  if (points.length === 2) {
    const b = points[1]!;
    return [
      { t: 'M', x: first.x, y: first.y },
      { t: 'L', x: b.x, y: b.y },
    ];
  }

  const segs: Seg[] = [{ t: 'M', x: first.x, y: first.y }];
  for (let i = 1; i < points.length - 1; i++) {
    const c = points[i]!;
    const n = points[i + 1]!;
    segs.push({ t: 'Q', cx: c.x, cy: c.y, x: (c.x + n.x) / 2, y: (c.y + n.y) / 2 });
  }
  const last = points[points.length - 1]!;
  segs.push({ t: 'L', x: last.x, y: last.y });
  return segs;
}

export type PointMapper = (x: number, y: number) => [number, number];

const IDENTITY: PointMapper = (x, y) => [x, y];

export function segmentsToSvgPath(segs: Seg[], map: PointMapper = IDENTITY): string {
  const parts: string[] = [];
  for (const s of segs) {
    if (s.t === 'Q') {
      const [cx, cy] = map(s.cx, s.cy);
      const [x, y] = map(s.x, s.y);
      parts.push(`Q${round(cx)} ${round(cy)} ${round(x)} ${round(y)}`);
    } else {
      const [x, y] = map(s.x, s.y);
      parts.push(`${s.t}${round(x)} ${round(y)}`);
    }
  }
  return parts.join('');
}

/**
 * PDF has no quadratic operator, so each Q is raised to the equivalent cubic:
 * C1 = P0 + 2/3(Q - P0), C2 = P2 + 2/3(Q - P2). Exact, not an approximation.
 */
export function segmentsToPdfOps(segs: Seg[], map: PointMapper = IDENTITY): string {
  const parts: string[] = [];
  let cur: [number, number] = [0, 0];
  for (const s of segs) {
    if (s.t === 'M') {
      cur = map(s.x, s.y);
      parts.push(`${round(cur[0])} ${round(cur[1])} m`);
    } else if (s.t === 'L') {
      cur = map(s.x, s.y);
      parts.push(`${round(cur[0])} ${round(cur[1])} l`);
    } else {
      const q = map(s.cx, s.cy);
      const end = map(s.x, s.y);
      const c1x = cur[0] + (2 / 3) * (q[0] - cur[0]);
      const c1y = cur[1] + (2 / 3) * (q[1] - cur[1]);
      const c2x = end[0] + (2 / 3) * (q[0] - end[0]);
      const c2y = end[1] + (2 / 3) * (q[1] - end[1]);
      parts.push(
        `${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(end[0])} ${round(end[1])} c`,
      );
      cur = end;
    }
  }
  return parts.join(' ');
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface NormalisedStrokes {
  /** Flat `[x0, y0, x1, y1, ...]` per stroke, 0..1, y-down from the box top. */
  strokes: number[][];
  /** height / width of the captured ink, for sizing the placed object. */
  aspect: number;
}

/**
 * Trim the captured ink to its own bounding box and normalise to 0..1, so the
 * placed signature has no dead margin and can be scaled freely afterwards.
 */
export function normalise(rawStrokes: Pt[][], padFraction = 0.04): NormalisedStrokes | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of rawStrokes) {
    for (const p of stroke) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return null;

  // A single horizontal or vertical line has zero extent on one axis; give it a
  // floor so we never divide by zero.
  let width = maxX - minX;
  let height = maxY - minY;
  const floor = Math.max(width, height, 1) * 0.02;
  if (width < floor) {
    minX -= (floor - width) / 2;
    width = floor;
  }
  if (height < floor) {
    minY -= (floor - height) / 2;
    height = floor;
  }

  const padX = width * padFraction;
  const padY = height * padFraction;
  const boxW = width + padX * 2;
  const boxH = height + padY * 2;

  const strokes = rawStrokes
    .filter((s) => s.length > 0)
    .map((stroke) => {
      const flat: number[] = [];
      for (const p of stroke) {
        flat.push((p.x - minX + padX) / boxW, (p.y - minY + padY) / boxH);
      }
      return flat;
    });

  return { strokes, aspect: boxH / boxW };
}

/**
 * The inverse of the object model's storage format: take absolute PDF-space
 * stroke lists (as found in an existing `/InkList`) and express them relative to
 * a box, so an ink annotation authored elsewhere becomes an ordinary journal
 * object that can be moved, resized, and removed like any other.
 */
export function normaliseFlat(
  lists: number[][],
  rect: { x: number; y: number; width: number; height: number },
): number[][] {
  const out: number[][] = [];
  for (const list of lists) {
    const flat: number[] = [];
    for (let i = 0; i + 1 < list.length; i += 2) {
      flat.push(
        (list[i]! - rect.x) / rect.width,
        (rect.y + rect.height - list[i + 1]!) / rect.height,
      );
    }
    if (flat.length >= 2) out.push(flat);
  }
  return out;
}

/** Rehydrate a flat stroke into points. */
export function toPoints(flat: number[]): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i]!, y: flat[i + 1]! });
  return pts;
}
