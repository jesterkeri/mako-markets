// Real captured pages (CHARTS_DS_PLAN 15.1), vendored under test/fixtures with SHA256SUMS and PROVENANCE.md. Cases a
// capture never showed are built from a real report with ONE field changed, through `withWord`, and each test says
// which file and which field (plan 15.1: no fabricated report bytes).
import { decodeAbiParameters, encodeAbiParameters, numberToHex, type Hex } from 'viem';

import type { PageEntry } from '../src/entry';
import { FEED_BY_SYMBOL, type Feed } from '../src/feeds';

type Capture = { feedId?: string; pages?: { reports: PageEntry[] }[]; reports?: PageEntry[] };
const captures = import.meta.glob<Capture>('./fixtures/capture-2026-10-16/*.json', { eager: true, import: 'default' });
const probes = import.meta.glob<{ body: { reports: PageEntry[] } }>('./fixtures/probe-2026-09-18/*.json', { eager: true, import: 'default' });

export function capture(name: string): PageEntry[] {
  const c = captures[`./fixtures/capture-2026-10-16/${name}.json`];
  if (!c) throw new Error(`no capture ${name}`);
  return c.pages ? c.pages.flatMap((p) => p.reports) : (c.reports ?? []);
}
export const captureNames = (): string[] => Object.keys(captures).map((k) => k.replace('./fixtures/capture-2026-10-16/', '').replace('.json', ''));

export function probePage(name: 'page-BTC' | 'page-EURUSD'): PageEntry[] {
  return probes[`./fixtures/probe-2026-09-18/${name}.json`].body.reports;
}

export const feed = (symbol: string): Feed => {
  const f = FEED_BY_SYMBOL.get(symbol);
  if (!f) throw new Error(`no feed ${symbol}`);
  return f;
};

export const obsOf = (e: PageEntry): number => Number(e.observationsTimestamp);
export const at = (entries: PageEntry[], obs: number): PageEntry => {
  const e = entries.find((x) => obsOf(x) === obs);
  if (!e) throw new Error(`no entry at ${obs}`);
  return e;
};

const ENVELOPE = [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }] as const;

/// A real entry with word `i` of its report blob replaced (v8 words: 6 lastUpdateTimestamp, 7 midPrice,
/// 8 marketStatus; v3 words: 6 price; both: 1 validFrom, 2 observations). The signature no longer matches, which the
/// recorder never checks (plan 3.1); the result is labelled "derived" wherever it is used.
export function withWord(e: PageEntry, i: number, value: bigint): PageEntry {
  const env = decodeAbiParameters(ENVELOPE, e.fullReport as Hex);
  const blob = env[1] as Hex;
  const hex = blob.slice(2);
  const word = (value < 0n ? (1n << 256n) + value : value).toString(16).padStart(64, '0');
  const next = `0x${hex.slice(0, 64 * i)}${word}${hex.slice(64 * (i + 1))}` as Hex;
  const full = encodeAbiParameters(ENVELOPE, [env[0], next, env[2], env[3], env[4]]);
  return { ...e, fullReport: full };
}

export const word = (e: PageEntry, i: number): bigint => {
  const blob = decodeAbiParameters(ENVELOPE, e.fullReport as Hex)[1] as Hex;
  return BigInt(`0x${blob.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
};

export const hexOf = (n: number): Hex => numberToHex(n);
