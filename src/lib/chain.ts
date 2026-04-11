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
