'use client';

import { useCallback, useSyncExternalStore } from 'react';

/// The person has asked for less motion (DESIGN_RULES: reduced motion is fade only).
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/// Whether a media query matches now, following changes. False on the server.
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
      }
      // Safari before 14 has only the older listener API.
      mql.addListener?.(onChange);
      return () => mql.removeListener?.(onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY);
}

/// The same, read once outside React (an effect deciding how to scroll).
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}
