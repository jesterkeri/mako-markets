import { notFound } from 'next/navigation';
import { devPagesAllowed } from '@/lib/dev-pages';

import { Preview } from './Preview';

export const dynamic = 'force-dynamic';

/// Dev-only preview of the confirm sheet: /dev/confirm-sheet?state=review|pending|done|cancelled|failed
/// &wallet=mako|external. Gated like the other /dev pages; production answers 404.
export default async function DevConfirmSheetPage({ searchParams }: { searchParams: Promise<{ state?: string; wallet?: string }> }) {
  if (!devPagesAllowed()) notFound();
  const q = await searchParams;
  return <Preview state={q.state ?? 'review'} wallet={q.wallet ?? 'mako'} />;
}
