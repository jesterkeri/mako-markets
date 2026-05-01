import { notFound } from 'next/navigation';

import AaSmokeClient from './AaSmokeClient';

// ----------------------------------------------------------------------------
// /dev/aa-smoke — Phase 1B sub-phase D dev surface.
//
// Server Component gate. First line `notFound()` if `MAKO_STAGE !== 'dev'`
// so production builds AND staging builds with the wrong env return 404
// for both server-render and any client-fetch attempts at this URL.
//
// Why a Server Component wrapper instead of guarding inside the client?
//   - The `notFound()` call here happens during server render; Next.js
//     short-circuits to the 404 page WITHOUT shipping the client component
//     bundle to the browser. A client-side env check would still ship the
//     dev UI to every user.
//   - `process.env.MAKO_STAGE` is server-only (no NEXT_PUBLIC_ prefix). A
//     client-side check would have no access to the value.
//
// `dynamic = 'force-dynamic'` because a static prerender during `next build`
// would resolve `MAKO_STAGE` at build time, freezing the gate at whatever
// the build env said. Forcing dynamic ensures the gate evaluates per
// request, so a deployed build can be flipped between dev/production by
// changing the env var without rebuilding.
//
// Folder is `dev/`, NOT `_dev/` — App Router treats underscore prefixes as
// private (the route would not be reachable). The gate is the security
// boundary, not the folder naming convention.
// ----------------------------------------------------------------------------

export const dynamic = 'force-dynamic';

export default function DevAaSmokePage() {
  if (process.env.MAKO_STAGE !== 'dev') {
    notFound();
  }
  return <AaSmokeClient />;
}
