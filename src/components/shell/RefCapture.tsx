'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { REF_COOKIE, REF_MAX_AGE_SEC, refFromSearch } from '@/lib/ref-tag';

/// Keeps the campaign tag from an X post's link (`?utm_campaign=` or `?ref=`) in a first-party cookie for 30 days,
/// so the account created at the visitor's first sign-in records which post brought it. The latest valid tag wins;
/// an invalid one changes nothing. It re-checks on every query-string change, including an in-app link to the same
/// page with a new tag. Renders nothing; render it inside <Suspense> (it reads the search params).
export function RefCapture() {
  const search = useSearchParams();
  useEffect(() => {
    const tag = refFromSearch(`?${search?.toString() ?? ''}`);
    if (!tag) return;
    try {
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${REF_COOKIE}=${tag}; Max-Age=${REF_MAX_AGE_SEC}; Path=/; SameSite=Lax${secure}`;
    } catch {
      // Cookies blocked: the account simply has no tag.
    }
  }, [search]);
  return null;
}
