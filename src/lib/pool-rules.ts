// What the pool page (9a) says about how a pool resolves and where it is in its life. Every line mirrors the
// resolver (cf-worker/src/index.ts: parse*OracleRef, derive*Outcome) and the Pools contract (forceRefund after
// RESOLUTION_GRACE), so the page never promises a rule the settlement does not follow.

import { hexToString } from 'viem';

import { MarketType, type MarketWithId } from './contract';
import { formatCountdown } from './countdown';
import type { PoolState } from './pool-list';

/// The contract's RESOLUTION_GRACE: after the close time plus this, anyone may mark an unsettled pool refunded.
export const RESOLUTION_GRACE_SEC = 24 * 3_600;

type PriceRef = { kind: 'price'; symbol: string; op: 'gt' | 'lt'; strike: string };
type SportRef = { kind: 'football' | 'basketball'; type: 'home_win' | 'away_win' | 'draw' | 'over' | 'under'; param: string };
export type OracleRef = PriceRef | SportRef;

/// The pool's settlement reference, decoded exactly as the resolver decodes it, or null when it does not parse
/// (the resolver skips such a pool, so the page states no YES/NO rule for it).
export function parseOracleRef(m: Pick<MarketWithId, 'mType' | 'oracleRef'>): OracleRef | null {
  let text: string;
  try {
    text = hexToString(m.oracleRef, { size: 32 }).replace(/\0+$/, '').trim();
  } catch {
    return null;
  }
  const parts = text.split(':').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [a, b, c] = parts;
  if (m.mType === MarketType.CRYPTO || m.mType === MarketType.FOREX || m.mType === MarketType.COMMODITIES || m.mType === MarketType.STOCKS) {
    if (!a || (b !== 'gt' && b !== 'lt') || !(Number(c) > 0)) return null;
    return { kind: 'price', symbol: a.toUpperCase(), op: b, strike: c };
  }
  const n = Number(c);
  if (!/^\d+$/.test(a) || !Number.isFinite(n) || n < 0) return null;
  if (m.mType === MarketType.FOOTBALL && ['home_win', 'away_win', 'draw', 'over', 'under'].includes(b)) {
    return { kind: 'football', type: b as SportRef['type'], param: c };
  }
  if (m.mType === MarketType.BASKETBALL && ['home_win', 'away_win', 'over', 'under'].includes(b)) {
    return { kind: 'basketball', type: b as SportRef['type'], param: c };
  }
  return null;
}

/// "Sat 16:30" in the viewer's time zone.
export function dayTime(sec: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(sec * 1000));
}

export type RuleLine = { k: 'YES' | 'NO' | 'CLOSES' | 'REFUND' | 'SOURCE'; v: string };

const unit = (m: MarketWithId) => (m.mType === MarketType.FOREX ? '' : '$');

/// The "How this pool resolves" lines.
export function poolRules(m: MarketWithId, timeZone?: string): RuleLine[] {
  const close = dayTime(Number(m.closeTime), timeZone);
  const bettingClose = dayTime(Number(m.bettingCloseTime), timeZone);
  const ref = parseOracleRef(m);
  const lines: RuleLine[] = [];

  if (m.mType === MarketType.MAKO) {
    lines.push({ k: 'YES', v: 'As the question says. Mako Market settles this house pool by hand.' });
  } else if (ref?.kind === 'price') {
    const s = `${unit(m)}${ref.strike}`;
    lines.push(
      ref.op === 'gt'
        ? { k: 'YES', v: `${ref.symbol} is above ${s} at the first price check after ${close}.` }
        : { k: 'YES', v: `${ref.symbol} is below ${s} at the first price check after ${close}.` },
      ref.op === 'gt' ? { k: 'NO', v: `${ref.symbol} is at ${s} or below at that check.` } : { k: 'NO', v: `${ref.symbol} is at ${s} or above at that check.` },
    );
  } else if (ref) {
    const what = ref.kind === 'football' ? 'goals' : 'points';
    const yesNo: Record<SportRef['type'], [string, string]> = {
      home_win: ['The home team wins.', ref.kind === 'football' ? 'A draw or an away win.' : 'The away team wins.'],
      away_win: ['The away team wins.', ref.kind === 'football' ? 'A draw or a home win.' : 'The home team wins.'],
      draw: ['The match ends level.', 'Either team wins.'],
      over: [`More than ${ref.param} ${what} in total.`, `${ref.param} ${what} or fewer.`],
      under: [`Fewer than ${ref.param} ${what} in total.`, `${ref.param} ${what} or more.`],
    };
    const [yes, no] = yesNo[ref.type];
    lines.push({ k: 'YES', v: yes }, { k: 'NO', v: no });
  }

  lines.push({ k: 'CLOSES', v: `Betting closes ${bettingClose}. The result is settled after ${close}.` });

  const voided =
    ref?.kind === 'football'
      ? 'A postponed or cancelled match is refunded. '
      : ref?.kind === 'basketball'
        ? `A postponed or cancelled game is refunded${ref.type === 'home_win' || ref.type === 'away_win' ? ', and so is a tie' : ''}. `
        : '';
  lines.push({
    k: 'REFUND',
    v: `${voided}If it isn't settled within 24H of ${close}, anyone can mark it refunded. Refunds carry no fee: everyone claims their stake back.`,
  });

  const source =
    m.mType === MarketType.MAKO
      ? 'Mako Market.'
      : ref?.kind === 'football'
        ? 'The final result from football-data.org, at full time.'
        : ref?.kind === 'basketball'
          ? 'The final score from balldontlie.'
          : m.mType === MarketType.CRYPTO
            ? 'The CoinGecko spot price in USD, checked every minute.'
            : 'The latest Pyth price, checked every minute. A price Pyth marks as uncertain is skipped.';
  lines.push({ k: 'SOURCE', v: source });
  return lines;
}

/// The header clock (9a): its label, big value and line underneath, per state.
export function poolClock(m: MarketWithId, state: PoolState, nowSec: number, timeZone?: string): { label: string; value: string; sub: string } {
  const bettingClose = dayTime(Number(m.bettingCloseTime), timeZone);
  const close = dayTime(Number(m.closeTime), timeZone);
  switch (state) {
    case 'open':
      return { label: 'Closes in', value: formatCountdown(Number(m.bettingCloseTime) - nowSec), sub: `Betting stops ${bettingClose}.` };
    case 'betting_closed':
      return { label: 'Result after', value: formatCountdown(Number(m.closeTime) - nowSec), sub: `Betting closed ${bettingClose}. The result is settled after ${close}.` };
    case 'resolving':
      return nowSec >= Number(m.closeTime) + RESOLUTION_GRACE_SEC
        ? { label: 'Result', value: 'Overdue', sub: `Not settled within 24H of ${close}, so anyone can mark it refunded.` }
        : { label: 'Result', value: 'Settling', sub: `Mako Market settles it after ${close}. If it isn't settled within 24H, it can be refunded.` };
    case 'yes_won':
      return { label: 'Result', value: 'YES won', sub: 'Winners can claim from this page or Me.' };
    case 'no_won':
      return { label: 'Result', value: 'NO won', sub: 'Winners can claim from this page or Me.' };
    case 'refunded':
      return { label: 'Result', value: 'Refunded', sub: 'Everyone claims their stake back, no fees.' };
  }
}

/// "How results work" (18a): the four things that happen after a pool opens, in the words the contract and the
/// resolver keep. The creator fee is the pool's own snapshot (2% today) of the WHOLE pool, paid only when the
/// smaller side is at least the minimum ratio of the larger (MakoMarketsV4 `_isCreatorFeeForfeited`); a pool not
/// settled within RESOLUTION_GRACE of its close can be force-refunded by anyone. The resolver's one-sided keeper is
/// not deployed yet (branch `fix/resolver-one-sided-refund`), so step 04 does not claim it.
export function resultSteps(m: MarketWithId, minRatioBps: number, timeZone?: string): { n: string; title: string; body: string }[] {
  const house = m.mType === MarketType.MAKO;
  const fee = m.creatorFeeBpsSnapshot / 100;
  return [
    { n: '01', title: 'Betting closes', body: `At the time set when the pool was created: ${dayTime(Number(m.bettingCloseTime), timeZone)}.` },
    {
      n: '02',
      title: 'Mako Market settles it',
      body: house ? 'Mako Market settles this house pool by hand.' : 'Mako Market’s resolver settles the result from the pool’s source. Nobody reports or votes.',
    },
    {
      n: '03',
      title: 'Winners claim',
      body:
        m.creatorFeeBpsSnapshot === 0
          ? 'Claim from the pool page or Me. This pool pays no creator fee.'
          : `Claim from the pool page or Me. The creator earns ${fee}% of the whole pool when the smaller side is at least ${minRatioBps / 100}% of the larger.`,
    },
    {
      n: '04',
      title: 'Not settled in 24H',
      body: 'Anyone can then mark it refunded. Everyone claims their stake back, no fees.',
    },
  ];
}

/// The four-part step bar under the header: open, betting closes, the wait for the result, the result.
export function poolSteps(m: MarketWithId, state: PoolState, timeZone?: string) {
  const ref = parseOracleRef(m);
  const close = dayTime(Number(m.closeTime), timeZone);
  const idx = state === 'open' ? 0 : state === 'betting_closed' ? 1 : state === 'resolving' ? 2 : 3;
  const parts: [string, string, number][] = [
    ['Open', dayTime(Number(m.createdAt), timeZone), 6],
    ['Closes', dayTime(Number(m.bettingCloseTime), timeZone), 5],
    [ref?.kind === 'football' || ref?.kind === 'basketball' ? 'Match' : 'Wait', `until ${close}`, 2],
    ['Result', `after ${close}`, 2],
  ];
  return parts.map(([l, t, flex], i) => ({ l, t, flex, done: i < idx, current: i === idx }));
}
