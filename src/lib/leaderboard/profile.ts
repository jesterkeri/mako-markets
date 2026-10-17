import { unstable_cache } from 'next/cache';
import { cache } from 'react';

import { db } from '@/db/client';
import { MONAD_TESTNET_ID } from '@/lib/chain';

import { resolveLabels } from './identity';
import { getCallerRank } from './queries';

/// A player's public profile (13a, Joshua 2026-10-17): what the leaderboard already shows publicly for one address,
/// nothing more. Amounts are USDC base-unit strings, as on the board.
export interface PublicProfile {
  /// Lowercase address.
  actor: `0x${string}`;
  displayName: string | null;
  /// Only a photo this app uploaded for them (identity.ts), else null.
  avatarUrl: string | null;
  /// All-time profit rank, the board's default order; null with no bets yet.
  rank: number | null;
  net: string;
  staked: string;
  bets: number;
}

export async function readPublicProfile(actor: `0x${string}`): Promise<PublicProfile> {
  const [ranked, labels] = await Promise.all([
    getCallerRank(db, { window: 'all', address: actor, orderBy: 'net' }),
    resolveLabels(db, [actor], MONAD_TESTNET_ID),
  ]);
  const label = labels.get(actor);
  return {
    actor,
    displayName: label?.displayName ?? null,
    avatarUrl: label?.avatarUrl ?? null,
    rank: ranked?.rank ?? null,
    net: ranked?.row.net ?? '0',
    staked: ranked?.row.staked ?? '0',
    bets: ranked?.row.bets ?? 0,
  };
}

/// Cached a minute per address, like the board (45 s): the rank query aggregates every player, and a profile is a
/// public link anyone can open repeatedly. React's cache() also shares one call between the page and its metadata in
/// the same request, which unstable_cache alone does not on a miss.
export const getPublicProfile = cache((actor: `0x${string}`): Promise<PublicProfile> =>
  unstable_cache(() => readPublicProfile(actor), ['public-profile', actor], { revalidate: 60 })(),
);
