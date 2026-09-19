import { describe, expect, it } from 'vitest';
import { stringToHex } from 'viem';
import { applyFlap, classifyStuck, commandAllowed, creationFindings, suggestedCryptoCutoff, type CheckRow } from '../src/classify';
import type { MarketHead } from '../src/abi';
import suggested from './fixtures/suggested.json';

const T = { FOOTBALL: 0, CRYPTO: 1, BASKETBALL: 2, FOREX: 3, COMMODITIES: 4, STOCKS: 5, MAKO: 6 };
const CLOSE = 1_800_000_000;
const REFS: Record<number, string> = {
  0: '560571:over:2.5', 1: 'BTC:gt:100000', 2: '18446:home_win:0', 3: 'EURUSD:gt:1.1', 4: 'XAUUSD:lt:2400', 5: 'AAPL:gt:200', 6: 'political1',
};

function m(mType: number, yes: bigint, no: bigint, extra: Partial<MarketHead> = {}): MarketHead {
  return {
    id: 42, mType, oracleRef: stringToHex(REFS[mType] ?? 'x', { size: 32 }), createdAt: CLOSE - 86_400, closeTime: CLOSE,
    bettingCloseTime: CLOSE - 43_200, totalYes: yes, totalNo: no, resolved: false, ...extra,
  };
}

describe('§5.2 thresholds, ±1 s per type', () => {
  const two = [5n, 5n] as const;
  it.each([T.CRYPTO, T.FOREX, T.COMMODITIES, T.STOCKS])('price type %i: warn at +10m, critical at +1h', (t) => {
    expect(classifyStuck(m(t, ...two), CLOSE + 600 - 1).severity).toBe('none');
    expect(classifyStuck(m(t, ...two), CLOSE + 600).severity).toBe('warn');
    expect(classifyStuck(m(t, ...two), CLOSE + 3600 - 1).severity).toBe('warn');
    expect(classifyStuck(m(t, ...two), CLOSE + 3600).severity).toBe('critical');
  });
  it.each([T.FOOTBALL, T.BASKETBALL])('sports type %i: warn at +6h, critical at +24h', (t) => {
    expect(classifyStuck(m(t, ...two), CLOSE + 21_600 - 1).severity).toBe('none');
    expect(classifyStuck(m(t, ...two), CLOSE + 21_600).severity).toBe('warn');
    expect(classifyStuck(m(t, ...two), CLOSE + 86_400 - 1).severity).toBe('warn');
    expect(classifyStuck(m(t, ...two), CLOSE + 86_400).severity).toBe('critical');
  });
  it('MAKO one-sided: digest line from +24h, never critical', () => {
    expect(classifyStuck(m(T.MAKO, 3n, 0n), CLOSE + 86_400 - 1).severity).toBe('none');
    expect(classifyStuck(m(T.MAKO, 3n, 0n), CLOSE + 86_400).severity).toBe('digest');
    expect(classifyStuck(m(T.MAKO, 3n, 0n), CLOSE + 30 * 86_400).severity).toBe('digest');
  });
  it('every two-sided market, MAKO included, is critical from +24h with no safe refund path', () => {
    for (const t of Object.values(T)) {
      const v = classifyStuck(m(t, ...two), CLOSE + 86_400);
      expect(v.severity).toBe('critical');
      expect(v.command).toBe(false);
      expect(v.line).toContain('no safe refund path on V4');
    }
    expect(classifyStuck(m(T.MAKO, ...two), CLOSE + 86_400).line).toContain('resolve it from /admin/resolve');
  });
  it('before close, resolved, or nonexistent: nothing', () => {
    expect(classifyStuck(m(T.CRYPTO, 5n, 5n), CLOSE - 1).severity).toBe('none');
    expect(classifyStuck(m(T.CRYPTO, 5n, 5n, { resolved: true }), CLOSE + 99_999).severity).toBe('none');
    expect(classifyStuck(m(T.CRYPTO, 0n, 0n, { closeTime: 0 }), CLOSE).severity).toBe('none');
  });
});

describe('commands (I7): one-sided only, from close + 24h, every type', () => {
  it.each(Object.values(T))('type %i', (t) => {
    // pool boundaries: exactly one side zero, both zero, both one base unit
    expect(commandAllowed(m(t, 1n, 0n), CLOSE + 86_400)).toBe(true);
    expect(commandAllowed(m(t, 0n, 1n), CLOSE + 86_400)).toBe(true);
    expect(commandAllowed(m(t, 0n, 0n), CLOSE + 86_400)).toBe(true);
    expect(commandAllowed(m(t, 1n, 1n), CLOSE + 86_400)).toBe(false);
    expect(commandAllowed(m(t, 1n, 0n), CLOSE + 86_400 - 1)).toBe(false);
    expect(commandAllowed(m(t, 1n, 0n, { resolved: true }), CLOSE + 86_400)).toBe(false);
    expect(classifyStuck(m(t, 1n, 1n), CLOSE + 999_999).command).toBe(false);
  });
  it('one-sided before +24h says when refund opens', () => {
    expect(classifyStuck(m(T.CRYPTO, 1n, 0n), CLOSE + 7200).line).toContain('refund opens');
    expect(classifyStuck(m(T.CRYPTO, 1n, 0n), CLOSE + 86_400).line).toContain('refund command below');
  });
});

describe('suggestedCryptoBettingCloseTime copy', () => {
  it('matches the contract on every vector read from chain', () => {
    for (const v of suggested.vectors) expect(suggestedCryptoCutoff(v.createdAt, v.resolutionTime)).toBe(v.suggested);
    expect(suggested.vectors.length).toBeGreaterThanOrEqual(18);
  });
});

describe('creation findings', () => {
  it('late crypto cutoff, 1 s past the suggestion', () => {
    const base = m(T.CRYPTO, 1n, 0n);
    const s = suggestedCryptoCutoff(base.createdAt, base.closeTime);
    expect(creationFindings({ ...base, bettingCloseTime: s }, false)).toEqual([]);
    const f = creationFindings({ ...base, bettingCloseTime: s + 1 }, false);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/^NEW #42 CRYPTO: betting closes 0m after the suggested cutoff/);
  });
  it('paused symbols on every paused class', () => {
    expect(creationFindings(m(T.STOCKS, 1n, 0n, { oracleRef: stringToHex('GS:gt:500', { size: 32 }) }), false)[0]).toContain('GS: paused symbol');
    expect(creationFindings(m(T.FOREX, 1n, 0n, { oracleRef: stringToHex('GBPJPY:gt:190', { size: 32 }) }), false)[0]).toContain('GBPJPY: paused symbol');
    expect(creationFindings(m(T.STOCKS, 1n, 0n), false)).toEqual([]); // AAPL is verified
  });
  it('pre-existing markets: only while open, and labelled', () => {
    const paused = m(T.STOCKS, 1n, 0n, { oracleRef: stringToHex('KO:gt:60', { size: 32 }) });
    expect(creationFindings(paused, true)[0]).toMatch(/^BEFORE WATCHDOG #42 STOCKS KO/);
    expect(creationFindings({ ...paused, resolved: true }, true)).toEqual([]);
    expect(creationFindings({ ...paused, resolved: true }, false)).toHaveLength(1);
  });
});

describe('flap control', () => {
  it('needs two observations in a row to change state, either way', () => {
    let c: CheckRow | undefined;
    c = applyFlap(c, 'nc', 'fail', 'down', 1);
    expect(c.state).toBe('ok');
    c = applyFlap(c, 'nc', 'ok', '', 2);
    expect(c.state).toBe('ok');
    c = applyFlap(c, 'nc', 'fail', 'down', 3);
    expect(c.state).toBe('ok');
    c = applyFlap(c, 'nc', 'fail', 'down again', 4);
    expect(c).toMatchObject({ state: 'fail', since: 4, detail: 'down again' });
    c = applyFlap(c, 'nc', 'ok', '', 5);
    expect(c.state).toBe('fail');
    c = applyFlap(c, 'nc', 'fail', 'x', 6);
    expect(c.state).toBe('fail');
    c = applyFlap(c, 'nc', 'ok', '', 7);
    c = applyFlap(c, 'nc', 'ok', '', 8);
    expect(c).toMatchObject({ state: 'ok', since: 8 });
  });
});
