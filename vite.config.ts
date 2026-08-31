import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig, type Plugin } from 'vite';

/**
 * GitHub Pages serves `404.html` for any path it cannot match. Shipping a copy
 * of the app there means a mistyped or stale URL under the site still opens the
 * editor instead of GitHub's error page.
 *
 * It has to be a copy of the *built* index.html rather than a static file in
 * `public/`, because only the built one references the content-hashed assets.
 * Relative asset paths resolve correctly from any single-segment path, which is
 * what a wrong URL almost always is.
 */
function pagesFallback(): Plugin {
  return {
    name: 'pages-404-fallback',
    apply: 'build',
    closeBundle() {
      const dir = resolve(import.meta.dirname, 'dist');
      copyFileSync(resolve(dir, 'index.html'), resolve(dir, '404.html'));
    },
  };
}

export default defineConfig({
  plugins: [pagesFallback()],
  // Relative base so the built bundle works from any static path
  // (GitHub Pages project sites, a subfolder, a local file server).
  base: './',
  build: {
    target: 'es2022',
    // pdf.js is large; the worker is a separate chunk loaded on demand.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Split the two heavyweights apart so a change to app code does not
        // invalidate a megabyte of cached library.
        manualChunks(id: string) {
          if (id.includes('node_modules/pdfjs-dist')) return 'pdfjs';
          if (id.includes('node_modules/pdf-lib') || id.includes('node_modules/@pdf-lib')) {
            return 'pdflib';
          }
          return undefined;
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
