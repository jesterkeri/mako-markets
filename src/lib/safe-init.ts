// ----------------------------------------------------------------------------
// src/lib/safe-init.ts
//
// Owns the "is the user's Safe deployed yet?" question and the EntryPoint
// v0.7 initCode that deploys it via the SafeProxyFactory if not.
//
// Path X promises every user's Safe has the same address on every chain we
// support — but it's still deployed lazily, per-chain, on the first user op.
// `isSafeDeployed(chainId, safeAddress)` checks if there's bytecode at that
// address on a given chain. `buildSafeProxyInitCode(eoa)` packs the factory
// + factory calldata that will deploy the Safe deterministically to the
// expected address.
//
// This module is the bridge between `safe.ts` (which knows what setup to
// pass) and the user-op builder (which needs `factory + factoryData` in
// EntryPoint v0.7's split form OR a single `initCode` blob in the packed
// form for SafeOp hashing).
//
// SERVER-ONLY for the `isSafeDeployed` path because it makes an RPC call
// using a server-controlled provider. The `buildSafeProxyInitCode` path is
// pure and safe to call from anywhere.
// ----------------------------------------------------------------------------

import {
  createPublicClient,
  http,
  encodeFunctionData,
  concat,
  hexToBigInt,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import { SAFE_CONFIG } from './safe-config';
import { buildSafeInitialization } from './safe';
import { monadTestnet, MONAD_TESTNET_ID } from './chain';
import type { SupportedAaChainId } from './aa-config';

/// SafeProxyFactory v1.4.1 ABI — single function, only `createProxyWithNonce`
/// is needed for initCode packing.
const SAFE_PROXY_FACTORY_ABI = [
  {
    name: 'createProxyWithNonce',
    inputs: [
      { name: '_singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

/// Per-chain public client cache. Reused across `isSafeDeployed` calls so we
/// don't open a new HTTP transport on every poll.
const PUBLIC_CLIENTS = new Map<number, PublicClient>();

function getPublicClient(chainId: number): PublicClient {
  const cached = PUBLIC_CLIENTS.get(chainId);
  if (cached) return cached;

  let client: PublicClient;
  if (chainId === MONAD_TESTNET_ID) {
    const url = process.env.MONAD_RPC_URL || monadTestnet.rpcUrls.default.http[0];
    client = createPublicClient({
      chain: monadTestnet,
      transport: http(url),
    });
  } else {
    throw new Error(
      `safe-init: no public client configured for chainId ${chainId}`,
    );
  }
  PUBLIC_CLIENTS.set(chainId, client);
  return client;
}

/**
 * EntryPoint v0.7 split-form init data: a `factory` address and the calldata
 * the EntryPoint will call on it (`createProxyWithNonce(singleton,
 * setupCalldata, saltNonce)`). The bundler RPC payload uses these two as
 * separate fields. The SafeOp hash uses the concatenated form (returned as
 * `initCode` for callers that need the legacy packing).
 *
 * Pure — no RPC, no chainId. Path X means the same payload deploys the same
 * address on every chain.
 */
export function buildSafeProxyInitCode(eoa: Address): {
  factory: Address;
  factoryData: Hex;
  initCode: Hex;
} {
  const { setupCalldata, saltNonce } = buildSafeInitialization(eoa);
  const factoryData = encodeFunctionData({
    abi: SAFE_PROXY_FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [
      SAFE_CONFIG.singleton as Address,
      setupCalldata,
      hexToBigInt(saltNonce),
    ],
  });
  const factory = SAFE_CONFIG.proxyFactory as Address;
  const initCode = concat([factory, factoryData]) as Hex;
  return { factory, factoryData, initCode };
}

/**
 * On-chain check: is there bytecode at `safeAddress` on `chainId`? Returns
 * true once the Safe has been deployed by any prior user op (Mako-issued or
 * not — the address is deterministic, so anyone could trigger deployment).
 *
 * Wraps the result in a tiny in-memory cache on the assumption that "is
 * deployed" only flips false → true and never reverts. Once we've seen
 * bytecode, future calls skip the RPC.
 */
const DEPLOYED_CACHE = new Set<string>();

export async function isSafeDeployed(
  chainId: SupportedAaChainId,
  safeAddress: Address,
): Promise<boolean> {
  const cacheKey = `${chainId}:${safeAddress.toLowerCase()}`;
  if (DEPLOYED_CACHE.has(cacheKey)) return true;

  const client = getPublicClient(chainId);
  const code = await client.getCode({ address: safeAddress });
  // viem returns `undefined` for empty bytecode (modern releases) and `0x` for
  // older. Treat both as "not deployed."
  const deployed = code !== undefined && code !== '0x';
  if (deployed) DEPLOYED_CACHE.add(cacheKey);
  return deployed;
}

/**
 * Returns the init data fields a user op needs to deploy the user's Safe
 * iff it isn't already deployed on `chainId`. Returns `null` for already-
 * deployed Safes so the caller can omit `factory`/`factoryData` from the
 * RPC payload (EntryPoint v0.7 expects absent rather than zero/empty).
 */
export async function getInitCodeForFirstOp(args: {
  chainId: SupportedAaChainId;
  eoa: Address;
  safeAddress: Address;
}): Promise<{ factory: Address; factoryData: Hex; initCode: Hex } | null> {
  if (await isSafeDeployed(args.chainId, args.safeAddress)) return null;
  return buildSafeProxyInitCode(args.eoa);
}
