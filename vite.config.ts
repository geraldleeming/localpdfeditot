import { defineConfig } from 'vite';

export default defineConfig({
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
