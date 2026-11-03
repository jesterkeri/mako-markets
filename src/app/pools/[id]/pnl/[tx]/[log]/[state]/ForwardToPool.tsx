'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/// A visitor who opens a shared card goes straight to the pool the bet was in (Joshua 2026-10-24), keeping the link's
/// query so its share tags reach the pool page. Link previews (X, WhatsApp, Telegram) read this page's card metadata
/// without running scripts, so the card stays the preview; "See the pool" remains for a browser without them.
export function ForwardToPool({ id }: { id: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/pools/${id}${window.location.search}`);
  }, [id, router]);
  return null;
}
