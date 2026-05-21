'use client';

// ----------------------------------------------------------------------------
// src/lib/use-mako-labels.ts
//
// Client-only React Query hooks for MAKO outcome labels. Pair with the
// server-only DAO in `src/lib/mako-labels-server.ts`; both modules share
// pure types from `src/lib/mako-labels.ts`.
//
// Key discipline (BINDING — see mako-labels.ts header):
//   The hook surface is string-only. Callers MUST convert from their
//   on-chain bigint at the boundary: `m.id.toString()` for single, or
//   `ids.map(m => m.id.toString())` for batched. Passing a bigint is a
//   TypeScript compile error. The Map returned by the batched hook is
//   `Map<string, MakoOutcomeLabels>`; callers look up via
//   `labels.get(m.id.toString())`. This guarantees the round-8 silent-
//   miss bug (bigint lookup against a string Map → always undefined) is
//   caught at compile time, not at runtime via UI fallback.
//
// Why two hooks against one endpoint:
//   The endpoint `GET /api/mako-labels?ids=...` is batch-shaped. The
//   single-market hook just calls it with one id and unwraps
//   `labels[0] ?? null`. One server handler, one DAO call, two ergonomic
//   client shapes. See plan round-8 fix for the "pick one shape" decision.
//
// Why batching belongs at the parent:
//   `MarketCard` / `MarketRow` accept a `labels` prop and do NOT call
//   any label hook themselves. The feed parent (home page, admin markets
//   list, admin resolve list) calls `useMakoLabelsBatch(makoIds)` ONCE
//   and passes the relevant row into each leaf via prop. Leaf-level
//   hook calls would create N+1 fetches against the DB and undo the
//   batch endpoint's purpose. See plan round-6 fix.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  MakoLabelsMap,
  MakoLabelsRow,
  MakoOutcomeLabels,
} from '@/lib/mako-labels';

/// React Query staleTime for both hooks. Labels rarely change — an admin
/// might edit them once after creation if the original save failed, and
/// can never edit after market resolution. 30s matches the analytics
/// route cadence so the home feed's two queries land in lockstep.
const STALE_TIME_MS = 30_000;

/// Single-market label lookup. Pass `marketId.toString()` from a bigint
/// callsite, or `null` to disable the query (e.g. when the market is not
/// MAKO and labels are irrelevant). Returns `null` when no DB row exists
/// for the id — the read-side helper in `admin-shared.tsx`
/// (`outcomeLabelForMarket`) falls back to "YES" / "NO" in that case.
export function useMakoLabels(marketId: string | null) {
  return useQuery<MakoOutcomeLabels | null>({
    queryKey: ['mako-labels-single', marketId],
    enabled: marketId !== null,
    queryFn: async () => {
      const res = await fetch(`/api/mako-labels?ids=${marketId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { labels } = (await res.json()) as { labels: MakoLabelsRow[] };
      if (labels.length === 0) return null;
      return { label1: labels[0].label1, label2: labels[0].label2 };
    },
    staleTime: STALE_TIME_MS,
  });
}

/// Batched label lookup for feed parents. Pass an array of `string`
/// market ids — bigint callsites convert at the boundary with
/// `.toString()`. Empty input short-circuits BEFORE any fetch fires
/// (the React Query `enabled` flag stays false), so the all-non-MAKO
/// home feed incurs zero network/DB cost.
///
/// Returns a `MakoLabelsMap = Map<string, MakoOutcomeLabels>` keyed by
/// stringified market id. MAKO markets without a DB row are absent from
/// the Map; callers `.get(id) ?? null` for the YES/NO fallback path.
///
/// The query key is the SORTED id list so the same set of markets in
/// different presentation orders hits the same cache entry. Without the
/// sort, re-rendering with the same ids in a different order would
/// trigger a refetch.
export function useMakoLabelsBatch(marketIds: string[]) {
  const sortedIds = useMemo(() => [...marketIds].sort(), [marketIds]);
  return useQuery<MakoLabelsMap>({
    queryKey: ['mako-labels-batch', sortedIds],
    enabled: sortedIds.length > 0,
    queryFn: async () => {
      const res = await fetch(
        `/api/mako-labels?ids=${sortedIds.join(',')}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { labels } = (await res.json()) as { labels: MakoLabelsRow[] };
      const map: MakoLabelsMap = new Map();
      for (const r of labels) {
        map.set(r.marketId, { label1: r.label1, label2: r.label2 });
      }
      return map;
    },
    staleTime: STALE_TIME_MS,
  });
}
