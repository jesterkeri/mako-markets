// ----------------------------------------------------------------------------
// #186 Leaderboard — contract list config.
//
// The indexer (indexer.ts) scans every entry here; the ledger keys rows by
// the LOWERCASED address. List-structured so a future v5 redeploy (or a
// decision to backfill the superseded v4 at 0xf9853d.../27555816) is a
// one-line add — with one caveat: adding an entry whose deployBlock is far
// behind head re-opens the cold-start problem, so any addition ships with
// a scripts/seed-leaderboard.mts run, not just a config change.
//
// v1 ships the LIVE v4 contract only (plan open-Q3: live-only).
// ----------------------------------------------------------------------------

import { MAKO_ADDRESS } from '@/lib/contract';

export type LeaderboardContractVersion = 'v4';

export type LeaderboardContract = {
  /** LOWERCASED 0x address. Ledger rows + the indexer cursor key off this
   *  exact form; the DB CHECK (contract_address = lower(contract_address))
   *  rejects anything else. */
  address: `0x${string}`;
  /** Deploy block — the indexer's scan floor for this contract. */
  deployBlock: number;
  /** Display/version tag stored on every ledger row. */
  version: LeaderboardContractVersion;
};

/** Live v4 deploy block (2026-05-18, block 32603678). Paired with the
 *  MAKO_ADDRESS fallback in contract.ts — the two rotate together via env
 *  (NEXT_PUBLIC_MAKO_ADDRESS + NEXT_PUBLIC_MAKO_DEPLOY_BLOCK), same pairing
 *  the admin analytics route already relies on. */
const LIVE_V4_DEPLOY_BLOCK = 32603678;

function parseDeployBlock(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(
      `NEXT_PUBLIC_MAKO_DEPLOY_BLOCK is not a valid block number: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

export const LEADERBOARD_CONTRACTS: readonly LeaderboardContract[] = [
  {
    // MAKO_ADDRESS is EIP-55 checksummed (normalizeAddress in contract.ts);
    // the ledger's canonical form is lowercase, so normalize at the boundary.
    address: MAKO_ADDRESS.toLowerCase() as `0x${string}`,
    deployBlock: parseDeployBlock(
      process.env.NEXT_PUBLIC_MAKO_DEPLOY_BLOCK,
      LIVE_V4_DEPLOY_BLOCK,
    ),
    version: 'v4',
  },
];
