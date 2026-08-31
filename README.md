# Local PDF Editor

Add text and a handwritten signature to a PDF, and remove either one again — entirely in the
browser. There is no backend. The only network requests the app ever makes are for its own static
files, and after the first visit a service worker serves those from disk, so it runs with the
network off.

```
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production bundle into dist/
npm test           # end-to-end smoke test in Chromium
```

`dist/` is plain static files. Any static host works, or open it from disk.

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` builds and publishes on every push to the default branch. Two manual
steps are needed first, once each, and neither can be automated:

1. **The repository must be public**, unless the account is on Pro, Team, or Enterprise. Pages is
   not available for private repositories on GitHub Free.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   `actions/configure-pages` has an `enablement: true` option that looks like it would do this, but
   the default `GITHUB_TOKEN` cannot create a Pages site — it fails with "Resource not accessible by
   integration".

Worth knowing before paying to avoid step 1: on Pro and Team a private repository can publish, but
**the resulting site is still publicly viewable**. Restricting who can open the site requires
Enterprise Cloud. If access control is the goal, a host with built-in protection (Cloudflare Pages
with Access, for instance) is the better fit.

Making this repository public costs nothing in privacy terms. It holds no secrets, and the app's
guarantee is about where your PDF goes, not who can read the source — if anything, public source
makes "nothing is uploaded" checkable rather than merely claimed.

Then re-run the latest workflow from the Actions tab, or push again. The site lands at
`https://<user>.github.io/<repo>/`.

The **first** deployment usually 404s for a few minutes after the workflow goes green — Pages
reports success before the site is actually being served. Later deploys are immediate.

`404.html` is written at build time as a copy of the built `index.html`, so a mistyped or stale URL
under the site opens the app rather than GitHub's error page.

Two things make a project site work, and both are covered by `npm test`:

- Vite is configured with `base: './'`, so assets resolve from a subdirectory rather than the domain
  root.
- The service worker is served from the site root, not from hashed `assets/`, so its scope covers
  the whole app.

`test/pages-check.mjs` serves `dist/` under a subpath exactly as Pages does, then takes the network
away and reloads. If it still opens and renders a PDF, the "runs entirely on your device" claim is
true in the literal sense.

## What it does

Four actions, which are really two:

| Action | Implementation |
| --- | --- |
| Add text | append a `text` object to the edit journal |
| Remove text | remove that object |
| Add signature | append a `sig` object |
| Remove signature | remove that object |

"Remove" applies to objects **you added** — in this session, in a previous one, or in another PDF
app. It does not delete text that is baked into the page's content stream; see
[Limitations](#limitations).

Several PDFs can be open at once. The button in the header opens a list to switch between them; each
keeps its own edits, so coming back to a document finds it exactly as you left it. Only the active
document's edits live in the journal — the rest are stashed on their entry and restored on switch.

## How it works

```
original PDF bytes ──► pdf.js ──► page canvases          (read-only, never modified)
                                       ▲
                     edit journal ─────┘ overlay DOM     (everything you can select)
                          │
                          └────────► pdf-lib ──► /Annots (only on save)
```

**The file is never mutated while editing.** Edits live in an in-memory journal
(`src/core/journal.ts`) and are drawn as an ordinary DOM overlay on top of the rendered pages. That
makes undo/redo free, keeps interaction off the re-render path, and makes removal an array filter.

**Saving writes real PDF annotations,** not flattened page content:

- added text → a `/FreeText` annotation
- a signature → an `/Ink` annotation, whose `/InkList` is literally the stroke points

Because they live in each page's `/Annots` array rather than in the content stream, your additions
stay removable after a save and reopen — here, and in Acrobat or Preview. On load the app reads
those annotations back into the journal, so the round trip is closed.

Every annotation is written with an explicit `/AP` appearance stream. Without one, viewers disagree
about how to draw an annotation; some synthesise an appearance from `/DA` and some draw nothing.
The appearance form's `/BBox` is set equal to the annotation `/Rect` with an identity `/Matrix`, so
form space and page space coincide and the operators can use absolute page coordinates.

### Fidelity

Text is measured with the real Helvetica AFM widths through pdf-lib (`src/core/metrics.ts`), and
both the on-screen overlay and the exporter use that same measurement. There is deliberately no
auto-wrapping — a wrap implemented once in CSS and once in the exporter would drift, and drift
shows up as text that moves when you save. The box hugs the widest line you typed.

### Zoom

Pinch is handled by the app, not the browser. `touch-action: pan-x pan-y` withholds
zoom gestures from the browser, and the viewer turns them into document zoom, re-rendering
through pdf.js at the new scale.

This is not a preference. Browser zoom magnifies the rasterised page, so the document goes
blurry; and it leaves fixed elements anchored to the layout viewport, which sends the toolbar
drifting and eventually off screen. Suppressing it with `user-scalable=no` is not an option
either — iOS Safari ignores that, and it would be the wrong thing to do to a document viewer.
Owning the gesture solves all of it: the page stays sharp because it is re-rendered, and the
browser viewport never changes so the chrome never moves.

During the gesture the existing bitmaps are stretched and it goes momentarily soft;
re-rasterising every frame would swamp the worker. They are re-rendered sharp when the
fingers lift.

### Mobile

The three things that actually decide whether this survives on a phone:

- **Lazy loading.** pdf.js and pdf-lib are ~300 kB gzipped between them and neither is needed until
  a file exists. They load on first open, behind a spinner. Initial payload is about 11 kB gzipped.
- **A canvas pixel budget.** Rendering at full device pixel ratio on a 3× screen produces canvases
  large enough for iOS to discard the tab. Scale is capped at 2×, then reduced further if a page
  would still exceed 8 MP. On a DPR-3 phone an A4 page rasterises to ~0.77 MP.
- **Page windowing and explicit disposal.** Page shells are laid out at true size immediately so
  the scrollbar is correct, but only pages near the viewport hold a canvas. WebKit does not promptly
  reclaim canvas backing stores, so canvases are shrunk to 0×0 before being dropped.

Saving re-reads the file from its `Blob` rather than keeping a second copy in memory — pdf.js
detaches the buffer it is given, and a phone editing a 40 MB scan cannot afford to hold the file
twice.

The app uses pdf.js's **legacy** build. The modern bundle calls very new platform APIs
(`Map.prototype.getOrInsertComputed` among them) and throws outright on browsers a year or two old,
including the iOS Safari versions this is meant to run on.

## Layout

```
src/core/     framework-free: journal, geometry, metrics, signature maths,
              annotation read/write, pdf.js viewer
src/ui/       overlay (selection, drag, resize, inline editing), signature pad, wiring
test/         end-to-end smoke test + render harness
```

There is no UI framework. The three performance-critical paths — page rendering, signature capture,
and drag — all bypass a framework by nature, leaving it responsible for a toolbar and two modals.
The split above means adding React later would mean writing a new `src/ui/`, not a rewrite.

## Testing

`npm test` drives the real production bundle in Chromium: it opens a PDF, adds text, draws and
places a signature, saves, then inspects the bytes it produced. Beyond checking the annotation
structure it re-renders the saved file with annotations *enabled* — the opposite of what the app
does — and counts dark pixels inside the Ink annotation's own `/Rect`. That is the only way to prove
the hand-written appearance streams actually paint, and paint in the right place.

## Limitations

- **Text already in the PDF cannot be removed.** Doing that means parsing and rewriting page content
  streams — font encodings, `TJ` kerning arrays, Form XObjects. Out of scope here.
- **Encrypted (password-protected) PDFs are rejected.** pdf.js can decrypt for viewing but pdf-lib
  cannot write them back.
- **Only FreeText and Ink annotations are shown.** Pages render with annotations disabled so the
  overlay is the single source of truth; other annotation types (links, highlights, form widgets)
  are preserved in the file but neither drawn nor editable.
- **Helvetica only.** Standard-14, so it costs zero embedded bytes, but the character set is WinAnsi
  — including smart quotes and dashes. Anything outside it is replaced with `?` and the app says so
  on save. Full Unicode would need font subsetting via `@pdf-lib/fontkit`.
- **Saving rewrites the whole document.** An incremental update (original bytes + new objects + an
  xref with `/Prev`) would make saving a large file near-instant. It is a natural next step because
  nothing existing is ever modified.
- **Editing invalidates an existing digital signature,** as any modification does.
- **Pages are rendered whole, not tiled.** At high zoom the full page is rasterised even though
  a fraction of it is visible, so the canvas pixel budget starts reducing density past roughly
  4x. A tiled renderer would hold sharpness further, at considerably more complexity.
- **The offline cache is never pruned.** Asset names are content-hashed, so a redeploy adds
  entries rather than replacing them and the cache grows slowly across deployments. The browser
  evicts under storage pressure, so this is untidy rather than harmful.
