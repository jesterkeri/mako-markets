'use client';

import { useEffect } from 'react';

// While a modal sheet or dialog is open, the page behind it must not scroll (a tester's phone recording, 2026-10-13:
// swiping on the sign-in sheet scrolled the pools behind it). Locks both <html> and <body> (iOS Safari and Android
// Chrome scroll the root element), counted so two open layers unlock only when the last one closes, and restores the
// exact prior values. The sheet itself also sets `overscroll-behavior: contain` so a swipe at its edge stops there.

let locks = 0;
let prior: { html: string; body: string } | null = null;

export function usePageScrollLock(active = true): void {
  useEffect(() => {
    if (!active) return;
    const html = document.documentElement;
    const body = document.body;
    if (locks === 0) {
      prior = { html: html.style.overflow, body: body.style.overflow };
      html.style.overflow = 'hidden';
      body.style.overflow = 'hidden';
    }
    locks += 1;
    return () => {
      locks -= 1;
      if (locks === 0 && prior) {
        html.style.overflow = prior.html;
        body.style.overflow = prior.body;
        prior = null;
      }
    };
  }, [active]);
}
