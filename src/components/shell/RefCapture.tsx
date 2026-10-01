'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { REF_COOKIE, REF_MAX_AGE_SEC, refFromSearch } from '@/lib/ref-tag';

/// Keeps the campaign tag from an X post's link (`?utm_campaign=` or `?ref=`) in a first-party cookie for 30 days,
/// so the account created at the visitor's first sign-in records which post brought it. The latest valid tag wins;
/// an invalid one changes nothing. Renders nothing.
export function RefCapture() {
  const pathname = usePathname();
  useEffect(() => {
    const tag = refFromSearch(window.location.search);
    if (!tag) return;
    try {
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${REF_COOKIE}=${tag}; Max-Age=${REF_MAX_AGE_SEC}; Path=/; SameSite=Lax${secure}`;
    } catch {
      // Cookies blocked: the account simply has no tag.
    }
  }, [pathname]);
  return null;
}
