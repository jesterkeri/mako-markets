'use client';

import type { PoolCat } from '@/lib/pool-list';
import { useMakoLabelsBatch } from '@/lib/use-mako-labels';

export type SideLabels = { yes: string; no: string };

/// The side names a pool row prints: a house (MAKO) pool's own outcome names once loaded, YES and NO otherwise.
/// `makoIds` are the house pools on the page as `id.toString()`, fetched in one batch; keep the array stable
/// (memoise it) so a clock tick does not refetch.
export function usePoolLabels(makoIds: readonly string[]): (row: { id: bigint; cat: PoolCat }) => SideLabels {
  const { data } = useMakoLabelsBatch(makoIds as string[]);
  return (row) => {
    const l = row.cat === 'MAKO' ? data?.get(row.id.toString()) : undefined;
    return l ? { yes: l.label1, no: l.label2 } : { yes: 'YES', no: 'NO' };
  };
}
