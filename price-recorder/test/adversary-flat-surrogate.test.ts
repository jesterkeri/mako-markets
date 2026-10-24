// Adversary (fix 9e2fa2e, round 3): client.ts flat() replaces a string with a character outside printable ASCII by
// `\u0000text:<keccak(stringToBytes(s))>`, and its comment says "two different values stay different for raw_fp"; plan
// r22 3.4 says the same ("anything else becomes a fixed tag holding its keccak, so raw_fp still tells two values
// apart"). stringToBytes is UTF-8 through TextEncoder, which is not one-to-one: every lone surrogate encodes as U+FFFD
// (EF BF BD). So the JSON strings "\ud800" and "�" (different body bytes, different parsed values) get ONE tag,
// rawId (entry.ts) sees one value, and buildMinute de-duplicates them into one raw entry. Before 9e2fa2e rawId kept the
// string itself (JSON.stringify escapes a lone surrogate), so the two stayed two entries.
// Consequence under plan 3.3 / 3.5: a refetch of an elapsed minute that drops one of the two is "the same page with
// one raw entry removed under the same rules", which must give a different raw_fp (refetch_mismatch, plan 15 test o);
// here it gives the same raw_fp, and n_raw / n_rejected count one entry instead of two.
// Data: capture-2026-10-16/nyse-open-AAPL.json, its first real report, unchanged, as the exhaustion witness. Derived
// (labelled, not report bytes): two junk entries of the AAPL feed at the minute before it, fullReport "\ud800" and
// "�" written as JSON escapes, which are plain ASCII bytes in the body.
// [d0bb0e4+] A non-hex fullReport now refuses the page (bad_body, the minute a gap), which closes this case more
// strongly than keeping the two strings apart: the assertions below were changed to that outcome by the main session.
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import { classify } from '../src/client';
import { capture, feed, obsOf } from './helpers';

const AAPL = feed('AAPL');
const real = capture('nyse-open-AAPL')[0];
const M = Math.floor(obsOf(real) / 60) * 60 - 60;
const junk = (s: string) => ({ feedID: AAPL.feedId, observationsTimestamp: M, fullReport: s });

async function page(reports: unknown[]) {
  // JSON.stringify writes a lone surrogate as the escape \ud800, so the body is valid UTF-8 and ASCII here.
  const r = await classify(new Response(JSON.stringify({ reports }), { status: 200 }));
  if (r.kind !== 'ok') throw new Error(`not a page: ${r.kind}`);
  return r.reports;
}

describe('adversary: flat() tags must keep two different junk strings apart (client.ts, plan r22 3.4)', () => {
  it('fullReport "\\ud800" and "\\ufffd" at one second: the page is refused, so nothing is merged', async () => {
    expect(JSON.stringify('\ud800')).not.toBe(JSON.stringify('\ufffd')); // different bytes on the wire
    await expect(page([junk('\ud800'), junk('\ufffd'), real])).rejects.toThrow('not a page: failed');
  });

  it('a refetch with one of them removed is refused as well, so it never stands as evidence', async () => {
    await expect(page([junk('\ufffd'), real])).rejects.toThrow('not a page: failed');
  });
});
