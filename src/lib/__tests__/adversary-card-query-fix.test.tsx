// Adversary on 2cb62bd (fix/card-share-links): the card page rebuilds the link's query from Next's searchParams
// object, not from the URL. Next 16.2.3 builds that object with searchParamsToUrlQuery
// (next/dist/shared/lib/router/utils/querystring.js), a plain {} whose lookups fall through to Object.prototype, then
// spreads it into the page's query (next/dist/server/route-modules/route-module.js:453). The searchParams here are
// built the same way, with Next's own parseUrl, from the shared link. The bet log is pool #138's real BetPlaced log
// re-encoded at the CI contract address, as in pnl-card-state.test.ts (provenance in adversary-pnl-card.test.ts).

import { parseUrl } from 'next/dist/shared/lib/router/utils/parse-url';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { MAKO_ADDRESS, makoAbi, MarketType, Outcome, type MarketWithId } from '../contract';

const U = 1_000_000n;
const TX = '0xc9aadd0eb54e82a93ccb9d7999684adc6546ff1b3689707dfe7604e2b6b74946';
const BETTOR = '0x67D68Eb043f5bCf0898719Ad9a886090148032A0';

const OPEN: MarketWithId = {
  id: 138n,
  creator: BETTOR,
  mType: MarketType.FOREX,
  oracleRef: '0x4555525553443a67743a312e3100000000000000000000000000000000000000',
  question: 'Will EURUSD trade above 1.1 in 5 minutes?',
  createdAt: 1792134704n,
  closeTime: 1792135062n,
  bettingCloseTime: 1792134882n,
  totalYes: U,
  totalNo: U,
  yesBettorCount: 1,
  noBettorCount: 1,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};
const SETTLED: MarketWithId = { ...OPEN, outcome: Outcome.YES, resolved: true };

const chain = vi.hoisted(() => ({ latest: null as unknown as MarketWithId }));
vi.mock('@/lib/pool-share', () => ({
  poolIdFrom: (s: string) => (/^\d{1,18}$/.test(s) ? BigInt(s) : null),
  readPoolForShare: async () => chain.latest,
  shareClient: () => ({
    getTransactionReceipt: async () => ({
      status: 'success',
      blockNumber: 71474204n,
      logs: [
        {
          address: MAKO_ADDRESS.toLowerCase(),
          logIndex: 5,
          topics: encodeEventTopics({ abi: makoAbi, eventName: 'BetPlaced', args: { id: 138n, user: BETTOR } }),
          data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [true, U]),
        },
      ],
    }),
    getBlock: async () => ({ timestamp: 1792134750n }),
  }),
}));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/lib/avatar-budget', () => ({ reserveAvatarVisitor: async () => true, reserveCardLoad: async () => true,
  reserveCardLookup: async () => true, reserveCardRender: async () => true, reserveAvatarFetch: async () => false, visitorIp: () => '203.0.113.7' }));
vi.mock('@/lib/leaderboard/identity', () => ({ resolveStoredIdentities: async () => new Map() }));
vi.mock('@/lib/leaderboard/profile', () => ({ isRegistered: async () => true }));
vi.mock('@/lib/mako-labels-server', () => ({ getMakoLabels: async () => null }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

const SHARED = `https://makomarket.xyz/pools/138/pnl/${TX}/5/placed?utm_source=x&constructor=y`;
const params = () => Promise.resolve({ id: '138', tx: TX, log: '5', state: 'placed' });
// What Next hands the page for SHARED (route-module.js:453 spreads parsedUrl.query).
const nextSearchParams = () => Promise.resolve({ ...parseUrl(SHARED).query } as Record<string, string | string[] | undefined>);

describe('a shared link whose query has a key named like an Object.prototype member', () => {
  it('"See the pool" keeps the query as shared', async () => {
    const { default: Page } = await import('@/app/pools/[id]/pnl/[tx]/[log]/[state]/page');
    chain.latest = OPEN;
    const page = (await Page({ params: params(), searchParams: nextSearchParams() })) as { props: { children: { props: { href?: string } }[] } };
    expect(page.props.children[1].props.href).toBe('/pools/138?utm_source=x&constructor=y');
  });

  it('the settled redirect keeps the query as shared', async () => {
    const { default: Page } = await import('@/app/pools/[id]/pnl/[tx]/[log]/[state]/page');
    chain.latest = SETTLED;
    const err = await Page({ params: params(), searchParams: nextSearchParams() }).then(() => null, (e: unknown) => e);
    expect((err as { digest?: string } | null)?.digest).toContain(`/pools/138/pnl/${TX}/5/result?utm_source=x&constructor=y;`);
  });
});
