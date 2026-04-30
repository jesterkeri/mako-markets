// ----------------------------------------------------------------------------
// src/lib/aa-public-client.ts
//
// Server-only viem PublicClient cache for AA-layer on-chain reads. The AA
// flow needs to query a few things directly against Monad (not via the
// Pimlico bundler):
//   - `EntryPoint.getNonce(sender, key)` — drives the nonce field of every
//     user op. The bundler does NOT advance nonces; the EntryPoint does.
//   - Future: `getCode(safeAddress)` for the lib's deployment check (already
//     handled by `safe-init.ts` against its own client cache; left as-is to
//     avoid touching shipped code, this module is the AA-flow-specific
//     successor).
//
// Server-only because `MONAD_RPC_URL` may carry an embedded API key in
// some hosting setups. Even when public, keeping all RPC client setup
// behind `import 'server-only'` makes accidental client imports fail loud.
//
// Per-chain cache. One viem PublicClient per chainId, instantiated lazily
// the first time `getAaPublicClient(chainId)` is called.
// ----------------------------------------------------------------------------

import 'server-only';

import {
  createPublicClient,
  http,
  type PublicClient,
} from 'viem';

import { monadTestnet, MONAD_TESTNET_ID } from './chain';
import {
  isSupportedAaChainId,
  type SupportedAaChainId,
} from './aa-config';

const PUBLIC_CLIENTS = new Map<number, PublicClient>();

/// Return a cached viem `PublicClient` configured for the AA layer's RPC
/// reads. Throws when called for a chain that isn't in the AA allowlist.
export function getAaPublicClient(
  chainId: SupportedAaChainId,
): PublicClient {
  if (!isSupportedAaChainId(chainId)) {
    // Defensive: callers should already be type-narrowing, but the runtime
    // check matches `aa-config.getBundlerUrl`'s posture so misuse fails
    // loud at the same boundary.
    throw new Error(
      `aa-public-client: chainId ${chainId} not in AA allowlist`,
    );
  }
  const cached = PUBLIC_CLIENTS.get(chainId);
  if (cached) return cached;

  let client: PublicClient;
  if (chainId === MONAD_TESTNET_ID) {
    const url =
      process.env.MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];
    client = createPublicClient({
      chain: monadTestnet,
      transport: http(url),
    });
  } else {
    // Unreachable today — `isSupportedAaChainId` already gates the input
    // to the SUPPORTED_AA_CHAIN_IDS tuple. Future chains add a branch
    // here, mirroring the same chain object + RPC URL convention.
    throw new Error(
      `aa-public-client: no PublicClient configured for chainId ${chainId}`,
    );
  }

  PUBLIC_CLIENTS.set(chainId, client);
  return client;
}
