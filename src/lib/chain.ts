import { type Chain } from 'viem';

// Multicall3 is deployed at the canonical CREATE2 address on Monad testnet.
// Declaring it here lets wagmi's `useReadContracts` batch all calls into a
// single eth_call via Multicall3.aggregate3, instead of fanning out to N
// individual eth_calls. The public Monad RPC rate-limits large fanouts,
// which caused partial failures on /me (visible as the READ ERROR banner).
// Verified via `cast code` before wiring.
export const monadTestnet = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet-rpc.monad.xyz/'] },
    public: { http: ['https://testnet-rpc.monad.xyz/'] },
  },
  blockExplorers: {
    default: { name: 'Monad Explorer', url: 'https://testnet.monad.xyz/' },
  },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
      blockCreated: 0,
    },
  },
} as const satisfies Chain;

/// Numeric chain ids for the chains Mako tracks Safe addresses on. Used by
/// `user_safes` upserts at signup time. Path X locks every chain to the same
/// derived Safe address, but the rows are still keyed `(user_id, chain_id)`
/// so the schema can pivot to Path Y (different addresses per chain) without
/// a migration if a future chain breaks Path X.
export const MONAD_TESTNET_ID = 10143 as const;
export const BASE_SEPOLIA_ID = 84532 as const;

/// The set of chain ids a user gets a Safe row for at signup. Keep this in
/// sync with the chains the rest of the app reads balances from.
export const SAFE_TRACKED_CHAIN_IDS = [
  MONAD_TESTNET_ID,
  BASE_SEPOLIA_ID,
] as const;
