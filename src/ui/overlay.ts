import type { PDFFont } from 'pdf-lib';

import {
  cssBoxToPdfRect,
  clampToPage,
  pdfRectToCssBox,
  type Viewportish,
} from '../core/geometry.ts';
import type { Journal } from '../core/journal.ts';
import { LINE_HEIGHT_RATIO, TEXT_PADDING, measureText, toWinAnsiText } from '../core/metrics.ts';
import { segmentsToSvgPath, toPoints, toSegments } from '../core/signature.ts';
import type { EditObj, SigObj, TextObj } from '../core/types.ts';
import type { PageHandle, Viewer } from '../core/viewer.ts';

/**
 * The interactive layer that sits on top of the rendered pages.
 *
 * Everything the user manipulates lives here as ordinary DOM, positioned from
 * the journal. Gestures deliberately do **not** write to the journal while they
 * are in flight — a drag moves the element directly and commits once on
 * pointerup. That keeps pointermove off the re-render path (so dragging stays
 * smooth on a phone) and keeps undo history meaningful: one drag, one undo step.
 */

export type Tool = 'select' | 'text' | 'sign';

export interface PlaceEvent {
  pageIndex: number;
  /** Tap location in PDF user space. */
  x: number;
  y: number;
  page: PageHandle;
}

const MIN_FONT_SIZE = 5;
const MAX_FONT_SIZE = 144;
/**
 * iOS Safari zooms the entire page when a field receives focus with a computed
 * font size below 16px. A 12pt annotation on a phone at fit-width renders at
 * about 7px, so tapping to add text would yank the view in every time.
 */
const IOS_FOCUS_ZOOM_THRESHOLD_PX = 16;
/** Pointer travel below this is a tap, not a drag. */
const TAP_SLOP = 4;

export class Overlay {
  private tool: Tool = 'select';
  private selectedId: string | null = null;
  private editor: HTMLTextAreaElement | null = null;
  private editingId: string | null = null;
  private gesture: Gesture | null = null;

  constructor(
    private readonly viewer: Viewer,
    private readonly journal: Journal,
    private readonly font: PDFFont,
    private readonly onPlace: (event: PlaceEvent) => void,
  ) {
    this.journal.subscribe(() => this.render());
    this.viewer.onLayout(() => this.render());

    document.addEventListener('pointerdown', this.handlePointerDown, true);
    document.addEventListener('keydown', this.handleKeyDown);
  }

  setTool(tool: Tool): void {
    if (this.tool === tool) return;
    this.tool = tool;
    if (tool !== 'select') this.select(null);
  }

  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.commitEdit();
    this.selectedId = id;
    this.render();
  }

  get selection(): string | null {
    return this.selectedId;
  }

  deleteSelected(): void {
    if (!this.selectedId) return;
    const id = this.selectedId;
    this.selectedId = null;
    this.journal.remove(id);
  }

  render(): void {
    if (this.gesture) return; // never re-render under a live gesture
    for (const page of this.viewer.pages) {
      const objects = this.journal.forPage(page.index);
      const frag = document.createDocumentFragment();
      for (const obj of objects) frag.append(this.createElement(obj, page.viewport));
      page.overlay.replaceChildren(frag);
    }
    this.repositionEditor();
  }

  // -------------------------------------------------------------------------
  // Element construction
  // -------------------------------------------------------------------------

  private createElement(obj: EditObj, vp: Viewportish): HTMLElement {
    const box = pdfRectToCssBox(vp, obj);
    const el = document.createElement('div');
    el.className = `obj obj-${obj.kind}`;
    el.dataset['id'] = obj.id;
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;

    if (obj.kind === 'text') {
      el.style.fontSize = `${obj.size * vp.scale}px`;
      el.style.lineHeight = String(LINE_HEIGHT_RATIO);
      el.style.padding = `${TEXT_PADDING * vp.scale}px`;
      el.style.color = cssColor(obj);
      el.textContent = toWinAnsiText(obj.value);
      if (this.editingId === obj.id) el.style.visibility = 'hidden';
    } else {
      el.append(signatureSvg(obj, box.width, box.height, vp.scale));
    }

    if (obj.id === this.selectedId && this.tool === 'select') {
      el.classList.add('is-selected');
      el.append(deleteHandle(), resizeHandle());
    }
    return el;
  }

  // -------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------

  private handlePointerDown = (event: PointerEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // A tap inside the open editor belongs to the editor.
    if (this.editor && this.editor.contains(target)) return;

    const objEl = target.closest<HTMLElement>('.obj');
    const pageEl = target.closest<HTMLElement>('.page');

    if (!pageEl) {
      // Clicking the chrome or the empty gutter dismisses the selection, but a
      // click on a toolbar button must still reach that button.
      if (!target.closest('.toolbar, .topbar, .sheet, .hint, .toast')) this.select(null);
      return;
    }

    const page = this.viewer.pages[Number(pageEl.dataset['page'])];
    if (!page) return;

    if (this.tool !== 'select') {
      const rect = pageEl.getBoundingClientRect();
      const [x, y] = page.viewport.convertToPdfPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      event.preventDefault();
      this.onPlace({ pageIndex: page.index, x: x ?? 0, y: y ?? 0, page });
      return;
    }

    if (!objEl) {
      this.select(null);
      return;
    }

    const obj = this.journal.get(objEl.dataset['id'] ?? '');
    if (!obj) return;

    if (target.closest('.handle-delete')) {
      event.preventDefault();
      this.selectedId = null;
      this.journal.remove(obj.id);
      return;
    }

    const resizing = Boolean(target.closest('.handle-resize'));
    // Captured before selection changes: the first tap on an object selects it,
    // and only a second tap opens it for editing. Reading `selectedId` after
    // the assignment below would make every first tap start an edit.
    const wasSelected = this.selectedId === obj.id;
    if (!resizing && !wasSelected) {
      this.commitEdit();
      this.selectedId = obj.id;
      this.render();
    }

    event.preventDefault();
    this.beginGesture(event, obj, page, resizing ? 'resize' : 'move', wasSelected);
  };

  private beginGesture(
    event: PointerEvent,
    obj: EditObj,
    page: PageHandle,
    mode: 'move' | 'resize',
    wasSelected: boolean,
  ): void {
    const el = page.overlay.querySelector<HTMLElement>(`[data-id="${CSS.escape(obj.id)}"]`);
    if (!el) return;

    const start = pdfRectToCssBox(page.viewport, obj);
    const gesture: Gesture = {
      mode,
      obj,
      page,
      el,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      start,
      current: { ...start },
      moved: false,
      wasSelected,
    };
    this.gesture = gesture;

    el.setPointerCapture(event.pointerId);
    el.classList.add(mode === 'move' ? 'is-dragging' : 'is-resizing');
    el.addEventListener('pointermove', this.handlePointerMove);
    el.addEventListener('pointerup', this.handlePointerUp);
    el.addEventListener('pointercancel', this.handlePointerUp);
  }

  private handlePointerMove = (event: PointerEvent): void => {
    const g = this.gesture;
    if (!g || event.pointerId !== g.pointerId) return;

    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    g.moved = true;

    if (g.mode === 'move') {
      g.current.left = g.start.left + dx;
      g.current.top = g.start.top + dy;
      g.el.style.left = `${g.current.left}px`;
      g.el.style.top = `${g.current.top}px`;
      return;
    }

    // Resize scales uniformly from the top-left corner. Signatures must not
    // skew, and text is scaled by font size rather than stretched, so a single
    // scalar is the only meaningful input either way.
    const scale = Math.max(
      0.08,
      Math.max(
        (g.start.width + dx) / g.start.width,
        (g.start.height + dy) / g.start.height,
      ),
    );
    g.scale = scale;
    g.current.width = g.start.width * scale;
    g.current.height = g.start.height * scale;
    g.el.style.width = `${g.current.width}px`;
    g.el.style.height = `${g.current.height}px`;
    if (g.obj.kind === 'text') {
      g.el.style.fontSize = `${g.obj.size * g.page.viewport.scale * scale}px`;
      g.el.style.padding = `${TEXT_PADDING * g.page.viewport.scale * scale}px`;
    }
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const g = this.gesture;
    if (!g || event.pointerId !== g.pointerId) return;

    g.el.removeEventListener('pointermove', this.handlePointerMove);
    g.el.removeEventListener('pointerup', this.handlePointerUp);
    g.el.removeEventListener('pointercancel', this.handlePointerUp);
    g.el.classList.remove('is-dragging', 'is-resizing');
    this.gesture = null;

    if (!g.moved) {
      // A tap on an *already*-selected text object opens it for editing. Double
      // click is unreliable on touch, so selection state carries the intent.
      if (g.obj.kind === 'text' && g.wasSelected) this.beginEdit(g.obj, g.page);
      else this.render();
      return;
    }

    if (g.mode === 'move') {
      const rect = cssBoxToPdfRect(g.page.viewport, g.current);
      this.journal.update(g.obj.id, clampToPage(rect, g.page.widthPt, g.page.heightPt));
      return;
    }

    const scale = g.scale ?? 1;
    if (g.obj.kind === 'text') {
      const size = clamp(g.obj.size * scale, MIN_FONT_SIZE, MAX_FONT_SIZE);
      const metrics = measureText(this.font, g.obj.value, size);
      // Text grows down-right from its anchor, so the top edge stays put.
      const top = g.obj.y + g.obj.height;
      this.journal.update<TextObj>(g.obj.id, {
        size,
        width: metrics.width,
        height: metrics.height,
        y: top - metrics.height,
      });
      return;
    }

    const width = g.obj.width * scale;
    const height = g.obj.height * scale;
    this.journal.update<SigObj>(g.obj.id, {
      width,
      height,
      y: g.obj.y + g.obj.height - height,
      thickness: g.obj.thickness * scale,
    });
  };

  // -------------------------------------------------------------------------
  // Text editing
  // -------------------------------------------------------------------------

  beginEdit(obj: TextObj, page: PageHandle): void {
    this.commitEdit();
    this.editingId = obj.id;
    this.selectedId = obj.id;

    // Render first so the underlying object is hidden behind the editor, then
    // attach. The editor is a sibling of the overlay rather than a child of it:
    // `render` replaces the overlay's children wholesale, and moving a focused
    // textarea in the DOM would blur it — which would immediately commit the
    // edit the user just started.
    this.render();

    const editor = document.createElement('textarea');
    editor.className = 'obj-editor';
    editor.value = obj.value;
    editor.spellcheck = false;
    editor.rows = 1;
    page.el.append(editor);
    this.editor = editor;

    this.styleEditor(editor, obj, page.viewport);

    editor.addEventListener('input', () => {
      const live = this.journal.get(obj.id);
      if (live?.kind === 'text') this.styleEditor(editor, { ...live, value: editor.value }, page.viewport);
    });
    editor.addEventListener('blur', () => this.commitEdit());
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.cancelEdit();
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.commitEdit();
      }
      event.stopPropagation();
    });

    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  private styleEditor(editor: HTMLTextAreaElement, obj: TextObj, vp: Viewportish): void {
    const metrics = measureText(this.font, editor.value || ' ', obj.size);
    // The editor is anchored at the object's top-left so it grows downward as
    // lines are added, matching how the committed object will be laid out.
    const box = pdfRectToCssBox(vp, {
      x: obj.x,
      y: obj.y + obj.height - metrics.height,
      width: metrics.width,
      height: metrics.height,
    });
    // Rather than suppress zooming globally with `maximum-scale=1` — which
    // would take pinch-zoom away from everyone, on a document viewer of all
    // things — keep the real font size at the threshold and scale the element
    // back down visually. The editor looks identical and iOS leaves it alone.
    const fontPx = obj.size * vp.scale;
    const shrink = fontPx < IOS_FOCUS_ZOOM_THRESHOLD_PX ? fontPx / IOS_FOCUS_ZOOM_THRESHOLD_PX : 1;

    // Slack of roughly one character: the measurement is Helvetica's, the
    // rendering is the device's substitute for it, and the caret needs somewhere
    // to sit past the last glyph. Without it the character being typed can end
    // up under the right edge.
    const slack = fontPx * 0.8;

    editor.style.left = `${box.left}px`;
    editor.style.top = `${box.top}px`;
    editor.style.width = `${(box.width + slack) / shrink}px`;
    editor.style.height = `${box.height / shrink}px`;
    editor.style.fontSize = `${fontPx / shrink}px`;
    editor.style.lineHeight = String(LINE_HEIGHT_RATIO);
    editor.style.padding = `${(TEXT_PADDING * vp.scale) / shrink}px`;
    editor.style.color = cssColor(obj);
    editor.style.transformOrigin = '0 0';
    editor.style.transform = shrink === 1 ? 'none' : `scale(${shrink})`;
  }

  private repositionEditor(): void {
    const id = this.editingId;
    if (!this.editor || !id) return;
    const obj = this.journal.get(id);
    const page = obj ? this.viewer.pages[obj.page] : undefined;
    if (obj?.kind === 'text' && page) this.styleEditor(this.editor, obj, page.viewport);
  }

  commitEdit(): void {
    const editor = this.editor;
    const id = this.editingId;
    if (!editor || !id) return;

    this.editor = null;
    this.editingId = null;
    const value = editor.value;
    editor.remove();

    const obj = this.journal.get(id);
    if (obj?.kind !== 'text') return;

    // An empty box is not a thing the user can see or select, so discard it.
    if (value.trim() === '') {
      if (this.selectedId === id) this.selectedId = null;
      this.journal.remove(id);
      return;
    }

    const metrics = measureText(this.font, value, obj.size);
    const top = obj.y + obj.height;
    this.journal.update<TextObj>(id, {
      value,
      width: metrics.width,
      height: metrics.height,
      y: top - metrics.height,
    });
  }

  private cancelEdit(): void {
    const editor = this.editor;
    const id = this.editingId;
    if (!editor || !id) return;
    this.editor = null;
    this.editingId = null;
    editor.remove();
    const obj = this.journal.get(id);
    if (obj?.kind === 'text' && obj.value.trim() === '') this.journal.remove(id);
    else this.render();
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (this.editor) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

    if (event.key === 'Escape') {
      this.select(null);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedId) {
      event.preventDefault();
      this.deleteSelected();
    }
  };
}

// ---------------------------------------------------------------------------

interface Gesture {
  mode: 'move' | 'resize';
  obj: EditObj;
  page: PageHandle;
  el: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  start: { left: number; top: number; width: number; height: number };
  current: { left: number; top: number; width: number; height: number };
  moved: boolean;
  /** Whether the object was selected before the gesture began. */
  wasSelected: boolean;
  scale?: number;
}

function signatureSvg(obj: SigObj, width: number, height: number, scale: number): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  // Paths are built in pixel space rather than a 0..1 viewBox so that stroke
  // width stays circular instead of being skewed by a non-square box.
  svg.setAttribute('stroke', cssColor(obj));
  svg.setAttribute('stroke-width', String(Math.max(0.5, obj.thickness * scale)));

  for (const flat of obj.strokes) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = segmentsToSvgPath(toSegments(toPoints(flat)), (u, v) => [u * width, v * height]);
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function deleteHandle(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'handle handle-delete';
  btn.setAttribute('aria-label', 'Remove');
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  return btn;
}

function resizeHandle(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'handle handle-resize';
  btn.setAttribute('aria-label', 'Resize');
  return btn;
}

function cssColor({ color }: { color: { r: number; g: number; b: number } }): string {
  const to255 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${to255(color.r)} ${to255(color.g)} ${to255(color.b)})`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
