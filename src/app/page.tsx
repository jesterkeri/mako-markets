// ----------------------------------------------------------------------------
// src/app/page.tsx
//
// Server Component shell for the / route. Single responsibility: opt
// the home page out of static prerender + edge cache. The home feed
// reads on-chain markets via wagmi and we never want stale prerendered
// chunks (with stale NEXT_PUBLIC_MAKO_ADDRESS) sticking around the way
// they did when v4 contracts rotated.
//
// The actual page body lives in `_components/HomeClient.tsx`. This
// file MUST stay a Server Component (no 'use client'): config exports
// like `dynamic` are only honored on the server entry of a route.
//
// Mirrors the gate-then-client split already used by /create and
// /create/private.
// ----------------------------------------------------------------------------

import HomeClient from './_components/HomeClient';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  return <HomeClient />;
}
