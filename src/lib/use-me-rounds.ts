'use client';

// This account's rounds for Me: the rounds the indexer says it entered or created, plus every round the indexer
// cannot vouch for yet, each read on chain with its stake and claims (me-rounds-discovery.ts). The cost per poll is
// 4 reads per round in that set, not per round ever scheduled (Codex ME_ROUNDS R1): at most
// 4 x (discovered + max(ME_ROUNDS_RECENT, unindexed) + 1), the +1 being the indexer's head round, always read so its
// fingerprint can be checked against the chain (Codex ME_ROUNDS R2). An answer whose head round does not match roundOf
// describes another Rounds contract: the rounds part is unavailable, never `ready`. All-or-nothing reads (the Me retry
// rule, 2026-10-12): one refused call fails the read so TanStack Query retries it, and a failed refetch keeps the last
// complete data. A failed discovery is an error like a failed chain read: Me never shows pools-only totals for it.
// That keep-the-last-read rule also holds when a new round changes which ids are read (a new query key, so TanStack
// has no previous data for it): the last complete, bound read of this account stays until a new one is complete and
// bound: a new read that is still loading or failed to arrive shows that last read instead, and nothing but a complete,
// bound read replaces it (Codex ME_ROUNDS_DEGRADE R1 F1). Evidence against the read (a foreign head, an indexer too far
// behind or ahead) is still unavailable at once, as before (Codex ME_ROUNDS R2): it is an answer, not a failure.
// `off` when Rounds is not configured.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useReadContract, useReadContracts } from 'wagmi';

import { headMatchesChain, parseMeRoundsDiscovery, planMeRoundReads, type MeRoundsDiscovery } from './me-rounds-discovery';
import type { RoundStakeRead } from './me-rounds';
import type { Round } from './rounds-model';
import { roundsContract, toRound, type RoundTuple } from './use-rounds';

const POLL_MS = 10_000;
/// The discovery answer changes only when the indexer catches up; every round it has not caught up with is read on
/// chain anyway (planMeRoundReads: every id above the indexer's head, and the newest ME_ROUNDS_RECENT), so a new round
/// or entry shows on the next 10 s chain poll without asking the indexer. It is asked every 2 minutes, and a focus or
/// remount within that time reuses the answer: at least 8 GraphQL requests per open Me page per 2 minutes, more for a
/// long paged history. This lowers load; the guarantee that Me never exceeds its share of Envio's 100 queries a minute
/// is the server's shared budget (src/lib/envio-budget.ts), not this schedule (Codex ME_ROUNDS R5).
export const ME_ROUNDS_DISCOVERY_POLL_MS = 120_000;
/// roundOf, stakeOf, stakeClaimed, creatorFeeClaimed.
const PER_ROUND = 4;
/// Stable empty answer: `last` compares by reference, so a fresh [] or Map each render would set state every render.
const NO_ROUNDS: { rounds: Round[]; stakes: Map<string, RoundStakeRead> } = { rounds: [], stakes: new Map() };

export type MeRoundsRead =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; rounds: Round[]; stakes: Map<string, RoundStakeRead> };

async function fetchDiscovery(account: string): Promise<MeRoundsDiscovery> {
  const res = await fetch(`/api/me/rounds?account=${encodeURIComponent(account)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`rounds discovery answered ${res.status}`);
  const parsed = parseMeRoundsDiscovery(await res.json());
  if (!parsed) throw new Error('rounds discovery answer not usable');
  return parsed;
}

export function useMeRounds(account: `0x${string}`): MeRoundsRead & { refetch: () => void } {
  const countQ = useReadContract({
    ...(roundsContract ?? {}),
    functionName: 'roundCount',
    query: { enabled: roundsContract !== null, refetchInterval: POLL_MS },
  } as never) as { data?: bigint; isPending: boolean; isError: boolean; refetch: () => void };
  const discoveryQ = useQuery({
    queryKey: ['me-rounds-discovery', account.toLowerCase()],
    queryFn: () => fetchDiscovery(account),
    enabled: roundsContract !== null,
    refetchInterval: ME_ROUNDS_DISCOVERY_POLL_MS,
    staleTime: ME_ROUNDS_DISCOVERY_POLL_MS,
    // No automatic retries: each would reach Envio again exactly when it is failing or busy (Codex R5). The 2-minute
    // interval, a regained focus after it, and Me's Try again are the recovery paths.
    retry: false,
  });
  const count = typeof countQ.data === 'bigint' ? countQ.data : null;
  const discovery = discoveryQ.data;
  const plan = useMemo(() => (count === null || discovery === undefined ? null : planMeRoundReads(count, discovery)), [count, discovery]);
  const ids = useMemo(() => (plan?.ok ? plan.ids : []), [plan]);
  const q = useReadContracts({
    allowFailure: false,
    contracts: roundsContract
      ? ids.flatMap((id) => [
          { ...roundsContract, functionName: 'roundOf', args: [id] } as const,
          { ...roundsContract, functionName: 'stakeOf', args: [id, account] } as const,
          { ...roundsContract, functionName: 'stakeClaimed', args: [id, account] } as const,
          { ...roundsContract, functionName: 'creatorFeeClaimed', args: [id] } as const,
        ])
      : [],
    query: { enabled: roundsContract !== null && ids.length > 0, refetchInterval: POLL_MS },
  });
  const refetch = () => {
    void countQ.refetch();
    void discoveryQ.refetch();
    void q.refetch();
  };

  const data = q.data as readonly unknown[] | undefined;
  const complete = data !== undefined && data.length === ids.length * PER_ROUND;
  const parsed = useMemo(() => {
    if (!complete) return null;
    const rounds: Round[] = [];
    const stakes = new Map<string, RoundStakeRead>();
    // The binding (me-rounds-discovery.ts, step 0): the indexer's head round is this contract's round of that id. No
    // head means the indexer has no rounds, and then every round on chain is in `ids` (the plan starts at 1).
    const head = discovery?.head ?? null;
    let bound = head === null;
    ids.forEach((id, i) => {
      const at = i * PER_ROUND;
      if (head !== null && id === head.id) bound = headMatchesChain(head, data[at] as RoundTuple);
      rounds.push(toRound(id, data[at] as RoundTuple));
      const s = data[at + 1] as { side: number; amount: bigint };
      const side = Number(s.side) === 1 ? 'up' : Number(s.side) === 2 ? 'down' : null;
      stakes.set(id.toString(), { stake: { side, amount: BigInt(s.amount) }, claimed: Boolean(data[at + 2]), creatorFeeClaimed: Boolean(data[at + 3]) });
    });
    return { rounds, stakes, bound };
  }, [complete, data, ids, discovery]);

  // 'failed' = no answer arrived (a refused call or discovery); the last complete read may stand in for it.
  const read = ((): MeRoundsRead | { status: 'failed' } => {
    if (!roundsContract) return { status: 'off' };
    if (countQ.isError && countQ.data === undefined) return { status: 'failed' };
    if (discoveryQ.isError && discoveryQ.data === undefined) return { status: 'failed' };
    if (countQ.isPending || discoveryQ.isPending || !plan) return { status: 'loading' };
    // The indexer is too far behind to bound the reads, or ahead of the chain (not this contract's, or not checkable
    // yet): unavailable, never a partial list.
    if (!plan.ok) return { status: 'error' };
    if (ids.length === 0) return { status: 'ready', ...NO_ROUNDS };
    if (q.isError && q.data === undefined) return { status: 'failed' };
    if (!parsed) return { status: 'loading' };
    // The discovery answer is for another Rounds contract (or its head round is missing from `ids`): unavailable.
    if (!parsed.bound) return { status: 'error' };
    return { status: 'ready', rounds: parsed.rounds, stakes: parsed.stakes };
  })();

  // The last complete, bound read, kept per account (React's "store information from previous renders" pattern).
  const owner = account.toLowerCase();
  const [last, setLast] = useState<{ owner: string; read: MeRoundsRead & { status: 'ready' } } | null>(null);
  if (read.status === 'ready') {
    if (last?.owner !== owner || last.read.rounds !== read.rounds || last.read.stakes !== read.stakes) setLast({ owner, read });
    return { ...read, refetch };
  }
  // Evidence against the read also retires the kept one, so a later failure cannot bring it back.
  if (read.status === 'error' && last !== null) setLast(null);
  if ((read.status === 'loading' || read.status === 'failed') && last?.owner === owner) return { ...last.read, refetch };
  return read.status === 'failed' ? { status: 'error', refetch } : { ...read, refetch };
}
