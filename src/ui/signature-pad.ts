import { normalise, simplify, type NormalisedStrokes, type Pt } from '../core/signature.ts';
import type { RGB } from '../core/types.ts';

/**
 * The signature capture sheet.
 *
 * Two details matter more than they look:
 *
 *  - `getCoalescedEvents()` recovers the input samples the browser batched into
 *    a single pointermove. A phone digitiser samples far faster than it fires
 *    events, and without this a fast stroke comes back as a polygon.
 *  - Strokes are drawn incrementally rather than by clearing and repainting.
 *    Repainting a long signature on every move is the one thing here that would
 *    actually drop frames on a mid-range phone.
 */

export interface SignatureResult {
  strokes: number[][];
  aspect: number;
  color: RGB;
}

/** Simplification tolerance in CSS pixels — below a pen tip's own precision. */
const SIMPLIFY_TOLERANCE = 0.7;
const PAD_STROKE_WIDTH = 2.6;
const STORAGE_KEY = 'local-pdf-editor:signatures';
const MAX_SAVED = 3;

interface SavedSignature {
  strokes: number[][];
  aspect: number;
}

export class SignaturePad {
  private readonly canvas: HTMLCanvasElement;
  private readonly pad: HTMLElement;
  private readonly placeholder: HTMLElement;
  private readonly useButton: HTMLButtonElement;
  private readonly savedWrap: HTMLElement;
  private readonly savedList: HTMLElement;

  private ctx: CanvasRenderingContext2D | null = null;
  private strokes: Pt[][] = [];
  private active: Pt[] | null = null;
  private pointerId: number | null = null;
  private ink = '#111827';
  private resolve: ((result: SignatureResult | null) => void) | null = null;

  constructor(private readonly dialog: HTMLDialogElement) {
    this.canvas = must<HTMLCanvasElement>('#sig-canvas');
    this.pad = must('#sig-pad');
    this.placeholder = must('#sig-placeholder');
    this.useButton = must<HTMLButtonElement>('[data-sig="use"]');
    this.savedWrap = must('#sig-saved');
    this.savedList = must('#sig-saved-list');

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);

    this.dialog.addEventListener('close', () => this.finish(null));
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close(null);
    });

    for (const el of this.dialog.querySelectorAll<HTMLElement>('[data-sig]')) {
      el.addEventListener('click', () => {
        const action = el.dataset['sig'];
        if (action === 'clear') this.clear();
        else if (action === 'cancel') this.close(null);
        else if (action === 'use') this.close(this.capture());
      });
    }

    for (const swatch of this.dialog.querySelectorAll<HTMLElement>('.swatch')) {
      swatch.addEventListener('click', () => {
        this.ink = swatch.dataset['ink'] ?? '#111827';
        for (const other of this.dialog.querySelectorAll('.swatch')) {
          other.classList.toggle('is-active', other === swatch);
        }
        this.repaint();
      });
    }
  }

  open(): Promise<SignatureResult | null> {
    this.clear();
    this.renderSaved();
    this.dialog.showModal();
    // The canvas has no layout until the dialog is shown, so sizing waits a
    // frame. Doing it earlier yields a 0x0 backing store.
    requestAnimationFrame(() => this.resize());
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  // -------------------------------------------------------------------------

  private resize(): void {
    const rect = this.pad.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = PAD_STROKE_WIDTH;
    this.ctx = ctx;
    this.repaint();
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.pointerId !== null) return;
    event.preventDefault();
    this.pointerId = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId);
    this.active = [this.toLocal(event)];
    this.strokes.push(this.active);
    this.placeholder.hidden = true;
    this.useButton.disabled = false;
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId || !this.active) return;
    event.preventDefault();

    const samples = event.getCoalescedEvents?.() ?? [];
    const points = samples.length ? samples.map((e) => this.toLocal(e)) : [this.toLocal(event)];
    for (const point of points) {
      this.active.push(point);
      this.drawTail(this.active);
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    this.pointerId = null;
    if (this.active) {
      // The final segment runs to the true last point, which the midpoint
      // smoothing never reaches on its own.
      const pts = this.active;
      if (pts.length >= 2) {
        const a = pts[pts.length - 2]!;
        const b = pts[pts.length - 1]!;
        this.stroke((ctx) => {
          ctx.moveTo(mid(a, b).x, mid(a, b).y);
          ctx.lineTo(b.x, b.y);
        });
      } else if (pts.length === 1) {
        const p = pts[0]!;
        this.stroke((ctx) => {
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x, p.y);
        });
      }
    }
    this.active = null;
  };

  /** Draw only the newest smoothed segment. */
  private drawTail(pts: Pt[]): void {
    if (pts.length < 3) {
      if (pts.length === 2) {
        const a = pts[0]!;
        const b = pts[1]!;
        this.stroke((ctx) => {
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(mid(a, b).x, mid(a, b).y);
        });
      }
      return;
    }
    const p0 = pts[pts.length - 3]!;
    const p1 = pts[pts.length - 2]!;
    const p2 = pts[pts.length - 1]!;
    const from = mid(p0, p1);
    const to = mid(p1, p2);
    this.stroke((ctx) => {
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(p1.x, p1.y, to.x, to.y);
    });
  }

  private stroke(build: (ctx: CanvasRenderingContext2D) => void): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.strokeStyle = this.ink;
    ctx.beginPath();
    build(ctx);
    ctx.stroke();
  }

  private repaint(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const dpr = ctx.getTransform().a || 1;
    ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
    for (const pts of this.strokes) {
      for (let i = 2; i < pts.length; i++) {
        const from = mid(pts[i - 2]!, pts[i - 1]!);
        const to = mid(pts[i - 1]!, pts[i]!);
        const control = pts[i - 1]!;
        this.stroke((c) => {
          c.moveTo(from.x, from.y);
          c.quadraticCurveTo(control.x, control.y, to.x, to.y);
        });
      }
      if (pts.length === 1) {
        const p = pts[0]!;
        this.stroke((c) => {
          c.moveTo(p.x, p.y);
          c.lineTo(p.x, p.y);
        });
      }
    }
  }

  private toLocal(event: PointerEvent | { clientX: number; clientY: number }): Pt {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private clear(): void {
    this.strokes = [];
    this.active = null;
    this.pointerId = null;
    this.placeholder.hidden = false;
    this.useButton.disabled = true;
    this.repaint();
  }

  private capture(): SignatureResult | null {
    const simplified = this.strokes
      .map((pts) => simplify(pts, SIMPLIFY_TOLERANCE))
      .filter((pts) => pts.length > 0);
    const normalised = normalise(simplified);
    if (!normalised) return null;
    this.remember(normalised);
    return { ...normalised, color: hexToRgb(this.ink) };
  }

  private close(result: SignatureResult | null): void {
    if (this.dialog.open) this.dialog.close();
    this.finish(result);
  }

  private finish(result: SignatureResult | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(result);
  }

  // -------------------------------------------------------------------------
  // Saved signatures
  //
  // Stored as normalised stroke data in localStorage: a few kilobytes of JSON,
  // never an image, and never leaves the browser.
  // -------------------------------------------------------------------------

  private remember(sig: NormalisedStrokes): void {
    try {
      const saved = this.readSaved();
      saved.unshift({ strokes: sig.strokes, aspect: sig.aspect });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved.slice(0, MAX_SAVED)));
    } catch {
      // Private mode, blocked storage, or a full quota. Reuse is a convenience;
      // failing to save one must never block signing.
    }
  }

  private readSaved(): SavedSignature[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (s): s is SavedSignature =>
          !!s && Array.isArray((s as SavedSignature).strokes) && typeof (s as SavedSignature).aspect === 'number',
      );
    } catch {
      return [];
    }
  }

  private renderSaved(): void {
    const saved = this.readSaved();
    this.savedWrap.hidden = saved.length === 0;
    this.savedList.replaceChildren();

    for (const sig of saved) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sig-chip';
      chip.title = 'Use this signature';
      chip.append(previewSvg(sig));
      chip.addEventListener('click', () =>
        this.close({ strokes: sig.strokes, aspect: sig.aspect, color: hexToRgb(this.ink) }),
      );
      this.savedList.append(chip);
    }
  }
}

// ---------------------------------------------------------------------------

function previewSvg(sig: SavedSignature): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  for (const flat of sig.strokes) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const parts: string[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      parts.push(`${i === 0 ? 'M' : 'L'}${(flat[i]! * 100).toFixed(1)} ${(flat[i + 1]! * 100).toFixed(1)}`);
    }
    path.setAttribute('d', parts.join(''));
    svg.append(path);
  }
  return svg;
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function hexToRgb(hex: string): RGB {
  const value = parseInt(hex.slice(1), 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  };
}

function must<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${selector}`);
  return el;
}
