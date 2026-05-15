// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-call-allowlist-pm-dispatch.test.ts
//
// Phase 2E-1 slice 1D-3: send-time dispatch coverage for the 10 PM
// action selectors. assertSponsoredCallData's PM_CONTRACT_ADDRESS
// branch now routes by inner selector to a shape-only validator for
// every kind. This test ensures:
//
//   1. Each of the 11 PM selectors dispatches to its correct
//      validator and accepts a well-formed call shape.
//   2. An unknown inner selector against PM_CONTRACT_ADDRESS is
//      rejected with bad_selector (not silently routed).
//
// Treasury is mocked because the editMetadata + createMarket
// dispatchers await getPmTreasuryAddress before running their
// shape-only validator. Chain-state hydration is NOT exercised
// here — the dispatcher uses shape-only validators that don't
// hydrate state. Stage A+B coverage for each individual validator
// lives in src/lib/private-markets/__tests__/.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, type Address, type Hex } from 'viem';

const mockGetPmTreasuryAddress = vi.fn();

vi.mock('../private-markets/treasury', () => ({
  getPmTreasuryAddress: () => mockGetPmTreasuryAddress(),
}));

import {
  PM_BET_ABI,
  PM_CANCEL_ABI,
  PM_CLAIM_ABI,
  PM_CONFIRM_ABI,
  PM_CREATE_MARKET_ABI,
  PM_DISTRIBUTE_ABI,
  PM_EDIT_METADATA_ABI,
  PM_FINALIZE_ABI,
  PM_FINALIZE_METADATA_ABI,
  PM_RESOLVE_ABI,
  PM_STAKE_ABI,
  type PmCreateParamsTuple,
} from '../private-markets/abi-fragments';
import { MONAD_TESTNET_ID } from '../chain';
import { PM_CONTRACT_ADDRESS } from '../contract';
import {
  assertSponsoredCallData,
  NotAllowedError,
} from '../aa-call-allowlist';

const SAFE: Address = '0xcafe000000000000000000000000000000000001';
const TREASURY: Address = '0xdead000000000000000000000000000000000099';
const MARKET_ID = 7n;

const SAFE_WRAPPER_ABI = [
  {
    type: 'function',
    name: 'executeUserOp',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

function wrapOpZero(innerData: Hex): Hex {
  return encodeFunctionData({
    abi: SAFE_WRAPPER_ABI,
    functionName: 'executeUserOp',
    args: [PM_CONTRACT_ADDRESS, 0n, innerData, 0],
  });
}

function validCreateParams(): PmCreateParamsTuple {
  return {
    shape: 0,
    stakingOpensAt: 1_700_000_400n,
    closeAt: 1_700_000_500n,
    title: ('0x' +
      Buffer.from('Friendly create').toString('hex')) as `0x${string}`,
    description: '0x' as `0x${string}`,
    streamUrl: '0x' as `0x${string}`,
    optionLabels: [
      ('0x' + Buffer.from('NO').toString('hex')) as `0x${string}`,
      ('0x' + Buffer.from('YES').toString('hex')) as `0x${string}`,
    ],
    participantWallets: [],
    allowlist: [],
    viewMode: 1,
    participationMode: 0,
    perStakeMin: 0n,
    perStakeMax: 0n,
    perWalletCumulativeMax: 0n,
    fixedStake: 0n,
    winnersCount: 0,
    clientNonce:
      '0x0000000000000000000000000000000000000000000000000000000000000001',
  };
}

beforeEach(() => {
  mockGetPmTreasuryAddress.mockReset();
  mockGetPmTreasuryAddress.mockResolvedValue(TREASURY);
});

afterEach(() => {
  mockGetPmTreasuryAddress.mockReset();
});

describe('assertSponsoredCallData — PM inner-selector dispatch (slice 1D-3)', () => {
  it('dispatches pm_create_market and accepts a well-formed call', async () => {
    const inner = encodeFunctionData({
      abi: PM_CREATE_MARKET_ABI,
      functionName: 'createMarket',
      args: [validCreateParams()],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero(inner),
      }),
    ).resolves.toBeUndefined();
  });

  it('dispatches pm_bet and accepts a well-formed call', async () => {
    const inner = encodeFunctionData({
      abi: PM_BET_ABI,
      functionName: 'bet',
      args: [MARKET_ID, 1, 50_000n],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero(inner),
      }),
    ).resolves.toBeUndefined();
  });

  it('dispatches pm_stake and accepts a well-formed call', async () => {
    const inner = encodeFunctionData({
      abi: PM_STAKE_ABI,
      functionName: 'stake',
      args: [MARKET_ID, 0n, 50_000n],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero(inner),
      }),
    ).resolves.toBeUndefined();
  });

  it('dispatches pm_claim and accepts a well-formed call', async () => {
    const inner = encodeFunctionData({
      abi: PM_CLAIM_ABI,
      functionName: 'claim',
      args: [MARKET_ID],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero(inner),
      }),
    ).resolves.toBeUndefined();
  });

  it('dispatches pm_resolve and accepts a well-formed call', async () => {
    const inner = encodeFunctionData({
      abi: PM_RESOLVE_ABI,
      functionName: 'resolve',
      args: [MARKET_ID, 1],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero(inner),
      }),
    ).resolves.toBeUndefined();
  });

  it('dispatches pm_confirm and accepts a well-formed call', async () => {
    const inner = encodeFunctionData({
      abi: PM_CONFIRM_ABI,
      functionName: 'confirm',
      args: [MARKET_ID],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero(inner),
      }),
    ).resolves.toBeUndefined();
  });

  it('dispatches pm_distribute and accepts a well-formed call', async () => {
    const inner = encodeFunctionData({
      abi: PM_DISTRIBUTE_ABI,
      functionName: 'distribute',
      args: [MARKET_ID],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero(inner),
      }),
    ).resolves.toBeUndefined();
  });

  it('dispatches pm_cancel and accepts a well-formed call', async () => {
    const inner = encodeFunctionData({
      abi: PM_CANCEL_ABI,
      functionName: 'cancel',
      args: [MARKET_ID],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero(inner),
      }),
    ).resolves.toBeUndefined();
  });

  it('dispatches pm_finalize and accepts a well-formed call', async () => {
    const inner = encodeFunctionData({
      abi: PM_FINALIZE_ABI,
      functionName: 'finalize',
      args: [MARKET_ID],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero(inner),
      }),
    ).resolves.toBeUndefined();
  });

  it('dispatches pm_finalize_metadata and accepts a well-formed call', async () => {
    const inner = encodeFunctionData({
      abi: PM_FINALIZE_METADATA_ABI,
      functionName: 'finalizeMetadata',
      args: [MARKET_ID],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero(inner),
      }),
    ).resolves.toBeUndefined();
  });

  it('dispatches pm_edit_metadata and accepts a well-formed call', async () => {
    const inner = encodeFunctionData({
      abi: PM_EDIT_METADATA_ABI,
      functionName: 'editMetadata',
      args: [MARKET_ID, validCreateParams()],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero(inner),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects an unknown inner selector against PM_CONTRACT_ADDRESS', async () => {
    // 0xdeadbeef + 32-byte uint256 — passes length gate, fails the
    // selector dispatch since no PM_* selector matches.
    const innerData = ('0xdeadbeef' + '00'.repeat(32)) as Hex;
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero(innerData),
      }),
    ).rejects.toBeInstanceOf(NotAllowedError);
  });
});
