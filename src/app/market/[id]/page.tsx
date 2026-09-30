import { permanentRedirect } from 'next/navigation';

/// The old market page. Links already shared on X and elsewhere point here, so it redirects to the redesigned pool
/// page (a 308), whose metadata carries the share preview.
export default async function MarketRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  permanentRedirect(`/pools/${encodeURIComponent(id)}`);
}
