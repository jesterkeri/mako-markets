import { headers } from 'next/headers';

import { visitorIp } from '@/lib/avatar-budget';
import { CARD_SIZE, renderShareCard } from '@/lib/pnl-card-image';
import { cardWho, loadCard } from '@/lib/pnl-card-server';
import { poolQr } from '@/lib/pool-qr';

/// One bet's share card, 1600 x 900 (docs/pnl-share-card/SPEC.md), drawn from the bet's BetPlaced log and its pool on
/// chain (pnl-card-server.ts). The state is in the URL, so a cached bet placed card never stands in for the result
/// (owner, 2026-10-23):
///  - placed: drawn again when opened, cached a minute at most, because the estimate moves with the pot;
///  - result: the pool settled in a finalized block, so the card is complete and cached for good, with the name and
///    photo it was first drawn with. A card drawn without the account's photo (the photo could not be fetched) is
///    never cached, so it never stands in for the account's card.
/// Not a card (made-up, refunded, not an account's bet, a placed link once settled): 404, cached a minute.
export const alt = 'Mako Market share card';
export const size = CARD_SIZE;
export const contentType = 'image/png';

const MINUTE = 'public, max-age=60, s-maxage=60';
const FOREVER = 'public, max-age=31536000, s-maxage=31536000, immutable';

export default async function Image({ params }: { params: Promise<{ id: string; tx: string; log: string; state: string }> }) {
  const { id, tx, log, state } = await params;
  const c = await loadCard(id, tx, log, state, visitorIp({ headers: await headers() }));
  // A refusal (over the visitor limit, or the store down) is about the caller, an unavailable chain says nothing about
  // the card, and a result not final yet soon will be: none of them is cached, so no viewer or crawler keeps a missing
  // image.
  if (!c.ok) {
    const status = c.reason === 'refused' ? 429 : c.reason === 'unavailable' ? 503 : 404;
    const keep = c.reason === 'not_found' || c.reason === 'settled';
    return new Response(null, { status, headers: { 'cache-control': keep ? MINUTE : 'no-store' } });
  }
  const qr = c.card.variant === 'placed' ? await poolQr(c.poolId) : null;
  const { who, complete } = await cardWho(c);
  // Drawn without the account's photo (avatar budget spent, or the photo fetch failed): shown, never cached.
  const cache = !complete ? 'no-store' : c.state === 'result' ? FOREVER : MINUTE;
  return renderShareCard(c.card, who, qr, { 'cache-control': cache });
}
