import './styles.css';
import { App } from './ui/app.ts';

/**
 * Entry point.
 *
 * The only network request this app ever makes is for its own static assets.
 * There is no backend, no telemetry, and no upload path — a PDF opened here is
 * read with the File API and written back with a Blob download.
 */

new App().start();

// Registering a service worker is what turns "no server calls" into something
// the user can verify: after one visit the app runs with the network off.
// Skipped on file:// where service workers are unavailable.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    // Registered as a classic worker from the site root. A module worker would
    // rule out Firefox and older Safari for no gain — the file has no imports —
    // and BASE_URL keeps the path right when the app is served from a
    // subdirectory, as it is on GitHub Pages project sites.
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Offline support is a nicety; the app works without it.
    });
  });
}
