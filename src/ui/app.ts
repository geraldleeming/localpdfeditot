import type { PDFFont } from 'pdf-lib';

import { Journal } from '../core/journal.ts';
import { newId, type EditObj, type SigObj, type TextObj } from '../core/types.ts';
import type { Viewer } from '../core/viewer.ts';
import type { Overlay, PlaceEvent, Tool } from './overlay.ts';
import { SignaturePad, type SignatureResult } from './signature-pad.ts';

/**
 * Wiring. Holds no document state of its own beyond the open file: the journal
 * owns the edits, the viewer owns the rendering, and this module connects the
 * two to the chrome.
 *
 * pdf.js and pdf-lib together are most of this app's weight, and neither is
 * needed until a file exists. They load on the first open, behind a spinner, so
 * the initial page is a few kilobytes rather than a third of a megabyte — which
 * on a phone is the difference between an instant first paint and a stall.
 */

const DEFAULT_FONT_SIZE = 12;
/** Roughly 2.2 inches — a natural signature width on a letter/A4 page. */
const DEFAULT_SIGNATURE_WIDTH = 160;
const ZOOM_STEP = 1.25;

interface Engine {
  viewer: Viewer;
  overlay: Overlay;
  font: PDFFont;
  metrics: typeof import('../core/metrics.ts');
  annotations: typeof import('../core/annotations.ts');
}

export class App {
  private readonly journal = new Journal();
  private readonly pad: SignaturePad;

  private engine: Engine | null = null;
  private enginePromise: Promise<Engine> | null = null;

  private file: Blob | null = null;
  private fileName = 'document.pdf';
  private tool: Tool = 'select';
  private pendingSignature: SignatureResult | null = null;
  private dirty = false;
  private toastTimer: number | undefined;

  private readonly els = {
    viewer: must<HTMLDivElement>('#viewer'),
    stage: must<HTMLElement>('.stage'),
    dropzone: must<HTMLElement>('.dropzone'),
    loading: must<HTMLElement>('#loading'),
    hint: must<HTMLElement>('#hint'),
    toast: must<HTMLElement>('#toast'),
    fileInput: must<HTMLInputElement>('#file-input'),
    zoomValue: must<HTMLElement>('[data-action="zoom-fit"]'),
    undo: must<HTMLButtonElement>('[data-action="undo"]'),
    redo: must<HTMLButtonElement>('[data-action="redo"]'),
    save: must<HTMLButtonElement>('[data-action="save"]'),
  };

  constructor() {
    this.pad = new SignaturePad(must<HTMLDialogElement>('#sig-dialog'));
  }

  start(): void {
    this.journal.subscribe(() => {
      this.dirty = !this.journal.isEmpty;
      this.els.undo.disabled = !this.journal.canUndo;
      this.els.redo.disabled = !this.journal.canRedo;
    });

    this.bindChrome();
    this.bindFileInput();
    this.bindDragAndDrop();
    this.bindShortcuts();
  }

  // -------------------------------------------------------------------------
  // Lazy engine
  // -------------------------------------------------------------------------

  private loadEngine(): Promise<Engine> {
    this.enginePromise ??= (async () => {
      const [viewerMod, overlayMod, metrics, annotations] = await Promise.all([
        import('../core/viewer.ts'),
        import('./overlay.ts'),
        import('../core/metrics.ts'),
        import('../core/annotations.ts'),
      ]);

      const font = await metrics.helvetica();
      const viewer = new viewerMod.Viewer(this.els.viewer);
      const overlay = new overlayMod.Overlay(viewer, this.journal, font, (event) =>
        this.place(event),
      );

      this.engine = { viewer, overlay, font, metrics, annotations };
      return this.engine;
    })();
    return this.enginePromise;
  }

  // -------------------------------------------------------------------------
  // Chrome
  // -------------------------------------------------------------------------

  private bindChrome(): void {
    for (const el of document.querySelectorAll<HTMLElement>('[data-action]')) {
      el.addEventListener('click', () => {
        const engine = this.engine;
        switch (el.dataset['action']) {
          case 'open':
            this.els.fileInput.click();
            break;
          case 'save':
            void this.save();
            break;
          case 'undo':
            engine?.overlay.commitEdit();
            this.journal.undo();
            break;
          case 'redo':
            this.journal.redo();
            break;
          case 'zoom-in':
            if (engine) this.setZoom(engine.viewer.zoomLevel * ZOOM_STEP);
            break;
          case 'zoom-out':
            if (engine) this.setZoom(engine.viewer.zoomLevel / ZOOM_STEP);
            break;
          case 'zoom-fit':
            engine?.viewer.fitWidth();
            this.updateZoomLabel();
            break;
        }
      });
    }

    for (const el of document.querySelectorAll<HTMLElement>('[data-tool]')) {
      el.addEventListener('click', () => this.setTool(el.dataset['tool'] as Tool));
    }

    // Refitting on rotate keeps a page filling the width instead of leaving the
    // reader pinch-zooming after every orientation change.
    let resizeTimer: number | undefined;
    window.addEventListener('resize', () => {
      if (!this.file) return;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        this.engine?.viewer.fitWidth();
        this.updateZoomLabel();
      }, 150);
    });

    window.addEventListener('beforeunload', (event) => {
      if (!this.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  private bindFileInput(): void {
    this.els.fileInput.addEventListener('change', () => {
      const file = this.els.fileInput.files?.[0];
      if (file) void this.load(file, file.name);
      this.els.fileInput.value = '';
    });
  }

  private bindDragAndDrop(): void {
    const zone = this.els.stage;
    for (const type of ['dragenter', 'dragover'] as const) {
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        this.els.dropzone.classList.add('is-over');
      });
    }
    for (const type of ['dragleave', 'drop'] as const) {
      zone.addEventListener(type, () => this.els.dropzone.classList.remove('is-over'));
    }
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
        this.toast('That file is not a PDF.', true);
        return;
      }
      void this.load(file, file.name);
    });
  }

  private bindShortcuts(): void {
    document.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (!(event.metaKey || event.ctrlKey)) return;

      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.journal.redo();
        else this.journal.undo();
      } else if (key === 's' && this.file) {
        event.preventDefault();
        void this.save();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Document lifecycle
  // -------------------------------------------------------------------------

  private async load(blob: Blob, name: string): Promise<void> {
    this.els.loading.hidden = false;
    try {
      const engine = await this.loadEngine();
      this.journal.reset([]);
      // The viewer must be visible before pages are laid out: a hidden
      // container measures zero width, so the fit-to-width scale would be
      // wrong and the IntersectionObserver would never fire. The loading
      // overlay covers it in the meantime.
      this.showDocument(true);
      await engine.viewer.open(blob);

      // Adopt the FreeText and Ink annotations already in the file so that text
      // and signatures added in a previous session — or in another PDF app —
      // can be moved and removed here too.
      const existing: EditObj[] = [];
      for (const { page, annots } of await engine.viewer.readAnnotations()) {
        existing.push(...engine.annotations.annotationsToObjects(page, annots));
      }
      this.journal.reset(existing);

      this.file = blob;
      this.fileName = name;
      this.dirty = false;
      this.showDocument(true);
      this.setTool('select');
      this.updateZoomLabel();
      engine.overlay.render();
    } catch (err) {
      console.error(err);
      this.file = null;
      this.showDocument(false);
      this.toast(this.describeError(err, 'That PDF could not be opened.'), true);
    } finally {
      this.els.loading.hidden = true;
    }
  }

  private showDocument(loaded: boolean): void {
    for (const el of document.querySelectorAll<HTMLElement>('[data-when]')) {
      el.hidden = el.dataset['when'] === 'loaded' ? !loaded : loaded;
    }
  }

  private async save(): Promise<void> {
    const engine = this.engine;
    if (!this.file || !engine) return;
    engine.overlay.commitEdit();

    const objects = this.journal.all();
    const button = this.els.save;
    button.disabled = true;
    try {
      // Re-read from the Blob rather than keeping a second copy in memory:
      // pdf.js detached the buffer it was given, and a phone editing a 40 MB
      // scan cannot afford to hold the file twice.
      const original = new Uint8Array(await this.file.arrayBuffer());
      const bytes = await engine.annotations.exportPdf(original, objects);
      downloadPdf(bytes, exportName(this.fileName));
      this.dirty = false;

      const substituted = objects.some(
        (o) => o.kind === 'text' && engine.metrics.hasUnsupportedChars(o.value),
      );
      this.toast(
        substituted
          ? 'Saved. Some characters are not available in Helvetica and were replaced.'
          : 'Saved to your downloads.',
      );
    } catch (err) {
      console.error(err);
      this.toast(this.describeError(err, 'Could not save this PDF.'), true);
    } finally {
      button.disabled = false;
    }
  }

  private describeError(err: unknown, fallback: string): string {
    const Encrypted = this.engine?.annotations.EncryptedPdfError;
    if (Encrypted && err instanceof Encrypted) return err.message;
    return `${fallback} It may be damaged or password-protected.`;
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  private setTool(tool: Tool): void {
    if (tool === 'sign') {
      // Signing is two steps: draw, then choose where it goes. Opening the pad
      // straight away means one tap gets you drawing.
      void this.startSigning();
      return;
    }
    this.pendingSignature = null;
    this.applyTool(tool);
    this.hint(tool === 'text' ? 'Tap the page where the text should go' : null);
  }

  private applyTool(tool: Tool): void {
    this.tool = tool;
    this.engine?.overlay.setTool(tool);
    this.els.viewer.dataset['tool'] = tool;
    for (const el of document.querySelectorAll<HTMLElement>('[data-tool]')) {
      el.classList.toggle('is-active', el.dataset['tool'] === tool);
    }
  }

  private async startSigning(): Promise<void> {
    const result = await this.pad.open();
    if (!result) {
      this.applyTool(this.tool);
      return;
    }
    this.pendingSignature = result;
    this.applyTool('sign');
    this.hint('Tap where you want to sign');
  }

  private place(event: PlaceEvent): void {
    if (this.tool === 'text') this.placeText(event);
    else if (this.tool === 'sign') this.placeSignature(event);
  }

  private placeText(event: PlaceEvent): void {
    const engine = this.engine;
    if (!engine) return;

    const metrics = engine.metrics.measureText(engine.font, '', DEFAULT_FONT_SIZE);
    const obj: TextObj = {
      kind: 'text',
      id: newId('t'),
      page: event.pageIndex,
      // The tap marks the top-left of the text, which is where a caret would
      // appear — anchoring the box's bottom there would feel misaligned.
      x: clamp(event.x, 0, Math.max(0, event.page.widthPt - metrics.width)),
      y: clamp(event.y - metrics.height, 0, Math.max(0, event.page.heightPt - metrics.height)),
      width: metrics.width,
      height: metrics.height,
      value: '',
      size: DEFAULT_FONT_SIZE,
      color: { r: 0, g: 0, b: 0 },
    };

    this.journal.add(obj);
    this.setTool('select');
    engine.overlay.beginEdit(obj, event.page);
  }

  private placeSignature(event: PlaceEvent): void {
    const engine = this.engine;
    const signature = this.pendingSignature;
    if (!engine || !signature) return;

    const width = Math.min(DEFAULT_SIGNATURE_WIDTH, event.page.widthPt * 0.6);
    const height = width * signature.aspect;
    const obj: SigObj = {
      kind: 'sig',
      id: newId('s'),
      page: event.pageIndex,
      // Centred on the tap: a signature is placed by eye against a line, and
      // people aim at the middle of where they want it.
      x: clamp(event.x - width / 2, 0, Math.max(0, event.page.widthPt - width)),
      y: clamp(event.y - height / 2, 0, Math.max(0, event.page.heightPt - height)),
      width,
      height,
      strokes: signature.strokes,
      color: signature.color,
      thickness: Math.max(0.8, width / 110),
    };

    this.journal.add(obj);
    this.pendingSignature = null;
    this.setTool('select');
    engine.overlay.select(obj.id);
  }

  // -------------------------------------------------------------------------
  // Feedback
  // -------------------------------------------------------------------------

  private setZoom(zoom: number): void {
    this.engine?.viewer.setZoom(zoom);
    this.updateZoomLabel();
  }

  private updateZoomLabel(): void {
    const zoom = this.engine?.viewer.zoomLevel ?? 1;
    this.els.zoomValue.textContent = `${Math.round(zoom * 100)}%`;
  }

  private hint(message: string | null): void {
    this.els.hint.hidden = !message;
    if (message) this.els.hint.textContent = message;
  }

  private toast(message: string, isError = false): void {
    const el = this.els.toast;
    el.textContent = message;
    el.classList.toggle('is-error', isError);
    el.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(
      () => {
        el.hidden = true;
      },
      isError ? 6000 : 3200,
    );
  }
}

// ---------------------------------------------------------------------------

function exportName(original: string): string {
  return `${original.replace(/\.pdf$/i, '')}-edited.pdf`;
}

function downloadPdf(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in Safari; give the
  // navigation time to start.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function must<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${selector}`);
  return el;
}
