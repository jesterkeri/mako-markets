// (Adversary on c131ac5.) Probe: every element below is JSON.parse output and must not make buildMinute throw, and
// the real minute must keep its counts and fingerprints. Data: open-minute-BTC.json, values built by JSON.parse.
import { describe, expect, it } from 'vitest';

import { buildMinute } from '../src/candle';
import type { PageEntry } from '../src/entry';
import { at, capture, feed, obsOf, withWord } from './helpers';

const page = capture('open-minute-BTC');
const f = feed('BTC');
const M = obsOf(page[0]);
const inMinute = page.filter((e) => obsOf(e) < M + 60);
const e = at(page, M + 10);
const deep = (inner: string) => `${'['.repeat(9000)}${inner}${']'.repeat(9000)}`;
const fid = JSON.stringify(e.feedID);
const fr = JSON.stringify(e.fullReport);
const texts = [
  '{}',
  '[]',
  '{"__proto__":{"feedID":1}}',
  '{"toJSON":1}',
  `{"__proto__":null,"feedID":${fid},"observationsTimestamp":${M + 1}}`,
  `{"feedID":${fid},"observationsTimestamp":"${M + 1}","fullReport":"\\ud800"}`,
  `{"feedID":"\\ud800","observationsTimestamp":${M + 1}}`,
  `{"feedID":${deep('0')},"observationsTimestamp":${M + 1},"fullReport":${deep('1')}}`,
  `{"feedID":${fid},"observationsTimestamp":${M + 1},"fullReport":${deep('1')}}`,
  `{"feedID":${fid},"observationsTimestamp":${deep('1')},"fullReport":${fr}}`,
  `{"feedID":${fid},"observationsTimestamp":${M + 1},"fullReport":{"toJSON":"x","a":-0,"b":1e999}}`,
  `{"feedID":${fid},"observationsTimestamp":1e999,"fullReport":${fr}}`,
  `{"feedID":${fid},"observationsTimestamp":${M + 1},"fullReport":"0x"}`,
  `{"feedID":${fid},"observationsTimestamp":${M + 1},"fullReport":"0x${'ff'.repeat(4000)}"}`,
  `{"feedID":${fid},"observationsTimestamp":${M + 1},"fullReport":"0x${'00'.repeat(31)}20${'ff'.repeat(64)}"}`,
  `{"feedID":${fid},"observationsTimestamp":999999999999999,"fullReport":${fr}}`,
  `{"feedID":${fid},"observationsTimestamp":${M + 10},"fullReport":${fr},"feedID":${fid}}`,
];

describe('JSON.parse-reachable elements never throw out of buildMinute', () => {
  const clean = buildMinute(f, M, inMinute);
  for (const t of texts) {
    it(t.slice(0, 80), () => {
      const el = JSON.parse(t) as PageEntry;
      expect(() => buildMinute(f, M, [...inMinute, el])).not.toThrow();
      expect(() => buildMinute(f, M, [el, ...inMinute])).not.toThrow();
    });
  }
  it('forged words in a real report do not throw', () => {
    const cases: [number, bigint][] = [[8, 2n ** 32n - 1n], [8, 2n], [6, 1n], [7, 2n ** 191n - 1n], [2, 2n ** 32n - 1n], [1, 0n]];
    for (const [i, v] of cases) expect(() => buildMinute(f, M, [...inMinute, withWord(e, i, v)])).not.toThrow();
  });
  it('the real minute is unchanged by every non-object element', () => {
    const els = ['5', '"x"', 'true', 'null', '[1]', '[]', '0', '""'].map((t) => JSON.parse(t) as PageEntry);
    expect(buildMinute(f, M, [...els, ...inMinute, ...els])).toEqual(clean);
  });
});
