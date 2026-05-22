// ----------------------------------------------------------------------------
// src/app/create/page.tsx
//
// Server Component shell for the /create route. Single responsibility:
// opt out of static prerender so the Client body's useSearchParams()
// call (and HoverRevealPicker's same call) don't trip Next 16's
// missing-suspense-with-csr-bailout check at build time.
//
// The actual page body lives in `_components/CreateClient.tsx`. This
// file MUST stay a Server Component (no 'use client'): config exports
// like `dynamic` are only honored on the server entry of a route.
//
// Mirrors the gate-then-client split already used by /create/private.
// ----------------------------------------------------------------------------

import CreateClient from './_components/CreateClient';

export const dynamic = 'force-dynamic';

export default function CreatePage() {
  return <CreateClient />;
}
