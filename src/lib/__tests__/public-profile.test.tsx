// /u/[address] (13a, Joshua 2026-10-17): a player's public profile. The real page and getPublicProfile over the
// leaderboard's pglite harness (ledger + identity tables); only Next's cache and notFound are stubbed. Both layouts
// render in the DOM (CSS picks one), so texts appear twice.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makoMarketEvents } from '@/db/schema';
import { createTestDb, type TestDb } from '@/lib/leaderboard/__tests__/test-db';

const cacheKeys: string[][] = [];
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: string[]) => {
    cacheKeys.push(keyParts);
    return fn;
  },
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
let currentDb: unknown;
vi.mock('@/db/client', () => ({
  get db() {
    return currentDb;
  },
}));

const { default: PlayerPage } = await import('@/app/u/[address]/page');

const SAFE = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const SAFE_LOWER = SAFE.toLowerCase();
const WALLET = '0x000000000000000000000000000000000000b22d';
const NOBODY = '0x000000000000000000000000000000000000c33e'; // bet-free and never signed in: no account
const NEWBIE = '0x000000000000000000000000000000000000d44f'; // signed in, never bet

let t: TestDb | null = null;
let tx = 0;
afterEach(async () => {
  cleanup();
  cacheKeys.length = 0;
  await t?.close();
  t = null;
});

async function seed() {
  t = await createTestDb();
  currentDb = t.db;
  // users + user_safes stubs come from the leaderboard harness (#214: 0020's triggers name them).
  const { rows } = await t.client.query<{ id: string }>(`INSERT INTO users (email, display_name) VALUES ('kemi@example.com', 'Kemi') RETURNING id`);
  await t.client.query(`INSERT INTO user_safes (user_id, chain_id, safe_address) VALUES ($1, 10143, $2)`, [rows[0].id, SAFE]);
  await t.client.query(`INSERT INTO users (wallet_address) VALUES ($1), ($2)`, [WALLET, NEWBIE]);
  // Kemi (Safe): stakes 2, wins 10 -> +8, #1. The wallet player: stakes 5, never wins -> -5, #2.
  for (const [actor, kind, amount] of [
    [SAFE_LOWER, 'bet', '1000000'],
    [SAFE_LOWER, 'bet', '1000000'],
    [SAFE_LOWER, 'claim', '10000000'],
    [WALLET, 'bet', '5000000'],
  ] as const) {
    tx += 1;
    await t.db.insert(makoMarketEvents).values({
      chainId: 10143,
      contractAddress: '0x00000000000000000000000000000000000000aa',
      version: 'v4',
      marketId: '1',
      kind,
      actor,
      isYes: kind === 'bet' ? true : null,
      amount,
      blockNumber: 100 + tx,
      blockTimestamp: new Date(),
      txHash: `0x${tx.toString(16).padStart(64, '0')}`,
      logIndex: 0,
    });
  }
}

const open = async (address: string) => render(await PlayerPage({ params: Promise.resolve({ address }) }));

describe('/u/[address]', () => {
  it('a named email account, opened by its checksummed Safe: name, #1, profit, bets, volume, address with Copy', async () => {
    await seed();
    const { container } = await open(SAFE);
    expect(screen.getAllByRole('heading', { name: 'Kemi' })).toHaveLength(2);
    const text = container.textContent ?? '';
    expect(text).toContain('#1');
    expect(text).toContain('+8.00');
    expect(text).toContain('2.00'); // volume: USDC staked
    expect(screen.getAllByText(SAFE_LOWER)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
    expect(text).not.toContain('kemi@example.com');
    expect(cacheKeys).toContainEqual(['public-profile', SAFE_LOWER]); // one cache entry per address, any case
  });

  it('an unnamed wallet player: short address as the name, #2 and a loss', async () => {
    await seed();
    const { container } = await open(WALLET);
    expect(screen.getAllByRole('heading', { name: '0x0000…b22d' })).toHaveLength(2);
    expect(container.textContent).toContain('#2');
    expect(container.textContent).toContain('−5.00');
  });

  it('an account with no bets: Unranked, zeros, still a page', async () => {
    await seed();
    const { container } = await open(NEWBIE);
    expect(container.textContent).toContain('Unranked');
    expect(container.textContent).toContain('No bets yet.');
    expect(container.textContent).toContain('0.00');
  });

  it('an address with no Mako Market account, even one that bet: not found, and no rank query (Codex PUBLIC_PROFILE R1 M1)', async () => {
    await seed();
    await t!.client.query(`DELETE FROM users WHERE wallet_address = $1`, [WALLET]); // WALLET bet but now has no account
    const made = Array.from({ length: 50 }, (_, i) => `0x${(0xe000 + i).toString(16).padStart(40, '0')}`);
    for (const a of [NOBODY, WALLET, ...made]) await expect(open(a), a).rejects.toThrow('NOT_FOUND');
    expect(cacheKeys).toEqual([]); // getPublicProfile (the all-players rank query) never ran
  });

  it('anything that is not an address: not found, and no query', async () => {
    await seed();
    for (const bad of ['kemi', '0x123', `${SAFE}00`, 'not-an-address']) await expect(open(bad), bad).rejects.toThrow('NOT_FOUND');
    expect(cacheKeys).toEqual([]);
  });
});
