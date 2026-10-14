// MIRROR_ORACLE_REF_PARSERS.
//
// The shared vector table for the price-feed oracleRef parser, which exists in
// THREE copies: the resolver (cf-worker/src/index.ts), the sponsor-time gate
// that decides what may be created (src/lib/aa-call-allowlist.ts) and the
// watchdog, which raises UO for anything the resolver would refuse
// (watchdog/src/oracle-ref.ts).
//
// Watchdog slice-1 review r8: the MIRROR_ markers proved a copy was declared,
// not that it still behaves like its original. Two tests pin every copy to
// this table:
//
//   watchdog/test/mirror-differential.test.ts  resolver vs watchdog, compared
//                                              DIRECTLY as well as against
//                                              this table
//   src/lib/__tests__/oracle-ref-sponsor-mirror.test.ts   sponsor-time gate
//
// The sponsor gate cannot be imported into the Worker test environment (it is
// a `server-only` module) and the resolver cannot be imported into the app's
// TypeScript program (it needs Workers globals), so this table is the bridge
// between them. Expectations were produced by running the deployed resolver's
// own parser, and the watchdog test fails if the resolver ever stops agreeing
// with them, so the table cannot drift away from the resolver unnoticed.
//
// `accepts` lists the market classes that accept the reference, with the
// parsed triple. An empty object means every class rejects it.

export interface PriceFeedVector {
  ref: string;
  accepts: Partial<Record<'forex' | 'commodities' | 'stocks', { symbol: string; op: 'gt' | 'lt'; strike: number }>>;
}

export const PRICE_FEED_CLASSES = ['forex', 'commodities', 'stocks'] as const;

export const PRICE_FEED_VECTORS: PriceFeedVector[] = [
  { ref: "EURUSD:gt:1.1", accepts: { forex: { symbol: "EURUSD", op: "gt", strike: 1.1 } } },
  { ref: "XAUUSD:lt:2000", accepts: { commodities: { symbol: "XAUUSD", op: "lt", strike: 2000 } } },
  { ref: "AAPL:gt:150", accepts: { stocks: { symbol: "AAPL", op: "gt", strike: 150 } } },
  { ref: "AAPL:gt:150.00", accepts: { stocks: { symbol: "AAPL", op: "gt", strike: 150 } } },
  { ref: "EURUSD:gt:1e0", accepts: {} },
  { ref: "EURUSD:gt:+1.5", accepts: { forex: { symbol: "EURUSD", op: "gt", strike: 1.5 } } },
  { ref: "EURUSD:gt:.5", accepts: { forex: { symbol: "EURUSD", op: "gt", strike: 0.5 } } },
  { ref: "EURUSD:gt:0", accepts: {} },
  { ref: "EURUSD:gt:-1", accepts: {} },
  { ref: "EURUSD:GT:1", accepts: {} },
  { ref: "NOSUCH:gt:1", accepts: {} },
  { ref: "EURUSD:gt:", accepts: {} },
  { ref: "EURUSD:gt:1.", accepts: {} },
  { ref: "EURUSD:gt:1_0", accepts: {} },
  { ref: "EURUSD:gt:0x1", accepts: {} },
  { ref: "", accepts: {} },
  { ref: "EURUSD:gt:1:2", accepts: {} },
  { ref: " EURUSD : gt : 1.1 ", accepts: { forex: { symbol: "EURUSD", op: "gt", strike: 1.1 } } },
  { ref: "XAUUSD:gt:1", accepts: { commodities: { symbol: "XAUUSD", op: "gt", strike: 1 } } },
  { ref: "AAPL:lt:0.01", accepts: { stocks: { symbol: "AAPL", op: "lt", strike: 0.01 } } },
];
