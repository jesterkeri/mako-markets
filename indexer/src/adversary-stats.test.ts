// Adversary pass on fdebf29: a pool settled or refunded is counted exactly once, in the right bucket, whatever order or
// number of resolution events the contract emits. Events are built in the shape indexer.test.ts uses.

import { describe, it } from 'vitest';
import { createTestIndexer } from 'envio';

type Address = `0x${string}`;

const CHAIN = 10143;
const ALICE: Address = '0x00000000000000000000000000000000000000a1';
const BOB: Address = '0x00000000000000000000000000000000000000b2';
const DAY1 = 1_790_000_000;
const USDC = 1_000_000n;

let block = 34_000_000;
const at = (timestamp: number) => ({ block: { number: ++block, timestamp }, transaction: { hash: `0x${block.toString(16).padStart(64, '0')}` as Address } });

const created = (id: bigint, creator: Address, timestamp: number) => ({
  contract: 'MakoMarketsV4' as const,
  event: 'MarketCreated' as const,
  ...at(timestamp),
  params: { id, creator, mType: 1n, oracleRef: `0x${'00'.repeat(32)}`, closeTime: BigInt(timestamp + 3600), question: `Pool ${id}?` },
});
const bet = (id: bigint, user: Address, isYes: boolean, amount: bigint, timestamp: number) => ({
  contract: 'MakoMarketsV4' as const,
  event: 'BetPlaced' as const,
  ...at(timestamp),
  params: { id, user, isYes, amount },
});
const resolved = (id: bigint, outcome: bigint, timestamp: number) => ({
  contract: 'MakoMarketsV4' as const,
  event: 'MarketResolved' as const,
  ...at(timestamp),
  params: { id, outcome },
});

describe('adversary: one pool, one resolution count', () => {
  it('a refund after a YES resolution leaves the pool counted once, in the bucket of the status it ends with', async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            created(7n, ALICE, DAY1),
            bet(7n, ALICE, true, USDC, DAY1),
            bet(7n, BOB, false, USDC, DAY1 + 10),
            resolved(7n, 1n, DAY1 + 3700),
            resolved(7n, 3n, DAY1 + 3800),
          ],
        },
      },
    });
    // Whichever status a fix keeps (first resolution or last), the counts must agree with it and count the pool once.
    const { status } = await indexer.Pool.getOrThrow('7');
    t.expect(await indexer.GlobalStats.getOrThrow('global')).toMatchObject({
      communityPools: 1,
      communityPoolsSettled: 1,
      communityPoolsRefunded: status === 'Refund' ? 1 : 0,
    });
  });

  it('the same resolution delivered twice counts the pool once', async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [created(8n, ALICE, DAY1), bet(8n, ALICE, true, USDC, DAY1), resolved(8n, 3n, DAY1 + 3700), resolved(8n, 3n, DAY1 + 3700)],
        },
      },
    });
    t.expect(await indexer.GlobalStats.getOrThrow('global')).toMatchObject({
      communityPools: 1,
      communityPoolsSettled: 1,
      communityPoolsRefunded: 1,
    });
  });
});
