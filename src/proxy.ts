// The root release guard at the request boundary (naming plan r8 §7.10; owner decision 2026-10-22: one root guard;
// Codex naming code review R1 F1). Next 16 runs Proxy (formerly Middleware, Node.js runtime) before every matched
// request and awaits it, unlike instrumentation's register(), which Next's route-module path does not await. Loading
// contract.ts throws for any NEXT_PUBLIC_MAKO_ADDRESS without a reviewed record (mako-release-record.ts), so on an
// unreviewed contract this module never loads and no page, route handler or server action is served, including routes
// that never import contract.ts themselves. Static build assets are left out: they cannot act on the contract.
//
// A share card image has one URL, with no query string (Codex SHARE_CARDS R1 F3): any query is a 404, not cached. The
// image route refuses one too, but Next strips some keys (nxtP*, nxtI*, nextInternalLocale) before a route handler
// sees the request, so the route would draw the card for them and the CDN would keep each as its own entry. Proxy sees
// the query first (nxtP* only renamed), so it refuses them here, before any budget, chain, database or photo work.
//
// Each card, page and image, has one spelling too (adversary r3): Next decodes percent-encoded dynamic segments before
// routing, so /pools/1%338/… is pool 138's card at another URL and CDN entry, and any `%` in a card path is a 404. A bare
// trailing `?` leaves `search` empty, so the image is refused on any `?` at all. Both are read from req.url, which is the
// URL as received because next.config.ts sets skipProxyUrlNormalize; without it Next hands Proxy a URL rebuilt from the
// parsed path and query, with a bare `?` dropped (probed on a built app with `next start`).
import { NextResponse, type NextRequest } from 'next/server';

import { MAKO_RELEASE } from '@/lib/contract';

// A card page, or with /image.png its image.
const CARD = /^\/pools\/[^/]+\/pnl\/[^/]+\/[^/]+\/[^/]+(\/image\.png)?$/;

export function proxy(req: NextRequest) {
  void MAKO_RELEASE;
  const raw = req.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''); // path and query, as received
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  const card = CARD.exec(path);
  if (card && (path.includes('%') || (card[1] !== undefined && q >= 0))) return new NextResponse(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
