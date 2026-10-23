import { headers } from 'next/headers';

import { visitorIp } from '@/lib/avatar-budget';
import { CARD_SIZE, renderPnlCard } from '@/lib/pnl-card-image';
import { cardWho, loadCard } from '@/lib/pnl-card-server';

/// One bet's PnL share card, 1600 x 900 (docs/pnl-share-card/SPEC.md), drawn per request from the bet's BetPlaced log
/// and its pool on chain (pnl-card-server.ts). Cached a minute at most, like /api/avatar, so a removed photo stops
/// showing within the minute. Not a card (made-up, refunded, unresolved, not an account's bet): 404.
export const alt = 'Mako Market PnL card';
export const size = CARD_SIZE;
export const contentType = 'image/png';

const MINUTE = 'public, max-age=60, s-maxage=60';

export default async function Image({ params }: { params: Promise<{ id: string; tx: string; log: string }> }) {
  const { id, tx, log } = await params;
  const c = await loadCard(id, tx, log, visitorIp({ headers: await headers() }));
  // Only "not a card" is cached. A refusal (over the visitor limit, or the store down) is about the caller and an
  // unavailable chain says nothing about the card: never cached, so no viewer or crawler keeps a missing image.
  if (!c.ok) {
    const status = c.reason === 'not_found' ? 404 : c.reason === 'refused' ? 429 : 503;
    return new Response(null, { status, headers: { 'cache-control': c.reason === 'not_found' ? MINUTE : 'no-store' } });
  }
  return renderPnlCard(c.card, await cardWho(c), { 'cache-control': MINUTE });
}
