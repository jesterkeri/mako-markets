// Adversary on 50f5a2a (Codex ME_ROUNDS R3): the state a real indexer is in before its first RoundScheduled. The
// handlers write GlobalStats from the first MakoMarketsV4 event (start block 32603678), but RoundsSource only from
// RoundScheduled (MakoRoundsV1 start block 68759154). So every resync after this schema change passes through a long
// stretch where GlobalStats.rounds is 0 and no RoundsSource row exists. src/lib/__tests__/adversary-me-rounds-source.test.ts
// shows what GET /api/me/rounds answers in that state.

import { describe, it } from 'vitest';
import { createTestIndexer } from 'envio';

type Address = `0x${string}`;

const CHAIN = 10143;
const ALICE: Address = '0x00000000000000000000000000000000000000a1';
const DAY1 = 1_790_000_000;

let block = 33_000_000; // after MakoMarketsV4's start block, before MakoRoundsV1's
const at = (timestamp: number) => ({ block: { number: ++block, timestamp }, transaction: { hash: `0x${block.toString(16).padStart(64, '0')}` as Address } });
const created = (id: bigint, creator: Address, timestamp: number) => ({
  contract: 'MakoMarketsV4' as const,
  event: 'MarketCreated' as const,
  ...at(timestamp),
  params: { id, creator, mType: 1n, oracleRef: `0x${'00'.repeat(32)}`, closeTime: BigInt(timestamp + 3600), question: `Pool ${id}?` },
});

describe('adversary: an indexer that has not reached its first round', () => {
  it('has GlobalStats with rounds 0 and no RoundsSource row', async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: [created(1n, ALICE, DAY1)] } } });
    t.expect(await indexer.GlobalStats.getOrThrow('global')).toMatchObject({ rounds: 0 });
    t.expect(await indexer.RoundsSource.get('rounds')).toBeUndefined();
  });
});
