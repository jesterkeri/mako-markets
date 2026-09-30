// New pools (10a): the question, settlement reference and times must be exactly what the current create page
// produces and the resolver parses.

import { describe, expect, it } from 'vitest';

import { MarketType } from '../contract';
import { buildPool } from '../pool-create';

const NOW = 1_800_000_000;
const ok = (r: ReturnType<typeof buildPool>) => {
  if (!r.ok) throw new Error(r.reason);
  return r.pool;
};

describe('price pools', () => {
  it('crypto: the resolver reference SYMBOL:gt|lt:STRIKE and the dollar question with the duration label', () => {
    const p = ok(buildPool({ kind: 'crypto', symbol: 'btc', direction: 'above', strike: 84523, durationSec: 300 }, NOW));
    expect(p).toMatchObject({ mType: MarketType.CRYPTO, oracleRef: 'BTC:gt:84523', question: 'Will BTC close above $84,523 in 5 minutes?' });
    expect(buildPool({ kind: 'crypto', symbol: 'MON', direction: 'below', strike: 0.0275, durationSec: 604800 }, NOW)).toMatchObject({
      ok: true,
      pool: { oracleRef: 'MON:lt:0.0275', question: 'Will MON close below $0.0275 in 7 days?' },
    });
  });

  it('forex, commodities and stocks: their own verb, no dollar sign', () => {
    expect(ok(buildPool({ kind: 'forex', symbol: 'EURUSD', direction: 'above', strike: 1.095, durationSec: 3600 }, NOW)).question).toBe('Will EURUSD trade above 1.095 in 1 hour?');
    expect(ok(buildPool({ kind: 'commodities', symbol: 'XAUUSD', direction: 'below', strike: 2400, durationSec: 86400 }, NOW)).question).toBe('Will XAUUSD settle below 2400 in 24 hours?');
    expect(ok(buildPool({ kind: 'stocks', symbol: 'NVDA', direction: 'above', strike: 200, durationSec: 3600 }, NOW))).toMatchObject({
      mType: MarketType.STOCKS,
      question: 'Will NVDA close above 200 in 1 hour?',
      oracleRef: 'NVDA:gt:200',
    });
  });

  it('runs from now plus the landing buffer, capped under 7 days, and stops betting at the contract-suggested point', () => {
    const p = ok(buildPool({ kind: 'crypto', symbol: 'BTC', direction: 'above', strike: 1, durationSec: 3600 }, NOW));
    // 3600 + 60 s buffer; up to 1 hour (3660 s is over) the 24h band applies: 60% of the duration.
    expect(p.closeTime).toBe(BigInt(NOW + 3660));
    expect(p.bettingCloseTime).toBe(BigInt(NOW + Math.floor((3660 * 6000) / 10000)));
    const week = ok(buildPool({ kind: 'crypto', symbol: 'BTC', direction: 'above', strike: 1, durationSec: 604800 }, NOW));
    expect(week.closeTime).toBe(BigInt(NOW + 604800 - 60));
  });

  it('shows the exact target, grouped the same way in every browser, and refuses one it cannot show plainly', () => {
    const q = (strike: number) => buildPool({ kind: 'crypto', symbol: 'BTC', direction: 'above', strike, durationSec: 3600 }, NOW);
    expect(q(1234567.891)).toMatchObject({ ok: true, pool: { question: 'Will BTC close above $1,234,567.891 in 1 hour?', oracleRef: 'BTC:gt:1234567.891' } });
    expect(q(9.70545)).toMatchObject({ ok: true, pool: { question: 'Will BTC close above $9.70545 in 1 hour?' } });
    expect(q(0.0000001)).toEqual({ ok: false, reason: 'This target is too small or too large for a pool to settle.' });
  });

  it('refuses a missing asset or a target of zero', () => {
    expect(buildPool({ kind: 'crypto', symbol: ' ', direction: 'above', strike: 1, durationSec: 300 }, NOW)).toEqual({ ok: false, reason: 'Pick an asset.' });
    expect(buildPool({ kind: 'stocks', symbol: 'AAPL', direction: 'above', strike: 0, durationSec: 300 }, NOW)).toEqual({ ok: false, reason: 'Enter a target price above 0.' });
  });
});

describe('sports pools', () => {
  const kickoff = new Date((NOW + 2 * 86400) * 1000).toISOString();
  const fixture = { id: 537890, homeTeam: 'Arsenal', awayTeam: 'Chelsea', kickoffIso: kickoff };

  it('football: each question type, and over 2.5 in the exact text the resolver matches', () => {
    const q = (question: 'home_win' | 'away_win' | 'draw' | 'over') => ok(buildPool({ kind: 'football', fixture, question }, NOW));
    expect(q('home_win')).toMatchObject({ question: 'Will Arsenal beat Chelsea?', oracleRef: '537890:home_win:0' });
    expect(q('away_win')).toMatchObject({ question: 'Will Chelsea beat Arsenal?', oracleRef: '537890:away_win:0' });
    expect(q('draw')).toMatchObject({ question: 'Will Arsenal vs Chelsea end in a draw?', oracleRef: '537890:draw:0' });
    const over = q('over');
    expect(over).toMatchObject({ question: 'Over 2.5 goals in Arsenal vs Chelsea?', oracleRef: '537890:over:2.5' });
    // cf-worker/src/index.ts:392
    expect(/^(?:Over|Under)\s+2\.5\s+goals\s+in\s+(.+?)\s+vs\s+(.+?)\?$/i.test(over.question)).toBe(true);
  });

  it('football times: betting closes 10 minutes before kick-off, the result after kick-off plus 2H30', () => {
    const p = ok(buildPool({ kind: 'football', fixture, question: 'home_win' }, NOW));
    const start = NOW + 2 * 86400;
    expect(p.bettingCloseTime).toBe(BigInt(start - 600));
    expect(p.closeTime).toBe(BigInt(start + 9000));
  });

  it('basketball: win and total-points questions, and the line in the reference', () => {
    const game = { id: 18444, homeTeam: 'Lakers', visitorTeam: 'Celtics', tipoffIso: kickoff };
    expect(ok(buildPool({ kind: 'basketball', game, question: 'home_win', total: 0 }, NOW))).toMatchObject({ question: 'Will Lakers beat Celtics?', oracleRef: '18444:home_win:0', mType: MarketType.BASKETBALL });
    expect(ok(buildPool({ kind: 'basketball', game, question: 'over', total: 220.5 }, NOW))).toMatchObject({ question: 'Over 220.5 total points in Celtics @ Lakers?', oracleRef: '18444:over:220.5' });
    expect(buildPool({ kind: 'basketball', game, question: 'under', total: 0 }, NOW)).toEqual({ ok: false, reason: 'Enter the total points line.' });
  });

  it('refuses a fixture that has started, is over 7 days out, or has no valid time', () => {
    expect(buildPool({ kind: 'football', fixture: { ...fixture, kickoffIso: new Date((NOW + 300) * 1000).toISOString() }, question: 'home_win' }, NOW).ok).toBe(false);
    expect(buildPool({ kind: 'football', fixture: { ...fixture, kickoffIso: new Date((NOW + 8 * 86400) * 1000).toISOString() }, question: 'home_win' }, NOW)).toEqual({
      ok: false,
      reason: 'Event too far out: Mako Market settles within 7 days.',
    });
    expect(buildPool({ kind: 'football', fixture: { ...fixture, kickoffIso: 'soon' }, question: 'home_win' }, NOW)).toEqual({ ok: false, reason: 'This fixture has no valid start time.' });
  });

  it('refuses a question over the contract limit of 200 bytes, counted in bytes', () => {
    // 'Will H vs A end in a draw?' is 24 bytes around the names; 'Ä' is 2 bytes in UTF-8.
    const draw = (homeTeam: string, awayTeam: string) => buildPool({ kind: 'football', fixture: { ...fixture, homeTeam, awayTeam }, question: 'draw' }, NOW);
    const at200 = draw('Ä'.repeat(44), 'Ä'.repeat(44));
    expect(at200.ok && new TextEncoder().encode(at200.pool.question).length).toBe(200);
    // 201 bytes but only 113 characters: a character count would let it through and the contract would refuse it.
    expect(draw('Ä'.repeat(44), 'Ä'.repeat(44) + 'x')).toEqual({ ok: false, reason: 'This question is too long for a pool. Pick a shorter one.' });
  });

  it('refuses a reference over 32 bytes', () => {
    expect(buildPool({ kind: 'basketball', game: { id: '1'.repeat(20), homeTeam: 'A', visitorTeam: 'B', tipoffIso: kickoff }, question: 'under', total: 123456.25 }, NOW)).toEqual({
      ok: false,
      reason: 'This choice does not fit in a pool reference. Pick another.',
    });
  });
});
