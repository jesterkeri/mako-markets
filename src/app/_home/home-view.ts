import type { PoolRow } from '@/lib/pool-list';

/// What Home's pools section shows: skeletons, the pools error (a failed or partial chain read), the pools empty
/// state (no open pool at all), or the rows.
export type PoolsView = { status: 'loading' } | { status: 'error' } | { status: 'empty' } | { status: 'ready'; rows: PoolRow[] };

/// Desktop's table shows up to six pools (2a); mobile, which has no filter, the three that close first.
export const DESK_ROWS = 6;

/// Home's Mako markets column (Joshua, 2026-10-15, in place of the Rounds list): Mako Market's own open pools in the
/// Trending order, the first HOME_MAKO_ROWS of `total`. `ready` with no rows is the honest empty state.
export type MakoView = { status: 'loading' } | { status: 'error' } | { status: 'ready'; rows: PoolRow[]; total: number };

/// Four rows: the height of the Rounds list it replaces beside the pools table. The rest are on Pools, whose
/// Trending tab lists every open Mako Market pool first.
export const HOME_MAKO_ROWS = 4;
