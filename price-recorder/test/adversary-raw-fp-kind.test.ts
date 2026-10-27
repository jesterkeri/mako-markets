// CHARTS_DS_PLAN 3.3 raw_fp and Codex B/C R2 F1: every accepted value of a read field must have a bounded exact
// identity for raw_fp, or the page fails closed, so that a provider changing a past page changes raw_fp. parsePage
// (src/client.ts hasOddField) accepts ANY string in fullReport. rawId keeps a hex string and other text apart, but
// raw_fp (candle.ts fingerprint) hashes only (obs, key), and reportKey gives a hex report the plain keccak of its bytes
// while non-hex text gets keccak(0x01 || text) and an absent field keccak(0x02 || "null"). So the hex string
// "0x01" + hex(text) has the same key as the text, and "0x02" + hex("null") the same key as an absent fullReport:
// a provider swapping one for the other at a past second leaves raw_fp, n_raw and n_rejected unchanged, no
// refetch_mismatch. Either fix passes: refuse such a page, or keep the kinds apart in raw_fp.
//
// Data: open-minute-BTC.json (capture 2026-10-16), the real entry at M + 10 copied with only fullReport changed (or
// removed); the page is the real minute plus its first witness. Adversary on d0bb0e4.
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import { parsePage } from '../src/client';
import { at, capture, feed, obsOf } from './helpers';

const all = capture('open-minute-BTC');
const f = feed('BTC');
const M = obsOf(all[0]);
const e = at(all, M + 10);
const page = [...all.filter((x) => obsOf(x) < M + 60), all.find((x) => obsOf(x) >= M + 60)!];
const hexOf = (s: string): string => Buffer.from(s, 'utf8').toString('hex');
const { fullReport: _drop, ...noReport } = e;

const body = (extra: Record<string, unknown>): string => JSON.stringify({ reports: [...page, extra] });

describe('two different accepted fullReport values at one second give one raw_fp (plan 3.3, F1)', () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ['non-hex text "zz" vs hex 0x017a7a', { ...e, fullReport: 'zz' }, { ...e, fullReport: `0x01${hexOf('zz')}` }],
    ['absent fullReport vs hex 0x02 + hex("null")', noReport, { ...e, fullReport: `0x02${hexOf('null')}` }],
  ];
  for (const [name, a, b] of cases) {
    it(`${name}: the page is refused, or the swap changes raw_fp`, () => {
      const pa = parsePage(body(a));
      const pb = parsePage(body(b));
      if (pa === null || pb === null) return; // failed closed: a gap, not merged evidence
      const ra = buildMinute(f, M, pa);
      const rb = buildMinute(f, M, pb);
      expect(ra.state).toBe(buildMinute(f, M, page).state);
      expect(ra.raw_fp).not.toBeNull();
      expect(ra.n_raw).toBe(rb.n_raw);
      expect(ra.raw_fp, 'the provider changed a past entry, raw_fp must change').not.toBe(rb.raw_fp);
    });
  }
});
