import { describe, expect, it } from 'vitest';

import {
  getAssetsByClass,
  getPythPriceIds,
  isPriceFeedSymbol,
  normalizePythId,
  PRICE_FEED_ASSETS,
  PRICE_FEED_BY_SYMBOL,
  PRICE_FEED_SYMBOLS,
  PYTH_ID_TO_SYMBOL,
  type PriceFeedAssetClass,
} from '../price-feed-assets';

describe('price-feed-assets metadata invariants', () => {
  it('exposes 35 entries split 10 / 5 / 20 by class', () => {
    expect(PRICE_FEED_ASSETS.length).toBe(35);
    const byClass = PRICE_FEED_ASSETS.reduce<Record<PriceFeedAssetClass, number>>(
      (acc, a) => {
        acc[a.class] = (acc[a.class] ?? 0) + 1;
        return acc;
      },
      { forex: 0, commodities: 0, stocks: 0 },
    );
    expect(byClass).toEqual({ forex: 10, commodities: 5, stocks: 20 });
  });

  it('every pinned pythPriceId normalizes cleanly (proves module-load assertion is real)', () => {
    for (const asset of PRICE_FEED_ASSETS) {
      // Throws on malformed; test passes only if every entry survives.
      expect(() => normalizePythId(asset.pythPriceId)).not.toThrow();
    }
  });

  it('no symbol collisions across classes', () => {
    const seen = new Set<string>();
    for (const asset of PRICE_FEED_ASSETS) {
      expect(seen.has(asset.symbol), `duplicate symbol ${asset.symbol}`).toBe(false);
      seen.add(asset.symbol);
    }
    expect(seen.size).toBe(35);
  });

  it('no pythPriceId collisions (every feed maps to exactly one symbol)', () => {
    const seen = new Set<string>();
    for (const asset of PRICE_FEED_ASSETS) {
      const normalized = normalizePythId(asset.pythPriceId);
      expect(
        seen.has(normalized),
        `duplicate pythPriceId ${normalized} (would corrupt the reverse map)`,
      ).toBe(false);
      seen.add(normalized);
    }
    expect(seen.size).toBe(35);
  });

  it('all symbols are ALL CAPS canonical form', () => {
    for (const asset of PRICE_FEED_ASSETS) {
      expect(asset.symbol).toBe(asset.symbol.toUpperCase());
    }
  });

  it('PRICE_FEED_SYMBOLS Set + PRICE_FEED_BY_SYMBOL Map are consistent', () => {
    expect(PRICE_FEED_SYMBOLS.size).toBe(35);
    expect(PRICE_FEED_BY_SYMBOL.size).toBe(35);
    for (const asset of PRICE_FEED_ASSETS) {
      expect(PRICE_FEED_SYMBOLS.has(asset.symbol)).toBe(true);
      expect(PRICE_FEED_BY_SYMBOL.get(asset.symbol)).toBe(asset);
    }
  });
});

describe('getAssetsByClass', () => {
  it('returns forex sorted by priority ascending', () => {
    const forex = getAssetsByClass('forex');
    expect(forex.length).toBe(10);
    const priorities = forex.map((a) => a.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    // First entry should be EURUSD (priority 1, most liquid).
    expect(forex[0].symbol).toBe('EURUSD');
  });

  it('returns commodities sorted by priority ascending', () => {
    const commodities = getAssetsByClass('commodities');
    expect(commodities.length).toBe(5);
    const priorities = commodities.map((a) => a.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(commodities[0].symbol).toBe('XAUUSD');
  });

  it('returns stocks sorted by priority ascending', () => {
    const stocks = getAssetsByClass('stocks');
    expect(stocks.length).toBe(20);
    const priorities = stocks.map((a) => a.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(stocks[0].symbol).toBe('AAPL');
  });

  it('every stock has marketHours = us_equity (off-hours caveat is class-wide)', () => {
    for (const stock of getAssetsByClass('stocks')) {
      expect(stock.marketHours).toBe('us_equity');
    }
  });

  it('forex + commodities entries do not carry marketHours (no off-hours warning)', () => {
    for (const asset of [...getAssetsByClass('forex'), ...getAssetsByClass('commodities')]) {
      expect(asset.marketHours).toBeUndefined();
    }
  });
});

describe('isPriceFeedSymbol — case-sensitive allowlist gate', () => {
  it('accepts canonical ALL CAPS symbols from each class', () => {
    expect(isPriceFeedSymbol('EURUSD')).toBe(true);
    expect(isPriceFeedSymbol('XAUUSD')).toBe(true);
    expect(isPriceFeedSymbol('AAPL')).toBe(true);
  });

  it('rejects lowercase variants (must NOT auto-uppercase)', () => {
    expect(isPriceFeedSymbol('eurusd')).toBe(false);
    expect(isPriceFeedSymbol('aapl')).toBe(false);
    expect(isPriceFeedSymbol('Aapl')).toBe(false);
  });

  it('rejects unknown symbols', () => {
    expect(isPriceFeedSymbol('MADEUPCOIN')).toBe(false);
    expect(isPriceFeedSymbol('')).toBe(false);
    expect(isPriceFeedSymbol('EUR/USD')).toBe(false); // slash form is label, not symbol
  });
});

describe('getPythPriceIds', () => {
  it('returns 35 unique canonical-0x-form ids', () => {
    const ids = getPythPriceIds();
    expect(ids.length).toBe(35);
    const unique = new Set(ids);
    expect(unique.size).toBe(35);
    for (const id of ids) {
      expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});

describe('PYTH_ID_TO_SYMBOL reverse map', () => {
  it('round-trips every entry', () => {
    expect(PYTH_ID_TO_SYMBOL.size).toBe(35);
    for (const asset of PRICE_FEED_ASSETS) {
      const normalized = normalizePythId(asset.pythPriceId);
      expect(PYTH_ID_TO_SYMBOL.get(normalized)).toBe(asset.symbol);
    }
  });

  it('keys are canonical 0x form (covers the Hermes bare-hex response shape)', () => {
    for (const key of PYTH_ID_TO_SYMBOL.keys()) {
      expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});

describe('normalizePythId', () => {
  // The exact 64-hex body of EUR/USD's Pyth feed — used as the
  // canonical input across these tests since it's already pinned in
  // PRICE_FEED_ASSETS, so any future change to the helper that
  // breaks production input will fail loudly here.
  const EURUSD_BODY = 'a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b';

  it('accepts 0x-prefixed input and returns it unchanged when already lowercase', () => {
    expect(normalizePythId(`0x${EURUSD_BODY}`)).toBe(`0x${EURUSD_BODY}`);
  });

  it('accepts bare hex (no 0x prefix) and prepends 0x — covers Hermes response shape', () => {
    expect(normalizePythId(EURUSD_BODY)).toBe(`0x${EURUSD_BODY}`);
  });

  it('lowercases mixed-case input', () => {
    const upper = EURUSD_BODY.toUpperCase();
    expect(normalizePythId(upper)).toBe(`0x${EURUSD_BODY}`);
    expect(normalizePythId(`0x${upper}`)).toBe(`0x${EURUSD_BODY}`);
  });

  it('throws on empty string', () => {
    expect(() => normalizePythId('')).toThrow(TypeError);
  });

  it('throws on short input (< 64 hex chars)', () => {
    expect(() => normalizePythId('0xabc')).toThrow(/64 hex chars/);
    expect(() => normalizePythId('a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec3' /* 62 hex */)).toThrow(/64 hex chars/);
  });

  it('throws on long input (> 64 hex chars)', () => {
    expect(() => normalizePythId(`0x${EURUSD_BODY}00`)).toThrow(/64 hex chars/);
  });

  it('throws on non-hex characters', () => {
    const bad = 'g'.repeat(64);
    expect(() => normalizePythId(bad)).toThrow(/non-hex/);
    expect(() => normalizePythId(`0x${bad}`)).toThrow(/non-hex/);
  });

  it('throws on non-string input', () => {
    // @ts-expect-error -- intentional bad type to assert runtime guard
    expect(() => normalizePythId(null)).toThrow(TypeError);
    // @ts-expect-error -- intentional bad type to assert runtime guard
    expect(() => normalizePythId(123)).toThrow(TypeError);
    // @ts-expect-error -- intentional bad type to assert runtime guard
    expect(() => normalizePythId(undefined)).toThrow(TypeError);
  });
});
