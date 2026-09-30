import { NextResponse } from 'next/server';

import { MONAD_TESTNET_ID } from '@/lib/chain';
import { db } from '@/db/client';
import { resolveLabels } from '@/lib/leaderboard/identity';

/**
 * GET /api/names?addresses=0xabc…,0xdef…
 *
 * Display names for on-chain addresses (pool creators, for now), resolved exactly as the leaderboard resolves them:
 * an email account through its Safe, a wallet account through its wallet address. Public, like the leaderboard: the
 * response carries display names only, never an email, and omits addresses with no name (the page shows the short
 * address for those).
 *
 *   200 { names: { "<lowercase address>": "<display name>" } }
 *   400 { error: "bad_address" | "too_many_addresses" }
 *   500 { error: "read_failed" }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_ADDRESSES = 100;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('addresses') ?? '';
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.some((a) => !ADDRESS.test(a))) {
    return NextResponse.json({ error: 'bad_address' }, { status: 400 });
  }
  const addresses = [...new Set(parts.map((a) => a.toLowerCase()))];
  if (addresses.length > MAX_ADDRESSES) {
    return NextResponse.json({ error: 'too_many_addresses', max: MAX_ADDRESSES }, { status: 400 });
  }
  if (addresses.length === 0) {
    return NextResponse.json({ names: {} });
  }

  try {
    const labels = await resolveLabels(db, addresses, MONAD_TESTNET_ID);
    const names: Record<string, string> = {};
    for (const [address, identity] of labels) names[address] = identity.displayName;
    // Every viewer asks for the same creators, so a shared cache takes the load off the database; a renamed
    // account shows its new name within a minute.
    return NextResponse.json({ names }, { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } });
  } catch (err) {
    console.error('[names] read failed', err instanceof Error ? err.name : 'unknown');
    return NextResponse.json({ error: 'read_failed' }, { status: 500 });
  }
}
