import { notFound } from 'next/navigation';
import { devPagesAllowed } from '@/lib/dev-pages';

import { RoundsPreview } from './RoundsPreview';

export const dynamic = 'force-dynamic';

/// Dev-only preview of the Rounds screens with sample rounds, before MakoRoundsV1 is deployed:
/// /dev/rounds-preview?view=list|open|live|settled|refund. Gated like the other /dev pages; production answers 404.
export default async function DevRoundsPreviewPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (!devPagesAllowed()) notFound();
  const { view } = await searchParams;
  return <RoundsPreview view={view ?? 'list'} />;
}
