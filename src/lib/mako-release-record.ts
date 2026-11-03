// The reviewed Mako Market pools deployments (naming plan r8 §5, §7.10; owner decision 2026-10-22: one root guard).
// The app loads only for a deployment written here: contract.ts matches NEXT_PUBLIC_MAKO_ADDRESS (and
// NEXT_PUBLIC_MAKO_DEPLOY_BLOCK when set) against these entries when it loads, and throws on no match. Adding an entry
// is a reviewed code change, never an environment edit; the environment only chooses among entries, exactly. Imports
// nothing, so pool-display.ts, pool-create.ts and contract.ts can all read it without a cycle.
//
// What makes the V4 entry valid: on that contract, from `dsSince`, the live resolver settles price pools on the
// Chainlink Data Streams report at exactly `closeTime`, and the price pools that closed earlier are the 96 scanned ones
// whose app wording `oldWording` (pool-display.ts) checks. That is also what the pool page's rules card
// (pool-rules.ts poolRules) and the create page state. Another deployment (a V5, #185, or any copy of the code) needs
// its own reviewed entry stating its identity, resolver rule, cutovers and safe title behaviour before the app can
// target it. `pnpm verify:mako-release` checks `chainId`, `deployTx`, `deployBlock` and `runtimeCodeHash` against
// the chain; run it whenever an entry is written or changed, and before each production promote.

export type MakoRelease = {
  chainId: number;
  address: `0x${string}`; // EIP-55
  deployBlock: number;
  deployTx: `0x${string}`;
  sourceCommit: string; // jesterkeri/mako-contracts, a pointer for reviewers, not machine-checked
  runtimeCodeHash: `0x${string}`; // keccak256 of eth_getCode(address)
  /// From these close times (unix seconds) price pools settle on the Data Streams report at the close second.
  dsSince: { crypto: number; rwa: number };
  /// The exact stored questions of the pools that get a built title and keep a "First worded as" line.
  vettedWording: Readonly<Record<number, string>>;
};

export const MAKO_RELEASES: readonly MakoRelease[] = [
  {
    // MakoMarketsV4 on Monad testnet. mako-contracts broadcast/DeployV4.s.sol/10143/run-1779127810336.json (committed
    // in 384577c): one CREATE of MakoMarketsV4 at this address in this transaction, receipt block 0x1f17e1e =
    // 32603678, status 1. That file's `commit` reads 8564a7e (HEAD when forge ran); the V4 source was committed after,
    // as d088ced (2026-09-11), so the code hash, not the commit, pins the deployed artifact. Hash measured 2026-10-22
    // at block 73297879 (viem keccak256 of eth_getCode) and cross-checked with `cast keccak` of `cast code`.
    chainId: 10143,
    address: '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195',
    deployBlock: 32603678,
    deployTx: '0x820d7d68d9bf1bf54aa15cd33370e8baac6bd7e57b0670509a26f137ced39740',
    sourceCommit: 'd088ced7afe43b1056fb4b08298931ea795932c2',
    runtimeCodeHash: '0x0fc0b5588ccd94ced09091e88ac19fb106c4521b38b11c9f8a276073f2779523',
    dsSince: {
      // 2026-10-13T14:24:00Z: resolver 1c4982e (Data Streams, crypto) deployed between 14:07:10Z and its first live
      // tick at 14:23:58Z (.claude/design/bench/ds-swap canary); no crypto pool closes between 09:39:06 (121) and 14:36:01 (122).
      crypto: 1_791_901_440,
      // 2026-10-16T00:00:00Z: resolver 46e3df5e (forex, metals, stocks on Data Streams) deployed 2026-10-15; canary
      // pool 138 settled on Data Streams at its close second; no such pool closes between 88 (09-28) and 138.
      rwa: 1_792_108_800,
    },
    // The 24 price pools closing at or after their class's cutover, each with its exact stored question, copied from
    // src/lib/__tests__/fixtures/v4-price-pools-0-151.json (read-only read of this contract at block 73297879,
    // identical to the adversary's read at 73261902). The questions cannot change on chain, so a copy error shows as
    // a missing line, never as unvetted text.
    vettedWording: {
      93: 'Will BTC close above $84,245 in 7 days?',
      101: 'Will MON close above $0.025 in 7 days?',
      103: 'Will SUI close above $1.25 in 7 days?',
      109: 'Will SOL close above $111 in 7 days?',
      114: 'Will ETH close above $2,601 in 7 days?',
      118: 'Will MON close above $0.026 in 7 days?',
      122: 'Will MON close above $0.0248 in 5 minutes?',
      123: 'Will BTC close above $84,208 in 7 days?',
      124: 'Will SUI close above $1.06 in 7 days?',
      126: 'Will SUI close above $1.06 in 1 hour?',
      127: 'Will SOL close below $106 in 1 hour?',
      129: 'Will MON close above $0.0229 in 7 days?',
      130: 'Will BTC close above $80,000 in 3 days?',
      136: 'Will ETH close above $2,395 in 6 hours?',
      137: 'Will EURUSD trade above 1.1 in 7 days?',
      138: 'Will EURUSD trade above 1.1 in 5 minutes?',
      140: 'Will DOGE close above $0.0813 in 1 hour?',
      142: 'Will SOL close above $107 in 7 days?',
      143: 'Will APT close above $0.791 in 7 days?',
      145: 'Will ETH close below $2,418 in 1 hour?',
      147: 'Will MON close above $0.0219 in 1 hour?',
      149: 'Will ETH close below $2,414 in 1 hour?',
      150: 'Will AVAX close above $9.75 in 7 days?',
      151: 'Will BTC close above $83,368 in 7 days?',
    },
  },
];
