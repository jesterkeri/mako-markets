import { NextResponse } from 'next/server';

import { discoverMeRounds, IndexerNotConfigured, TooManyRows } from '@/lib/me-rounds-indexer';
import type { MeRoundsDiscoveryWire } from '@/lib/me-rounds-discovery';
import { ttlMemo, type Memoized } from '@/lib/ttl-memo';

/**
 * GET /api/me/rounds?account=0x…
 *
 * The round ids Me reads on chain for one account (src/lib/me-rounds-discovery.ts): every round the account entered or
 * created, and every round the indexer still has as Active, from the Envio indexer (ENVIO_GRAPHQL_URL), with the last
 * round the indexer has seen scheduled and that round's fingerprint (`head`: openTime, startTime, creator), which the
 * browser compares with roundOf on chain before it trusts the rest (Codex ME_ROUNDS R2: the answer is bound to this
 * Rounds contract, never assumed). Ids only; the amounts are read from the chain by the browser. Round entries and
 * creators are public chain data, so the route needs no session.
 *
 *   200 { roundIds: ["3", "7", ...], indexedThrough: "400",
 *         head: { id: "400", openTime: "1760000000", startTime: "1760000900", creator: "0x…" } }   head null iff 0 rounds
 *   400 { error: "bad_account" }        not exactly one `account`, or not a 0x address (any letter case)
 *   503 { error: "not_configured" }     ENVIO_GRAPHQL_URL unset
 *   502 { error: "indexer_unavailable" } the indexer failed or answered something unusable, including a missing or
 *                                        malformed head round when it has rounds
 *   502 { error: "too_many_rows" }      a list longer than the read cap: refused, never cut short
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/// One answer per account is reused this long. An older answer is still complete (me-rounds-discovery.ts); the browser
/// reads every round above its `indexedThrough` on chain.
const CACHE_MS = 15_000;
/// Accounts kept in this instance's cache; the oldest is dropped first, so any number of addresses costs bounded memory.
const CACHE_ACCOUNTS = 500;

const cache = new Map<string, () => Promise<Memoized<MeRoundsDiscoveryWire>>>();

function cachedFor(account: string): Promise<Memoized<MeRoundsDiscoveryWire>> {
  let memo = cache.get(account);
  if (memo) {
    cache.delete(account);
  } else {
    // ttlMemo keeps a success for CACHE_MS at most and never keeps a failure (src/lib/ttl-memo.ts).
    memo = ttlMemo(CACHE_MS, () => discoverMeRounds(account));
  }
  cache.set(account, memo);
  while (cache.size > CACHE_ACCOUNTS) cache.delete(cache.keys().next().value as string);
  return memo();
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');

export async function GET(req: Request) {
  const given = new URL(req.url).searchParams.getAll('account');
  if (given.length !== 1 || !ADDRESS.test(given[0])) {
    return NextResponse.json({ error: 'bad_account' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  const account = given[0].toLowerCase();
  try {
    const { value } = await cachedFor(account);
    return NextResponse.json(value, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof IndexerNotConfigured) {
      return NextResponse.json({ error: 'not_configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    // The error's class only: a message can carry the indexer URL.
    console.error('[me/rounds] indexer read failed:', errorName(e));
    const error = e instanceof TooManyRows ? 'too_many_rows' : 'indexer_unavailable';
    return NextResponse.json({ error }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
