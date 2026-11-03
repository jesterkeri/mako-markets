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
/// Every card image is no-store (Codex SHARE_CARDS R2 F2, owner 2026-10-24): it carries the account's current name and
/// photo, and a CDN may serve a stale copy past its max-age, so a rename or a removed photo shows on the very next view
/// only if no copy is kept. This covers bet placed (its estimate moves too), result, and a card drawn without its photo.
/// A result card's final chain facts are kept on the server instead (pnl-card-server.ts finalFacts), so redrawing it
/// reads no chain. Only a truly final "not a card" is a 404 cached a minute: a receipt with no matching bet log, a
/// refunded pool, or not an account's bet.

const MINUTE = 'public, max-age=60, s-maxage=60';

const nothing = (status: number, cache: string) => new Response(null, { status, headers: { 'cache-control': cache } });

export async function GET(req: Request, { params }: { params: Promise<{ id: string; tx: string; log: string; state: string }> }) {
  if (new URL(req.url).search !== '') return nothing(404, 'no-store');
  const { id, tx, log, state } = await params;
  const c = await loadCard(id, tx, log, state, visitorIp(req));
  // A refusal (over the visitor limit or a site-wide budget, or the store down) is about the caller, an unavailable
  // chain says nothing about the card, a result not final yet (or a bet neither the ledger nor the server's node has
  // seen yet, result links included) soon will be, and a bet placed link whose pool reads as settled only at the latest block can be undone by a reorg (Codex
  // SHARE_CARDS R1 F4): none of them is cached, so no viewer or crawler keeps a missing image.
  if (!c.ok) {
    const status = c.reason === 'refused' ? 429 : c.reason === 'unavailable' ? 503 : 404;
    return nothing(status, c.reason === 'not_found' ? MINUTE : 'no-store');
  }
  const qr = c.card.variant === 'placed' ? await poolQr(c.poolId) : null;
  const { who } = await cardWho(c);
  return renderShareCard(c.card, who, qr, { 'cache-control': 'no-store' });
}
