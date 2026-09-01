import type { PDFFont } from 'pdf-lib';

import { Journal } from '../core/journal.ts';
import { newId, type EditObj, type SigObj, type TextObj } from '../core/types.ts';
import type { Viewer } from '../core/viewer.ts';
import type { Overlay, PlaceEvent, Tool } from './overlay.ts';
import { SignaturePad, type SignatureResult } from './signature-pad.ts';

/**
 * Wiring. The journal owns the edits, the viewer owns the rendering, and this
 * module connects the two to the chrome.
 *
 * Several documents can be open at once. Each one keeps its own edits, so
 * switching between them is not a reload — you go back to a PDF exactly as you
 * left it. Only the active document's edits live in the journal; the rest are
 * stashed on their entry and restored on switch.
 *
 * pdf.js and pdf-lib together are most of this app's weight, and neither is
 * needed until a file exists. They load on the first open, behind a spinner, so
 * the initial page is a few kilobytes rather than a third of a megabyte — which
 * on a phone is the difference between an instant first paint and a stall.
 */

/** What new text should measure on screen, in CSS pixels. */
const TARGET_ON_SCREEN_PX = 20;
/**
 * Point-size bounds. The ceiling has to be generous: a phone showing a whole A4
 * page needs around 32pt to reach the target on screen, so a tighter cap would
 * silently override the target and leave the text small.
 */
const MIN_FONT_PT = 14;
const MAX_FONT_PT = 40;

/**
 * New text is sized to be legible at the current zoom, not to a fixed point
 * size. A phone showing a whole A4 page renders 12pt at about 7px — too small
 * to read, never mind to check before saving. Aiming at an on-screen size and
 * converting back through the viewport scale gives readable text on a phone
 * without producing something absurd on a desktop showing the page larger. The
 * clamp keeps it a plausible annotation size at either extreme.
 */
function defaultFontSize(viewportScale: number): number {
  return Math.round(clamp(TARGET_ON_SCREEN_PX / viewportScale, MIN_FONT_PT, MAX_FONT_PT));
}
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

interface DocEntry {
  id: string;
  name: string;
  /** The file itself. Blobs are disk-backed, so holding several is cheap. */
  blob: Blob;
  /** Edits, stashed while inactive. `null` until the file's own annotations are read. */
  objects: EditObj[] | null;
  /** The edits as they stood when the file was opened, or when it was last saved. */
  baseline: string;
  /** Whether the edits differ from that baseline. */
  dirty: boolean;
  /** Whether this document has been saved at least once in this session. */
  saved: boolean;
}

/**
 * A comparable snapshot of a document's edits.
 *
 * Compared against a baseline this makes "unsaved changes" mean what it says.
 * A flag set on every journal change would latch on and stay on: adding text
 * and then undoing it would still claim there was work to lose, which makes the
 * warning worth ignoring — and it is the only thing standing between the user
 * and losing edits when they close a document.
 */
function editSignature(objects: readonly EditObj[]): string {
  return JSON.stringify(objects);
}

export class App {
  private readonly journal = new Journal();
  private readonly pad: SignaturePad;

  private engine: Engine | null = null;
  private enginePromise: Promise<Engine> | null = null;

  private docs: DocEntry[] = [];
  private activeId: string | null = null;
  /** Suppresses the dirty flag while a document is being loaded into the journal. */
  private switching = false;

  private tool: Tool = 'select';
  private pendingSignature: SignatureResult | null = null;
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
    filesName: must<HTMLElement>('#files-name'),
    filesDialog: must<HTMLDialogElement>('#files-dialog'),
    docList: must<HTMLUListElement>('#doc-list'),
  };

  constructor() {
    this.pad = new SignaturePad(must<HTMLDialogElement>('#sig-dialog'));
  }

  start(): void {
    this.journal.subscribe(() => {
      this.els.undo.disabled = !this.journal.canUndo;
      this.els.redo.disabled = !this.journal.canRedo;
      const doc = this.activeDoc;
      if (doc && !this.switching) {
        doc.dirty = editSignature(this.journal.all()) !== doc.baseline;
      }
    });

    this.bindChrome();
    this.bindFileInput();
    this.bindDragAndDrop();
    this.bindShortcuts();
  }

  private get activeDoc(): DocEntry | undefined {
    return this.docs.find((d) => d.id === this.activeId);
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
      // A pinch changes the zoom without going through the buttons.
      viewer.onZoomChange(() => this.updateZoomLabel());

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
            this.els.filesDialog.close();
            this.els.fileInput.click();
            break;
          case 'files':
            this.renderDocList();
            this.els.filesDialog.showModal();
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

    for (const el of this.els.filesDialog.querySelectorAll<HTMLElement>('[data-files="close"]')) {
      el.addEventListener('click', () => this.els.filesDialog.close());
    }

    for (const el of document.querySelectorAll<HTMLElement>('[data-tool]')) {
      el.addEventListener('click', () => this.setTool(el.dataset['tool'] as Tool));
    }

    // Refitting on rotate keeps a page filling the width instead of leaving the
    // reader pinch-zooming after every orientation change.
    let resizeTimer: number | undefined;
    window.addEventListener('resize', () => {
      if (!this.activeDoc) return;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        this.engine?.viewer.fitWidth();
        this.updateZoomLabel();
      }, 150);
    });

    const viewport = window.visualViewport;
    if (viewport) {
      // Publishes the visual viewport as CSS variables so the chrome layer can
      // sit on it and undo the pinch zoom. Without this the toolbar magnifies
      // with the page and slides off screen, since fixed elements are anchored
      // to the layout viewport rather than the visible area.
      const sync = () => {
        // A resize also means the keyboard opened or closed. Snapping the layout
        // viewport back keeps the chrome from being drawn in one place and
        // clickable in another.
        if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
        const root = document.documentElement.style;
        root.setProperty('--vv-left', `${viewport.offsetLeft}px`);
        root.setProperty('--vv-top', `${viewport.offsetTop}px`);
        root.setProperty('--vv-width', `${viewport.width}px`);
        root.setProperty('--vv-height', `${viewport.height}px`);
        root.setProperty('--vv-inv', String(1 / viewport.scale));
      };
      // Scroll as well as resize: panning a zoomed page moves the visual
      // viewport without resizing it, and the chrome has to follow.
      viewport.addEventListener('resize', sync);
      viewport.addEventListener('scroll', sync);
      sync();
    }

    window.addEventListener('beforeunload', (event) => {
      if (!this.docs.some((d) => d.dirty)) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  private bindFileInput(): void {
    this.els.fileInput.addEventListener('change', () => {
      const file = this.els.fileInput.files?.[0];
      if (file) void this.openFile(file, file.name);
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
      void this.openFile(file, file.name);
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
      } else if (key === 's' && this.activeDoc) {
        event.preventDefault();
        void this.save();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  private async openFile(blob: Blob, name: string): Promise<void> {
    // Re-picking a file that is already open should switch to it, keeping its
    // edits, rather than silently starting a second copy alongside them.
    const existing = this.docs.find((d) => d.name === name && d.blob.size === blob.size);
    if (existing) {
      await this.activate(existing);
      return;
    }
    const entry: DocEntry = {
      id: newId('d'),
      name,
      blob,
      objects: null,
      baseline: '',
      dirty: false,
      saved: false,
    };
    this.docs.push(entry);
    await this.activate(entry, { isNew: true });
  }

  private async activate(
    entry: DocEntry,
    opts: { isNew?: boolean; allowFallback?: boolean } = {},
  ): Promise<void> {
    if (this.activeId === entry.id) return;

    this.stashActive();
    this.els.loading.hidden = false;
    this.switching = true;
    try {
      const engine = await this.loadEngine();
      this.journal.reset([]);
      // The viewer must be visible before pages are laid out: a hidden
      // container measures zero width, so the fit-to-width scale would be
      // wrong and the IntersectionObserver would never fire. The loading
      // overlay covers it in the meantime.
      this.showDocument(true);
      await engine.viewer.open(entry.blob);

      if (entry.objects === null) {
        // Adopt the FreeText and Ink annotations already in the file so that
        // text and signatures added in a previous session — or in another PDF
        // app — can be moved and removed here too. Only on first open: after
        // that the entry's own edits are the truth, deletions included.
        const hydrated: EditObj[] = [];
        for (const { page, annots } of await engine.viewer.readAnnotations()) {
          hydrated.push(...engine.annotations.annotationsToObjects(page, annots));
        }
        entry.objects = hydrated;
        // The file's own annotations are the starting point, not an edit. A
        // document that arrives with two signatures already in it has not been
        // changed by anyone here.
        entry.baseline = editSignature(hydrated);
      }

      this.activeId = entry.id;
      this.journal.reset(entry.objects);
      this.setTool('select');
      this.updateChrome();
      this.updateZoomLabel();
      engine.overlay.render();
    } catch (err) {
      console.error(err);
      this.activeId = null;
      // A file that cannot be opened at all should not join the list. One that
      // was already open keeps its place and its edits: the failure may be
      // transient, and throwing away a document's work over it is worse than
      // the failure.
      if (opts.isNew) this.docs = this.docs.filter((d) => d.id !== entry.id);
      this.toast(this.describeError(err, 'That PDF could not be opened.'), true);

      // Falling back to another open document beats leaving a blank viewer with
      // documents still listed. Never retry the one that just failed, and only
      // fall back once so a second failure cannot loop.
      const fallback = opts.allowFallback === false ? undefined : this.docs.find((d) => d.id !== entry.id);
      if (fallback) {
        await this.activate(fallback, { allowFallback: false });
      } else {
        this.showDocument(false);
        this.updateChrome();
      }
    } finally {
      this.switching = false;
      this.els.loading.hidden = true;
    }
  }

  /** Move the active document's edits out of the journal and onto its entry. */
  private stashActive(): void {
    const doc = this.activeDoc;
    if (!doc) return;
    this.engine?.overlay.commitEdit();
    doc.objects = [...this.journal.all()];
  }

  private async closeDoc(entry: DocEntry): Promise<void> {
    if (entry.dirty && !confirm(`Close “${entry.name}”? Unsaved edits will be lost.`)) return;

    const index = this.docs.findIndex((d) => d.id === entry.id);
    if (index < 0) return;
    this.docs.splice(index, 1);

    if (entry.id !== this.activeId) {
      this.renderDocList();
      return;
    }

    this.activeId = null;
    const next = this.docs[index] ?? this.docs[index - 1];
    if (next) {
      await this.activate(next);
    } else {
      this.engine?.viewer.close();
      this.journal.reset([]);
      this.showDocument(false);
      this.updateChrome();
      this.els.filesDialog.close();
    }
    this.renderDocList();
  }

  private renderDocList(): void {
    const list = this.els.docList;
    list.replaceChildren();

    if (this.docs.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'doc-empty';
      empty.textContent = 'No PDFs open yet.';
      list.append(empty);
      return;
    }

    for (const doc of this.docs) {
      const item = document.createElement('li');
      item.className = 'doc-item';
      item.classList.toggle('is-active', doc.id === this.activeId);

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'doc-pick';
      pick.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>' +
        '<path d="M14 3v5h5"/></svg>';

      const text = document.createElement('span');
      text.className = 'doc-text';

      const name = document.createElement('span');
      name.className = 'doc-name';
      name.textContent = doc.name;

      // What matters here is whether there is work at risk, not how many
      // objects a page happens to contain. The old count was also misleading,
      // since it included annotations the file already had before it was opened.
      const meta = document.createElement('span');
      meta.className = 'doc-meta';
      if (doc.dirty) {
        meta.classList.add('is-unsaved');
        meta.textContent = 'Edited · not saved yet';
      } else if (doc.saved) {
        meta.textContent = 'Edited · saved';
      } else {
        meta.textContent = 'No changes';
      }

      text.append(name, meta);
      pick.append(text);
      pick.addEventListener('click', () => {
        this.els.filesDialog.close();
        void this.activate(doc);
      });

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'doc-close';
      close.setAttribute('aria-label', `Close ${doc.name}`);
      close.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      close.addEventListener('click', () => void this.closeDoc(doc));

      item.append(pick, close);
      list.append(item);
    }
  }

  private showDocument(loaded: boolean): void {
    for (const el of document.querySelectorAll<HTMLElement>('[data-when]')) {
      el.hidden = el.dataset['when'] === 'loaded' ? !loaded : loaded;
    }
    document.body.classList.toggle('has-doc', loaded);
  }

  private updateChrome(): void {
    const doc = this.activeDoc;
    this.els.filesName.textContent = doc
      ? this.docs.length > 1
        ? `${doc.name} (${this.docs.length})`
        : doc.name
      : 'No file';
  }

  private async save(): Promise<void> {
    const engine = this.engine;
    const doc = this.activeDoc;
    if (!doc || !engine) return;
    engine.overlay.commitEdit();

    const objects = this.journal.all();
    const button = this.els.save;
    button.disabled = true;
    try {
      // Re-read from the Blob rather than keeping a second copy in memory:
      // pdf.js detached the buffer it was given, and a phone editing a 40 MB
      // scan cannot afford to hold the file twice.
      const original = new Uint8Array(await doc.blob.arrayBuffer());
      const bytes = await engine.annotations.exportPdf(original, objects);

      const outcome = await deliverPdf(bytes, exportName(doc.name));
      // Dismissing the share sheet is a decision, not a save. Leave the
      // document dirty and say nothing.
      if (outcome === 'cancelled') return;
      doc.baseline = editSignature(objects);
      doc.dirty = false;
      doc.saved = true;

      const where = outcome === 'shared' ? 'Saved.' : 'Saved to your downloads.';
      const substituted = objects.some(
        (o) => o.kind === 'text' && engine.metrics.hasUnsupportedChars(o.value),
      );
      this.toast(
        substituted
          ? `${where} Some characters are not available in Helvetica and were replaced.`
          : where,
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

    const size = defaultFontSize(event.page.viewport.scale);
    const metrics = engine.metrics.measureText(engine.font, '', size);
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
      size,
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
    // The zoom controls are hidden on a phone to keep the bar uncluttered, but
    // once someone has pinched there has to be a way back to fit-width. Reveal
    // them exactly when they are needed.
    document.body.classList.toggle('is-zoomed', Math.abs(zoom - 1) > 0.01);
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

type Delivery = 'shared' | 'downloaded' | 'cancelled';

/**
 * True only on iOS and iPadOS, where the `download` attribute on a blob URL is
 * ignored: the browser navigates to the blob and shows the PDF instead of
 * saving it. Every browser there is WebKit underneath, so this is a platform
 * check rather than a browser one. iPadOS reports itself as a Mac, so it is
 * told apart by having a touch screen.
 */
function downloadAttributeIsIgnored(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/**
 * Hand the finished PDF to the user.
 *
 * A plain download is what people expect on a desktop: the file lands in
 * Downloads and nothing interrupts. That is the default, and it is what the
 * `download` attribute does everywhere it is honoured — Windows, macOS, Linux,
 * Android alike.
 *
 * The share sheet is used only on iOS and iPadOS, where that attribute does
 * nothing and saving would otherwise be impossible. Chrome on macOS can share
 * files too, but offering it there replaced a one-click download with a menu,
 * which is worse. Capability is the wrong test; the platform's brokenness is
 * the right one.
 */
async function deliverPdf(bytes: Uint8Array, filename: string): Promise<Delivery> {
  const file = new File([bytes as BlobPart], filename, { type: 'application/pdf' });

  if (
    downloadAttributeIsIgnored() &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] })
  ) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      // Anything else — an expired gesture most likely — falls through.
    }
  }

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
  return 'downloaded';
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function must<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${selector}`);
  return el;
}
