// Adversary (plan r22 against b134fe9): CHARTS_DS_PLAN r22 3.4 says "a tick holds at most 330 pages x 200 KB = 66 MB
// of page data, under the Worker's 128 MB, whatever the upstream returns". The cap counts body bytes, but what a tick
// holds is the parsed value, and JSON.parse turns two bytes ("[]") into a whole JS array. keepRead (client.ts) only
// trims object entries: a non-object entry, an array included, is kept as it is, and every fetcher path skips it
// (isObject), so it stays in chain.entries for the whole tick (tick.ts holds every feed's FeedFetch until the build).
// Data: capture-2026-10-16/nyse-open-AAPL.json, its first real report, unchanged, so the page is anchored and moves
// the restart (a full page, so the chain asks for the next one); derived: 98 entries `0` and one entry that is an
// array nested as deep as the 200,000-byte cap allows (labelled; built here, not fabricated as a report).
// The memory figure is a lower bound, not a measurement: workerd exposes no heap size to a test, so each retained array
// is costed at 16 bytes, V8's JSArray header with compressed pointers (map, properties, elements, length), ignoring
// its elements store. Measured separately in Node 22 (no pointer compression), 330 copies of this page retained
// 1,695 MB of heap against 51.9 MB for 330 copies of a real 100-report page.
import { describe, expect, it } from 'vitest';

import { classify, MAX_PAGE_BYTES, PAGE_LIMIT } from '../src/client';
import { checkPage } from '../src/fetcher';
import { MAX_PAGES_PER_TICK } from '../src/limiter';
import { capture, feed, obsOf } from './helpers';

/// Workers memory limit, plan section 1 ("128 MB memory").
const WORKER_MEMORY_BYTES = 128 * 1024 * 1024;
/// Lower bound of one JS array's heap cost in V8 with pointer compression: a 4-word JSArray header.
const MIN_ARRAY_BYTES = 16;

/// Counts the arrays reachable from `v`, iteratively (the value is too deep to recurse).
function arrays(v: unknown): number {
  let n = 0;
  const stack: unknown[] = [v];
  while (stack.length > 0) {
    const x = stack.pop();
    if (x === null || typeof x !== 'object') continue;
    if (Array.isArray(x)) n++;
    for (const y of Object.values(x)) stack.push(y);
  }
  return n;
}

describe('adversary: the per-tick memory bound counts parsed values, not body bytes (plan r22 3.4)', () => {
  it('what 330 accepted pages keep fits the 128 MB Worker memory', async () => {
    const real = capture('nyse-open-AAPL')[0];
    const head = JSON.stringify({ reports: [real, ...Array<number>(PAGE_LIMIT - 2).fill(0)] }).slice(0, -2);
    const depth = Math.floor((MAX_PAGE_BYTES - head.length - 10) / 2);
    const body = `${head},${'['.repeat(depth)}${']'.repeat(depth)}]}`;
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(MAX_PAGE_BYTES);

    const page = await classify(new Response(body, { status: 200 }));
    expect(page.kind).toBe('ok');
    const reports = page.kind === 'ok' ? page.reports : [];
    expect(reports).toHaveLength(PAGE_LIMIT);
    // A full page whose real report is anchored past the start: progress, so the chain asks for the next page.
    expect(checkPage(feed('AAPL'), reports, obsOf(real) - 1)).toMatchObject({ ordered: true, maxAnchored: obsOf(real) });

    const keptBytes = arrays(reports) * MIN_ARRAY_BYTES;
    expect(keptBytes * MAX_PAGES_PER_TICK, `one accepted page keeps at least ${keptBytes} bytes of arrays; ${MAX_PAGES_PER_TICK} of them`).toBeLessThanOrEqual(WORKER_MEMORY_BYTES);
  });
});
