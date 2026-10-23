// The root release guard at the request boundary (naming plan r8 §7.10; owner decision 2026-10-22: one root guard;
// Codex naming code review R1 F1). Next 16 runs Proxy (formerly Middleware, Node.js runtime) before every matched
// request and awaits it, unlike instrumentation's register(), which Next's route-module path does not await. Loading
// contract.ts throws for any NEXT_PUBLIC_MAKO_ADDRESS without a reviewed record (mako-release-record.ts), so on an
// unreviewed contract this module never loads and no page, route handler or server action is served, including routes
// that never import contract.ts themselves. Static build assets are left out: they cannot act on the contract.
import { NextResponse } from 'next/server';

import { MAKO_RELEASE } from '@/lib/contract';

export function proxy() {
  void MAKO_RELEASE;
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
