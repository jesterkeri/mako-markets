// Adversary e2614db: a shared "bet placed" card link whose pool has settled since must still land on the pool page
// with the link's share tags (spec 2026-10-24 rule 3). The page sends a settled placed card on to its result card
// first, and that hop is where the tags can go missing.

import { describe, expect, it, vi } from 'vitest';

const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
vi.mock('next/navigation', () => ({ redirect, notFound: () => { throw new Error('NEXT_NOT_FOUND'); }, useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/avatar-budget', () => ({ visitorIp: () => '203.0.113.7' }));
// The pool settled after the card was shared: loadCard's own answer for a placed card in that case.
vi.mock('@/lib/pnl-card-server', () => ({ loadCard: async () => ({ ok: false, reason: 'settled' }) }));

const { default: ShareCardPage } = await import('@/app/pools/[id]/pnl/[tx]/[log]/[state]/page');

describe('a shared placed card, after its pool settles', () => {
  it('keeps the link’s share tags on the way to the pool', async () => {
    const tx = `0x${'ab'.repeat(32)}`;
    const params = Promise.resolve({ id: '7', tx, log: '0', state: 'placed' });
    const searchParams = Promise.resolve({ utm_source: 'x', utm_campaign: 'pool-7' });
    // Next passes searchParams to every page; this one may or may not read it.
    const call = (ShareCardPage as unknown as (p: { params: typeof params; searchParams: typeof searchParams }) => Promise<unknown>)({ params, searchParams });
    await expect(call).rejects.toThrow(/NEXT_REDIRECT/);
    const to = redirect.mock.calls[0][0];
    const url = new URL(to, 'https://makomarket.xyz');
    // Whether it goes to the result card (whose ForwardToPool reads location.search) or straight to the pool, the tags
    // must survive this server hop, since nothing after it can recover them.
    expect(url.searchParams.get('utm_source')).toBe('x');
    expect(url.searchParams.get('utm_campaign')).toBe('pool-7');
  });
});
