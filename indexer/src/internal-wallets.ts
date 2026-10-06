// Mako Market's own wallets: indexed like any other, but left out of every public count (GlobalStats, DailyStats,
// CategoryStats), so the stats show people who came through the product, not its operator. Lower-case addresses.
//
// 0xc8bf…90f1 is MakoMarketsV4's owner, resolver and treasury (read on chain 2026-10-01), and MakoRoundsV1's treasury.
// The three MakoRoundsV1 creators and the keeper that settles rounds were added 2026-10-06 (Joshua): the creators and
// treasury are from mako-contracts deployments/rounds-v1-10143-0x9dC0…2921.json, the keeper is the deployer address
// of that same deployment. Add the operator's test accounts (their Safe for email accounts) here; a change needs a
// resync, which HyperSync makes fast.
export const INTERNAL_WALLETS: ReadonlySet<string> = new Set([
  '0xc8bf886f73e4371cbd8160eea7683b8da98190f1', // V4 owner/resolver, treasury of both contracts
  '0xe3600a066318c30f298074ec2f24c9fcdce409e7', // MakoRoundsV1 creator
  '0xe490ab83c7f247bec7d5e04ce04bc48d6609b550', // MakoRoundsV1 creator (house1)
  '0xf301ddf76efb3f342e8c6b3b9eb52b6d9851d801', // MakoRoundsV1 creator (house2)
  '0x87adf596a31d6f30410f174577c1adec4a32319f', // keeper: deployed MakoRoundsV1, settles rounds
]);

export const isInternal = (address: string): boolean => INTERNAL_WALLETS.has(address.toLowerCase());
