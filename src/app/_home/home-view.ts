import type { PoolRow } from '@/lib/pool-list';

/// What Home's pools section shows: skeletons, the pools error (a failed or partial chain read), the pools empty
/// state (no open pool at all), or the rows.
export type PoolsView = { status: 'loading' } | { status: 'error' } | { status: 'empty' } | { status: 'ready'; rows: PoolRow[] };

/// Desktop's table shows up to six pools (2a); mobile, which has no filter, the three that close first.
export const DESK_ROWS = 6;
