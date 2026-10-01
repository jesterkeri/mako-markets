'use client';

import { useMediaQuery } from '@/lib/use-media-query';

/// The width where the desktop layout takes over (`.mk-desk` / `.mk-mob` in mako-shell.css).
export const DESKTOP_QUERY = '(min-width: 1024px)';

/// Whether the desktop layout is the one on screen now, following the window across the breakpoint. False on the
/// server.
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
