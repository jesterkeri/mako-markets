// Mako Market's own wallets: indexed like any other, but left out of every public count (GlobalStats, DailyStats,
// CategoryStats), so the stats show people who came through the product, not its operator. Lower-case addresses.
//
// 0xc8bf…90f1 is MakoMarketsV4's owner, resolver and treasury (read on chain 2026-10-01). Add the operator's test
// accounts (their Safe for email accounts) here; a change needs a resync, which HyperSync makes fast.
export const INTERNAL_WALLETS: ReadonlySet<string> = new Set([
  '0xc8bf886f73e4371cbd8160eea7683b8da98190f1',
]);

export const isInternal = (address: string): boolean => INTERNAL_WALLETS.has(address.toLowerCase());
