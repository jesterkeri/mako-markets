// MIRROR_ORACLE_REF_PARSERS.
//
// The sponsor-time gate decides what may be CREATED. If it drifts wider than
// the resolver, the app sponsors a market nothing can ever settle and the
// watchdog will raise UO for it for ever; narrower, and it refuses a market
// the resolver handles fine.
//
// Watchdog slice-1 review r8: the MIRROR_ marker proved the copy was declared,
// not that it still agrees. It is pinned here to the shared table in
// test-vectors/, which watchdog/test/mirror-differential.test.ts pins to the
// resolver's own parser. The resolver cannot be imported into this TypeScript
// program (it needs Workers globals), which is why the table is the bridge.
import { describe, expect, it } from 'vitest';
import { stringToHex } from 'viem';
import { PRICE_FEED_CLASSES, PRICE_FEED_VECTORS } from '../../../test-vectors/price-feed-oracle-ref';
import { parsePriceFeedOracleRef } from '../aa-call-allowlist';

const hex = (s: string) => stringToHex(s, { size: 32 });

describe('the sponsor-time oracleRef gate mirrors the resolver', () => {
  it('accepts exactly what the resolver settles, per class', () => {
    for (const v of PRICE_FEED_VECTORS) {
      for (const cls of PRICE_FEED_CLASSES) {
        const label = `${v.ref} as ${cls}`;
        const want = v.accepts[cls] ?? null;
        const got = parsePriceFeedOracleRef(hex(v.ref), cls);
        expect(got.kind === 'ok', label).toBe(!!want);
        if (got.kind === 'ok' && want) {
          expect([got.symbol, got.op, got.strike], label).toEqual([want.symbol, want.op, want.strike]);
        }
      }
    }
  });

  it('the table exercises both verdicts', () => {
    const accepted = PRICE_FEED_VECTORS.filter((v) => Object.keys(v.accepts).length > 0).length;
    expect(accepted).toBeGreaterThan(2);
    expect(PRICE_FEED_VECTORS.length - accepted).toBeGreaterThan(10);
  });
});
