// Adversary pass on cc8d919 (create pool, 10a), spec mako-design/REDESIGN_10A_CREATE_SPEC.md rule 1: the oracle
// reference must "parse in the resolver to the market the creator was shown". The commit enforces this for forex,
// commodities and stocks and leaves crypto unchanged. A crypto question writes the target with
// formatStrikeForDisplay, which for a target of 1 or more is Number.toLocaleString() and keeps at most 3 decimals,
// while the reference keeps every digit. The resolver settles on the reference (cf-worker/src/index.ts
// parseCryptoOracleRef, `Number(strikePart)` at line 255, and deriveCryptoOutcome `currentPrice > strike` at line 407),
// so the pool settles against a target nobody was shown.
//
// The resolver's parser is not exported on this branch; its two steps are quoted below.

import { describe, expect, it } from 'vitest';

import { buildPool } from '../pool-create';

const NOW = 1_800_000_000;

/// cf-worker/src/index.ts parseCryptoOracleRef: split on ':', trim, the third part read with Number().
const resolverStrike = (ref: string) => Number(ref.split(':').map((p) => p.trim())[2]);
/// cf-worker/src/index.ts deriveCryptoOutcome, op 'gt'.
const resolverSaysYes = (strike: number, price: number) => price > strike;

describe('rule 1: a crypto pool settles on the target its question shows', () => {
  // The target input keeps digits and '.', with no cap on decimals (CreatePoolClient.tsx:415).
  const cases: [symbol: string, typed: string][] = [
    ['LINK', '9.70545'],
    ['SOL', '89.1234'],
    ['BTC', '77154.9999'],
  ];
  for (const [symbol, typed] of cases) {
    it(`${symbol} target "${typed}": if built, the question shows the strike the resolver reads`, () => {
      const r = buildPool({ kind: 'crypto', symbol, direction: 'above', strike: Number(typed), durationSec: 3600 }, NOW);
      // Refusing a target it cannot show exactly also meets the rule.
      if (!r.ok) return;
      const shownText = r.pool.question.match(/\$([\d,.]+) in /)?.[1] ?? 'NaN';
      const shown = Number(shownText.replace(/,/g, ''));
      const settles = resolverStrike(r.pool.oracleRef);
      expect({ question: r.pool.question, shown }).toEqual({ question: r.pool.question, shown: settles });
    });
  }

  it('the gap changes who wins: LINK closes at 9.7052, above the $9.705 the question shows', () => {
    const r = buildPool({ kind: 'crypto', symbol: 'LINK', direction: 'above', strike: 9.70545, durationSec: 3600 }, NOW);
    if (!r.ok) return;
    const close = 9.7052;
    const wordsSayYes = close > Number(r.pool.question.match(/\$([\d,.]+) in /)?.[1]?.replace(/,/g, '') ?? 'NaN');
    expect({ question: r.pool.question, wordsSayYes, resolverSaysYes: resolverSaysYes(resolverStrike(r.pool.oracleRef), close) }).toEqual({
      question: r.pool.question,
      wordsSayYes,
      resolverSaysYes: wordsSayYes,
    });
  });
});
