// ----------------------------------------------------------------------------
// src/app/create/private/page.tsx
//
// Server Component shell for the public Create Private Market page.
// Single responsibility: gate the route on NEXT_PUBLIC_PM_ENABLED;
// render the client child only when PM surfaces are enabled.
//
// The actual page body — all hooks, form state, wallet checks,
// validation — lives in `_components/CreatePrivateClient.tsx`. This
// file MUST stay a Server Component (no 'use client' directive); the
// gate runs before any client JS ships.
//
// Plan: C:/Users/hr/AppData/Local/Temp/mako-pm-gate-plan.md (round 5).
// Memory: [[mako-pm-gate]].
// ----------------------------------------------------------------------------

import { notFound } from 'next/navigation';

import { isPmEnabled } from '@/lib/pm-enabled';

import CreatePrivateClient from './_components/CreatePrivateClient';

// Skip static prerender. The gate reads NEXT_PUBLIC_PM_ENABLED at
// request time; without force-dynamic, an unset flag during build
// triggers notFound() at static-generation time, which makes Next
// prerender /_not-found and crashes on any client component in the
// root layout that uses useSearchParams() without Suspense.
export const dynamic = 'force-dynamic';

export default function CreatePrivatePage() {
  if (!isPmEnabled()) notFound();
  return <CreatePrivateClient />;
}
