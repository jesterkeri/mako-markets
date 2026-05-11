import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/private-markets/treasury.ts
//
// Memoized accessor for the MakoPrivateMarketsV1 treasury address.
// Treasury is set in the contract's constructor with no setter and no
// proxy — confirmed in MakoPrivateMarketsV1.sol lines 209-211, 332-341.
// Once known, the address is bound for the contract's lifetime; this
// module caches it for the process lifetime.
//
// Caching contract (Codex 2C-1 r2 MAJ-3 + r3 MIN-2):
//   - Successful chain read → cache forever for the process lifetime.
//   - Chain RPC failure + env PRIVATE_MARKETS_TREASURY set →
//       log a warn, cache the normalized env value FOREVER. To pick
//       up a recovered RPC, the operator MUST restart the process.
//   - Chain RPC failure + no env → re-throw (route 500s).
//   - Both succeed AND differ → throw config-drift error.
//   - Concurrent first-callers share `inFlight`. On reject, the
//     `finally` clears `inFlight` so the NEXT caller retries the
//     chain read instead of being stuck on the rejected promise.
//
// The participant + allowlist treasury-exclusion checks in
// aa-call-allowlist.ts MUST use this accessor — passing a stale env
// directly would let malicious callers craft a market with the
// treasury as a participant if env is wrong.
// ----------------------------------------------------------------------------

import type { Address } from 'viem';

import { getAaPublicClient } from '@/lib/aa-public-client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { PM_CONTRACT_ADDRESS } from '@/lib/contract';
import { normalizeHex } from './normalize';

let cached: Address | null = null;
let inFlight: Promise<Address> | null = null;

/// Read an env var as a `0x${string}`-typed address. Returns null if
/// unset OR if the value isn't well-formed (silently — the caller
/// either falls back to chain or re-throws). normalizeHex enforces
/// stricter length checking downstream.
function readEnvAddress(name: string): `0x${string}` | null {
  const v = process.env[name];
  if (!v) return null;
  if (!v.startsWith('0x')) return null;
  return v as `0x${string}`;
}

const TREASURY_ABI = [
  {
    type: 'function',
    name: 'treasury',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const;

export async function getPmTreasuryAddress(): Promise<Address> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    let onChain: Address | null = null;
    try {
      const client = getAaPublicClient(MONAD_TESTNET_ID);
      const result = await client.readContract({
        address: PM_CONTRACT_ADDRESS,
        abi: TREASURY_ABI,
        functionName: 'treasury',
      });
      onChain = normalizeHex(result as Address, 20) as Address;
    } catch (err) {
      const envVal = readEnvAddress('PRIVATE_MARKETS_TREASURY');
      if (envVal) {
        // eslint-disable-next-line no-console
        console.warn(
          `[pm-treasury] chain read failed (${(err as Error)?.message ?? 'unknown'}); ` +
            `using PRIVATE_MARKETS_TREASURY env value. Cached for process lifetime; ` +
            `restart to retry chain after RPC recovery.`,
        );
        cached = normalizeHex(envVal, 20) as Address;
        return cached;
      }
      throw err;
    }

    const envVal = readEnvAddress('PRIVATE_MARKETS_TREASURY');
    if (envVal && normalizeHex(envVal, 20) !== onChain) {
      throw new Error(
        `PRIVATE_MARKETS_TREASURY mismatch: env says ${envVal}, ` +
          `chain says ${onChain}. Treasury is immutable per contract.`,
      );
    }

    cached = onChain;
    return cached;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/// @internal Test-only. Throws outside the test environment so a
/// misbehaving route can't accidentally reset cache in production.
export function __resetPmTreasuryCache(): void {
  if (
    process.env.MAKO_STAGE !== 'test' &&
    process.env.NODE_ENV !== 'test'
  ) {
    throw new Error('__resetPmTreasuryCache: test-only');
  }
  cached = null;
  inFlight = null;
}
