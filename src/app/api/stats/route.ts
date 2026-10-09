import { ttlMemo } from '@/lib/ttl-memo';
import { parseIndexedStats, STATS_QUERY, toWire, type IndexedStats, type StatsWire } from '@/lib/stats';
import { fetchDbSnapshot } from '@/lib/stats-snapshot';
import { within } from '@/lib/within';

// GET /api/stats: the figures for /stats, from the Envio indexer of the pools and rounds contracts (ENVIO_GRAPHQL_URL) and Mako
// Market's own records (sponsored transactions, Mako wallets created). The indexer figures are at most a minute old, so a
// new bet shows within a minute (Joshua, 2026-10-08: 30 minutes was too slow). The account figures come from a file the
// 15-minute scheduled job writes (src/lib/stats-snapshot.ts) and are at most 20 minutes old (Joshua, 2026-10-09). This
// route never opens a database connection, so no number of visitors or server instances can reach the database through
// it (Codex RELEASE_R9 #1).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INDEXER_MAX_AGE_SEC = 60;
/// The job runs every 15 minutes (/api/cron/aa-fast); 5 more minutes covers a late or slow run, not a missed one.
const DB_MAX_AGE_SEC = 20 * 60;
/// A file stamped later than this past the server clock is not believed (clocks on two machines differ a little).
const DB_FUTURE_SKEW_SEC = 60;
const INDEXER_TIMEOUT_MS = 10_000;
/// The longest wait for the saved account figures (src/lib/stats-snapshot.ts).
const SNAPSHOT_TIMEOUT_MS = 5_000;

class NotConfigured extends Error {}
class TooOld extends Error {
  override name = 'TooOld';
}

const errorCode = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : e instanceof Error ? e.name : 'unknown';
};

/// The indexer's figures, or a throw (never cached: a failure is retried on the next request, not kept for 30 minutes).
async function fetchIndexer(): Promise<IndexedStats> {
  const url = process.env.ENVIO_GRAPHQL_URL?.trim();
  if (!url) throw new NotConfigured();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: STATS_QUERY }),
    signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`indexer answered ${res.status}`);
  const stats = parseIndexedStats(await res.json());
  if (!stats) throw new Error('indexer answer not usable');
  return stats;
}

// Hard age limits (src/lib/ttl-memo.ts), and a failed read shows as unavailable. The answer goes out only once both
// sources have settled, so the indexer memo's limit leaves room for the longest wait on the saved figures: an indexer
// figure reused at 54.9 s still goes out under 60 s. The saved figures' own read time is checked at send time below,
// so how long this instance has held the file does not matter.
const cachedIndexer = ttlMemo(INDEXER_MAX_AGE_SEC * 1000 - SNAPSHOT_TIMEOUT_MS, async () => toWire(await fetchIndexer(), 'ok', null, 0).indexed);
const cachedSnapshot = ttlMemo(60_000, fetchDbSnapshot);

export async function GET() {
  const [indexed, saved] = await Promise.allSettled([cachedIndexer(), within(cachedSnapshot(), SNAPSHOT_TIMEOUT_MS)]);
  const now = Date.now();
  const snapshot = (() => {
    if (saved.status === 'rejected') return { ok: false as const, reason: saved.reason as unknown };
    const s = saved.value.value;
    const age = now - s.readAt;
    if (age >= DB_MAX_AGE_SEC * 1000 || age < -DB_FUTURE_SKEW_SEC * 1000) return { ok: false as const, reason: new TooOld() as unknown };
    return { ok: true as const, value: s };
  })();
  // The error's code or class only: a message can carry the indexer URL.
  if (!snapshot.ok) console.error('[stats] account figures unavailable:', errorCode(snapshot.reason));
  if (indexed.status === 'rejected' && !(indexed.reason instanceof NotConfigured)) console.error('[stats] indexer read failed:', errorCode(indexed.reason));
  const body: StatsWire = {
    indexed: indexed.status === 'fulfilled' ? indexed.value.value : null,
    indexedStatus: indexed.status === 'fulfilled' ? 'ok' : indexed.reason instanceof NotConfigured ? 'not_configured' : 'unavailable',
    gasFree: snapshot.ok ? snapshot.value.gasFree : null,
    makoWallets: snapshot.ok ? snapshot.value.makoWallets : null,
    // When the oldest figure shown was read, so "read Xm ago" is true of everything on the page.
    readAt: Math.floor(
      Math.min(now, ...(indexed.status === 'fulfilled' ? [indexed.value.at] : []), ...(snapshot.ok ? [snapshot.value.readAt] : [])) / 1000,
    ),
  };
  // No shared caching (Codex RELEASE_R7 #1): a CDN copy would add its own age on top of the figures' and could keep
  // showing "ok" after a source went down.
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
