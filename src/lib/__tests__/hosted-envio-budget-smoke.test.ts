// Hosted smoke for the shared Envio budget (Codex ME_ROUNDS R5 fix) on the REAL Upstash store, with the real route and
// the real hosted indexer. Skipped unless ME_BUDGET_SMOKE=1; run it with the Preview settings injected in memory, never
// written to a file and never printed:
//
//   ME_BUDGET_SMOKE=1 ENVIO_ROUNDS_GRAPHQL_URL=https://indexer.dev.hyperindex.xyz/<id>/v1/graphql \
//   vercel env run -e preview --git-branch feat/me-rounds-indexer-r3 -- \
//   corepack pnpm@10.32.1 exec vitest run src/lib/__tests__/hosted-envio-budget-smoke.test.ts
//
// It spends real budget: the burst uses the whole rolling minute, so nothing else may be relying on it. Prints counts
// and statuses only, never a URL with a token.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/me-rounds-caller', () => ({ authorizeMeRoundsCaller: async () => ({ ok: true }) }));

const RUN = process.env.ME_BUDGET_SMOKE === '1';
const WINNER = '0x0c3f786653b81fde81820260c9e1c60da02cf6a6';

describe.skipIf(!RUN)('hosted Upstash budget smoke', () => {
  it('configured: an Upstash pair is present (names only)', () => {
    const have = ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL'].filter((k) => !!process.env[k]);
    console.log(`[smoke] Upstash URL variable present: ${have.join(', ') || 'none'}; token present: ${!!(process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN)}`);
    expect(have.length).toBeGreaterThan(0);
  });

  it('the real route answers the round 4 winner through the budget, then a burst stops exactly at the cap', async () => {
    const { GET } = await import('@/app/api/me/rounds/route');
    const b = await import('@/lib/envio-budget');
    const t0 = Date.now();
    const res = await GET(new Request(`http://localhost/api/me/rounds?account=${WINNER}`));
    const body = (await res.json()) as { roundIds?: string[] };
    console.log(`[smoke] route: status ${res.status}, round 4 listed: ${body.roundIds?.includes('4')}, ${Date.now() - t0} ms`);
    expect(res.status).toBe(200);
    expect(body.roundIds).toContain('4');

    // The route's own calls took some slots; fill the rest of the rolling minute and count.
    let admitted = 0;
    let refused = 0;
    const lat: number[] = [];
    for (let i = 0; i < 90; i++) {
      const s = Date.now();
      try {
        await b.reserveEnvioCall('me');
        admitted++;
      } catch (e) {
        expect((e as Error).name).toBe('EnvioBudgetExhausted');
        refused++;
      }
      lat.push(Date.now() - s);
    }
    lat.sort((x, y) => x - y);
    console.log(`[smoke] burst of 90 after the route: admitted ${admitted}, refused ${refused}; reserve latency p50 ${lat[45]} ms, p95 ${lat[85]} ms`);
    expect(refused).toBeGreaterThan(0);
    expect(admitted).toBeLessThanOrEqual(b.ME_ENVIO_PER_MINUTE);
    expect(admitted + refused).toBe(90);

    const busy = await GET(new Request(`http://localhost/api/me/rounds?account=0x${'1'.repeat(40)}`));
    console.log(`[smoke] route while the minute is spent: status ${busy.status} ${JSON.stringify(await busy.json())}`);
    expect(busy.status).toBe(429);
  }, 120_000);

  it('on the real script: after the minute above, Me is at its cap; /stats still gets exactly its own share, then refused', async () => {
    const b = await import('@/lib/envio-budget');
    await expect(b.reserveEnvioCall('me')).rejects.toThrow(/at the cap/);
    let stats = 0;
    for (let i = 0; i < b.STATS_ENVIO_PER_MINUTE + 5; i++) await b.reserveEnvioCall('stats').then(() => stats++, () => undefined);
    console.log(`[smoke] stats after Me used its 70: admitted ${stats} of ${b.STATS_ENVIO_PER_MINUTE + 5} (share ${b.STATS_ENVIO_PER_MINUTE}); project total in the minute <= ${b.ENVIO_PER_MINUTE}`);
    expect(stats).toBe(b.STATS_ENVIO_PER_MINUTE);
  }, 120_000);
});
