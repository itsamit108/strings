'use client';

import { useEffect } from 'react';

/** Registers the service worker so the app installs and opens without a network. */
export default function PwaRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator) || process.env.NODE_ENV !== 'production') return;
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // Files that loaded before the worker took control still need to be stored for offline use.
        const urls = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((u) => u.startsWith(location.origin));
        reg.active?.postMessage({ type: 'store', urls });
      })
      .catch(() => {});
  }, []);
  return null;
}
