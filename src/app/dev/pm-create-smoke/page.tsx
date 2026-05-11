import { notFound } from 'next/navigation';

import PmCreateSmokeClient from './PmCreateSmokeClient';

// ----------------------------------------------------------------------------
// /dev/pm-create-smoke — Phase 2C-1 dev surface.
//
// Server Component gate. Same pattern as /dev/aa-smoke with an
// additional NODE_ENV check per the v6 plan's negative-smoke
// requirement: "MAKO_STAGE=dev + NODE_ENV=production → 404".
//
// Why a Server Component wrapper instead of guarding inside the client?
//   - notFound() during server render short-circuits to the 404 page
//     WITHOUT shipping the client bundle to the browser. A client-side
//     env check would still ship the dev UI to every user.
//   - process.env.MAKO_STAGE is server-only (no NEXT_PUBLIC_ prefix);
//     a client-side check has no access to the value.
//
// `dynamic = 'force-dynamic'` because a static prerender during
// `next build` would resolve env vars at build time, freezing the
// gate. Forcing dynamic ensures the gate evaluates per request.
//
// Folder is `dev/`, NOT `_dev/` — App Router treats underscore
// prefixes as private (route would be unreachable). The gate is the
// security boundary, not the folder naming convention.
// ----------------------------------------------------------------------------

export const dynamic = 'force-dynamic';

export default function DevPmCreateSmokePage() {
  if (
    process.env.MAKO_STAGE !== 'dev' ||
    process.env.NODE_ENV === 'production'
  ) {
    notFound();
  }
  return <PmCreateSmokeClient />;
}
