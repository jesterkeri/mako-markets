import type { Metadata } from 'next';

import { HomeClient } from './_home/HomeClient';

export const metadata: Metadata = { title: 'Mako Market Beta' };

// Rendered per request, never prerendered: a prerendered Home once kept serving chunks with a retired contract
// address baked in after the contract moved (a46925c).
export const dynamic = 'force-dynamic';

/// / (2a): rounds are not open yet, so Home says so, then shows the pools that close soonest and the latest news.
/// (The previous home, `_components/HomeClient.tsx`, is no longer rendered.)
export default function HomePage() {
  return <HomeClient />;
}
