import 'server-only';

import { keccak256, type Address } from 'viem';

import { NotAllowedError } from '@/lib/aa-call-allowlist';
import { getAaPublicClient } from '@/lib/aa-public-client';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { ROUNDS_RELEASE, type RoundsRelease } from '@/lib/contract';
import { roundsAbi } from '@/lib/rounds-abi';
import { USDC_ADDRESS } from '@/lib/usdc';

// The on-chain half of the Rounds pin (Codex S2 r1): before any sponsored Rounds action, and again before a stored
// one is sent, the chain must still show the reviewed MakoRoundsV1 at the pinned address: the runtime code whose
// keccak256 is in ROUNDS_RELEASE, built with the configured USDC. Anything else, a failed read included, refuses the
// action with round_unavailable. A match is remembered for the life of the process: the contract has no upgrade
// path, so its code cannot change after a match.

export type ReleaseReader = {
  getBytecode(address: Address): Promise<`0x${string}` | undefined>;
  readUsdc(address: Address): Promise<Address>;
};

function chainReader(): ReleaseReader {
  const client = getAaPublicClient(MONAD_TESTNET_ID);
  return {
    getBytecode: (address) => client.getBytecode({ address }),
    readUsdc: async (address) => (await client.readContract({ address, abi: roundsAbi, functionName: 'USDC' })) as Address,
  };
}

let verified: string | null = null;

/// Test seam: forget a remembered match.
export function resetRoundsReleaseCache(): void {
  verified = null;
}

export async function assertRoundsRelease(release: RoundsRelease | null = ROUNDS_RELEASE, read: ReleaseReader = chainReader()): Promise<void> {
  if (!release) throw new NotAllowedError('round_unavailable');
  const key = `${release.address.toLowerCase()}:${release.runtimeCodeHash.toLowerCase()}:${release.usdc.toLowerCase()}`;
  if (verified === key) return;
  if (release.usdc.toLowerCase() !== USDC_ADDRESS.trim().toLowerCase()) throw new NotAllowedError('round_unavailable', 'usdc_config');
  let code: `0x${string}` | undefined;
  let usdc: Address;
  try {
    [code, usdc] = await Promise.all([read.getBytecode(release.address), read.readUsdc(release.address)]);
  } catch {
    throw new NotAllowedError('round_unavailable', 'identity_unreadable');
  }
  if (!code || code === '0x' || keccak256(code).toLowerCase() !== release.runtimeCodeHash.toLowerCase()) {
    throw new NotAllowedError('round_unavailable', 'code_hash');
  }
  if (usdc.toLowerCase() !== release.usdc.toLowerCase()) throw new NotAllowedError('round_unavailable', 'usdc');
  verified = key;
}
