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
    navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), { type: 'module' }).catch(() => {
      // Offline support is a nicety; the app works without it.
    });
  });
}
