'use client';

import { useSyncExternalStore } from 'react';

/// The width where the desktop layout takes over (`.mk-desk` / `.mk-mob` in mako-shell.css).
export const DESKTOP_QUERY = '(min-width: 1024px)';

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(DESKTOP_QUERY);
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }
  // Safari before 14 has only the older listener API.
  mql.addListener?.(onChange);
  return () => mql.removeListener?.(onChange);
}

/// Whether the desktop layout is the one on screen now, following the window across the breakpoint. False on the
/// server.
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}
