// ----------------------------------------------------------------------------
// price-recorder/src/bundle-spike.ts
//
// Bundling spike (CHARTS_DS_PLAN 3.1, commit 1): proves wrangler's bundler takes the resolver's decoder from
// cf-worker/src/datastreams.ts, outside this package, with viem resolved here. `pnpm bundle:spike` builds this entry
// with `wrangler deploy --dry-run` and scripts/run-spike.mjs runs the bundle on a real captured report, comparing the
// decode with the verifier-checked fixture. Never deployed.
// ----------------------------------------------------------------------------

import { FEED_BY_SYMBOL } from './feeds';
import { validEntry } from './entry';

const spike = {
  async fetch(request: Request): Promise<Response> {
    const entry = (await request.json()) as Record<string, unknown>;
    const v = validEntry(entry, FEED_BY_SYMBOL.get('BTC')!);
    if (!v || v.report.schema !== 3) return Response.json({ ok: false }, { status: 422 });
    const r = v.report;
    return Response.json({ ok: true, feedId: r.feedId, validFromTimestamp: r.validFromTimestamp, observationsTimestamp: r.observationsTimestamp, expiresAt: r.expiresAt, price: r.price.toString(), bid: r.bid.toString(), ask: r.ask.toString() });
  },
};

export default spike;
