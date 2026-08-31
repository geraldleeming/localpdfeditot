// The legacy build, not the default one. pdf.js's modern bundle calls very new
// platform APIs (`Map.prototype.getOrInsertComputed` among them) and throws
// outright on browsers a year or two old — including the iOS Safari versions
// this app is meant to run on. The legacy build ships the polyfills.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

import type { Viewportish } from './geometry.ts';

/**
 * The read-only half of the app: pdf.js renders pages, and nothing here ever
 * modifies the document.
 *
 * Three things drive the design, all of them mobile constraints:
 *
 *  - **Windowing.** Page shells are laid out immediately at their true size, so
 *    the scrollbar is correct from the start, but only pages near the viewport
 *    hold a canvas. A 300-page document costs 300 empty divs, not 300 bitmaps.
 *  - **A pixel budget.** Rendering at full device pixel ratio on a 3x phone
 *    screen produces canvases large enough for iOS to discard the tab. Scale is
 *    capped, then reduced further if a page would still exceed the budget.
 *  - **Explicit disposal.** WebKit does not promptly reclaim canvas backing
 *    stores when the element is dropped, so canvases are shrunk to 0x0 before
 *    being removed.
 *
 * Pages render with annotations disabled. The overlay draws every FreeText and
 * Ink annotation itself so they can be selected and removed; letting pdf.js
 * paint them too would double every signature.
 */

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Largest canvas we will allocate, in device pixels, per page. */
const MAX_CANVAS_PIXELS = 8_000_000;
/** Rendering above 2x is invisible on a phone and quadruples memory. */
const MAX_DPR = 2;
/** How far outside the viewport to keep pages rendered. */
const RENDER_MARGIN = '150% 0px';
/**
 * Fit-to-width is right on a phone, where the page should fill the screen, but
 * on a wide monitor it would rasterise a page at 1200px+ for no legibility gain
 * and a large memory cost. Past this width, stop growing.
 */
const MAX_FIT_WIDTH = 900;

export interface PageHandle {
  readonly index: number;
  /** Positioned container sized in CSS pixels at the current zoom. */
  readonly el: HTMLDivElement;
  /** Layer the overlay draws into, exactly covering the page. */
  readonly overlay: HTMLDivElement;
  /** Viewport at the current *display* scale — the overlay's frame of reference. */
  viewport: Viewportish;
  /** Page size in PDF points, in the page's displayed orientation. */
  readonly widthPt: number;
  readonly heightPt: number;
}

interface PageState extends PageHandle {
  proxy: pdfjs.PDFPageProxy;
  canvas: HTMLCanvasElement | null;
  task: pdfjs.RenderTask | null;
  rendered: boolean;
}

export class Viewer {
  readonly pages: PageHandle[] = [];

  private states: PageState[] = [];
  private loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;
  private observer: IntersectionObserver | null = null;
  private zoom = 1;
  private baseScale = 1;
  private layoutListeners = new Set<() => void>();

  constructor(private readonly container: HTMLElement) {}

  onLayout(fn: () => void): () => void {
    this.layoutListeners.add(fn);
    return () => this.layoutListeners.delete(fn);
  }

  get pageCount(): number {
    return this.states.length;
  }

  get zoomLevel(): number {
    return this.zoom;
  }

  async open(blob: Blob): Promise<void> {
    this.close();

    // pdf.js transfers this buffer to its worker, detaching it here. The app
    // keeps the original Blob and re-reads it at export time, so the file's
    // bytes are never held in memory twice.
    const data = new Uint8Array(await blob.arrayBuffer());
    this.loadingTask = pdfjs.getDocument({ data });
    const doc = await this.loadingTask.promise;

    for (let i = 0; i < doc.numPages; i++) {
      const proxy = await doc.getPage(i + 1);
      this.states.push(this.createShell(i, proxy));
    }
    this.pages.push(...this.states);

    this.baseScale = this.computeFitScale();
    this.relayout();
    this.startObserving();
  }

  /** Existing FreeText/Ink annotations, page by page, for the journal to adopt. */
  async readAnnotations(): Promise<Array<{ page: number; annots: unknown[] }>> {
    const out: Array<{ page: number; annots: unknown[] }> = [];
    for (const state of this.states) {
      const annots = await state.proxy.getAnnotations({ intent: 'display' });
      if (annots.length) out.push({ page: state.index, annots });
    }
    return out;
  }

  setZoom(zoom: number): void {
    const next = Math.max(0.25, Math.min(5, zoom));
    if (Math.abs(next - this.zoom) < 0.001) return;
    this.zoom = next;
    this.relayout();
  }

  fitWidth(): void {
    this.baseScale = this.computeFitScale();
    this.zoom = 1;
    this.relayout();
  }

  close(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const state of this.states) this.unrender(state);
    this.container.replaceChildren();
    this.states = [];
    this.pages.length = 0;
    // Destroying the loading task tears down the worker and releases the
    // document's memory; leaving it alive would keep every previously opened
    // file resident.
    void this.loadingTask?.destroy();
    this.loadingTask = null;
  }

  // -------------------------------------------------------------------------

  private createShell(index: number, proxy: pdfjs.PDFPageProxy): PageState {
    const unscaled = proxy.getViewport({ scale: 1 });

    const el = document.createElement('div');
    el.className = 'page';
    el.dataset['page'] = String(index);

    const label = document.createElement('span');
    label.className = 'page-number';
    label.textContent = String(index + 1);

    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    el.append(label, overlay);
    this.container.append(el);

    return {
      index,
      el,
      overlay,
      proxy,
      viewport: unscaled as unknown as Viewportish,
      widthPt: unscaled.width,
      heightPt: unscaled.height,
      canvas: null,
      task: null,
      rendered: false,
    };
  }

  private computeFitScale(): number {
    const first = this.states[0];
    if (!first) return 1;
    // The container's padding is part of its client width, so measure the space
    // a page actually gets rather than the box.
    const style = getComputedStyle(this.container);
    const available =
      this.container.clientWidth -
      parseFloat(style.paddingLeft || '0') -
      parseFloat(style.paddingRight || '0');
    if (available <= 0) return 1;
    return Math.max(0.1, Math.min(available, MAX_FIT_WIDTH) / first.widthPt);
  }

  private relayout(): void {
    const scale = this.baseScale * this.zoom;
    for (const state of this.states) {
      const viewport = state.proxy.getViewport({ scale });
      state.viewport = viewport as unknown as Viewportish;
      state.el.style.width = `${viewport.width}px`;
      state.el.style.height = `${viewport.height}px`;
      // Any canvas now shows the wrong resolution; drop it and let the observer
      // re-render whatever is actually on screen.
      if (state.rendered) {
        this.unrender(state);
        if (this.isNearViewport(state)) void this.render(state);
      }
    }
    for (const fn of this.layoutListeners) fn();
  }

  private startObserving(): void {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset['page']);
          const state = this.states[index];
          if (!state) continue;
          if (entry.isIntersecting) void this.render(state);
          else this.unrender(state);
        }
      },
      { root: this.container, rootMargin: RENDER_MARGIN },
    );
    for (const state of this.states) this.observer.observe(state.el);
  }

  private isNearViewport(state: PageState): boolean {
    const pageBox = state.el.getBoundingClientRect();
    const rootBox = this.container.getBoundingClientRect();
    const margin = rootBox.height * 1.5;
    return pageBox.bottom > rootBox.top - margin && pageBox.top < rootBox.bottom + margin;
  }

  private async render(state: PageState): Promise<void> {
    if (state.rendered) return;
    state.rendered = true;

    const viewport = state.proxy.getViewport({ scale: this.baseScale * this.zoom });
    const dpr = this.pixelRatioFor(viewport.width, viewport.height);

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    state.canvas = canvas;
    state.el.prepend(canvas);

    const task = state.proxy.render({
      canvasContext: ctx,
      canvas,
      viewport,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      annotationMode: pdfjs.AnnotationMode.DISABLE,
      background: '#ffffff',
    });
    state.task = task;

    try {
      await task.promise;
      state.el.classList.add('is-rendered');
    } catch (err) {
      // Cancellation is the normal path when the user scrolls fast or zooms.
      if (!(err instanceof Error) || err.name !== 'RenderingCancelledException') {
        console.error(`Failed to render page ${state.index + 1}`, err);
      }
    } finally {
      if (state.task === task) state.task = null;
    }
  }

  private unrender(state: PageState): void {
    state.task?.cancel();
    state.task = null;
    state.rendered = false;
    state.el.classList.remove('is-rendered');
    const canvas = state.canvas;
    if (!canvas) return;
    state.canvas = null;
    canvas.remove();
    // Shrinking before dropping the reference is what actually frees the
    // backing store on iOS.
    canvas.width = 0;
    canvas.height = 0;
  }

  /**
   * Device pixel ratio for this page, capped and then reduced until the canvas
   * fits the pixel budget. A tall page at high zoom is exactly where a phone
   * runs out of memory.
   */
  private pixelRatioFor(cssWidth: number, cssHeight: number): number {
    const wanted = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const area = cssWidth * cssHeight * wanted * wanted;
    if (area <= MAX_CANVAS_PIXELS) return wanted;
    return Math.max(0.5, Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight)));
  }
}
