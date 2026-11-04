// Adversary (plan r22 against 43aec54): CHARTS_DS_PLAN r22 3.4 says "A page holding more than `limit` (100) entries
// is not a page ... so the per-tick work bound (4.1) holds whatever the upstream returns". The cap counts entries,
// not bytes. client.ts accepts any 200 body under MAX_PAGE_BYTES (2,000,000) holding at most 100 elements, and the
// fetcher keeps every element of every page of the tick (`chain.entries.push(...page.reports)`) until the candles are
// built. A tick may start MAX_PAGES_PER_TICK (330) calls (4.1; 34 x 5 live + 34 x 5 catch-up already reach it in
// unit c). The Worker has 128 MB of memory (plan section 1, Workers limits page). So what one tick may hold is
// bounded by 330 x what one accepted page may hold, and that must fit in 128 MB for the bound to hold "whatever the
// upstream returns".
// Data: capture-2026-10-16/nyse-open-AAPL.json, its first 100 real reports, unchanged; derived: one extra JSON field
// `pad` added to each entry (labelled; the report bytes and the two JSON fields the recorder reads are untouched),
// sized so the whole body stays under MAX_PAGE_BYTES.
import { describe, expect, it } from 'vitest';

import { classify, MAX_PAGE_BYTES, PAGE_LIMIT } from '../src/client';
import { MAX_PAGES_PER_TICK } from '../src/limiter';
import { capture } from './helpers';

/// Workers memory limit, plan section 1 ("128 MB memory").
const WORKER_MEMORY_BYTES = 128 * 1024 * 1024;

describe('adversary: the per-tick work bound in bytes (plan r22 3.4, 4.1, 4.3)', () => {
  it('what 330 accepted pages can hold fits the 128 MB Worker memory', async () => {
    const real = capture('nyse-open-AAPL').slice(0, PAGE_LIMIT);
    expect(real).toHaveLength(PAGE_LIMIT);
    const plain = JSON.stringify({ reports: real }).length;
    const room = Math.floor((MAX_PAGE_BYTES - plain - 1000) / PAGE_LIMIT);
    const reports = real.map((e) => ({ ...e, pad: 'x'.repeat(room) }));
    const body = JSON.stringify({ reports });
    expect(body.length).toBeLessThan(MAX_PAGE_BYTES);

    const page = await classify(new Response(body, { status: 200 }));
    // Whatever the client keeps of this answer is what the fetcher keeps for the rest of the tick.
    const kept = page.kind === 'ok' ? JSON.stringify(page.reports).length : 0;
    expect(kept * MAX_PAGES_PER_TICK, `one accepted page keeps ${kept} bytes; ${MAX_PAGES_PER_TICK} of them`).toBeLessThanOrEqual(WORKER_MEMORY_BYTES);
  });
});
