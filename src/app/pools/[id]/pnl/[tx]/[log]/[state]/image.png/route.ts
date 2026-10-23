import { visitorIp } from '@/lib/avatar-budget';
import { renderShareCard } from '@/lib/pnl-card-image';
import { cardWho, loadCard } from '@/lib/pnl-card-server';
import { poolQr } from '@/lib/pool-qr';

/// GET <card page>/image.png: one bet's share card, 1600 x 900 (docs/pnl-share-card/SPEC.md), drawn from the bet's
/// BetPlaced log and its pool on chain (pnl-card-server.ts). The page's metadata, its <img> and the share sheet all use
/// this one URL. A route handler, not the opengraph-image convention (Codex SHARE_CARDS R1 F3): that convention's image
/// function gets no Request, so it could not refuse a query, and every query was a separate CDN entry; and where
/// generateMetadata set no image, Next advertised it as `opengraph-image?<hash>`. Here any query string at all is a
/// 404, before any budget, chain, database or photo work, as /api/avatar does; src/proxy.ts refuses it first, including
/// the keys Next strips before this runs.
/// The state is in the URL, so a cached bet placed card never stands in for the result (owner, 2026-10-23):
///  - placed: drawn again when opened, cached a minute at most, because the estimate moves with the pot;
///  - result: the pool settled in a finalized block, so the figures are final; the image is still cached a minute at
///    most (Codex SHARE_CARDS R1 F2), because it carries the account's current name and photo, and a renamed account or
///    a removed photo must stop being served, as /api/avatar's photos do.
/// A card drawn without the account's photo (the photo could not be fetched) is never cached, so it never stands in
/// for the account's card. Not a card (made-up, refunded, not an account's bet): 404, cached a minute.

const MINUTE = 'public, max-age=60, s-maxage=60';

const nothing = (status: number, cache: string) => new Response(null, { status, headers: { 'cache-control': cache } });

export async function GET(req: Request, { params }: { params: Promise<{ id: string; tx: string; log: string; state: string }> }) {
  if (new URL(req.url).search !== '') return nothing(404, 'no-store');
  const { id, tx, log, state } = await params;
  const c = await loadCard(id, tx, log, state, visitorIp(req));
  // A refusal (over the visitor limit or the site-wide budget, or the store down) is about the caller, an unavailable
  // chain says nothing about the card, a result not final yet (or a bet the server's node has not seen yet) soon will
  // be, and a bet placed link whose pool reads as settled only at the latest block can be undone by a reorg (Codex
  // SHARE_CARDS R1 F4): none of them is cached, so no viewer or crawler keeps a missing image.
  if (!c.ok) {
    const status = c.reason === 'refused' ? 429 : c.reason === 'unavailable' ? 503 : 404;
    return nothing(status, c.reason === 'not_found' ? MINUTE : 'no-store');
  }
  const qr = c.card.variant === 'placed' ? await poolQr(c.poolId) : null;
  const { who, complete } = await cardWho(c);
  // Drawn without the account's photo (avatar budget spent, or the photo fetch failed): shown, never cached.
  return renderShareCard(c.card, who, qr, { 'cache-control': complete ? MINUTE : 'no-store' });
}
