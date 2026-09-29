// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-client-pm-actions.test.ts
//
// Phase 2E-1 slice 1D-4: smoke tests for the 10 PM action orchestrators
// in aa-client.ts. Each orchestrator's job is:
//
//   1. Encode the inner call via viem encodeFunctionData + the
//      corresponding PM_*_ABI fragment.
//   2. Build a SponsorRequestBody with the right `kind` literal.
//   3. Delegate to runSponsoredCallOp (shared mechanics tested via
//      runClaim's coverage in aa-client tests).
//
// We mock `fetch` to capture the POST body sent to /api/aa/sponsor
// and assert (a) the `kind` discriminator matches the orchestrator,
// (b) `call.to` is the PM address, (c) `call.data` decodes back to
// the args the caller passed. (c) is the load-bearing assertion —
// it catches an ABI fragment swap or an arg-order regression that
// type checks alone wouldn't.
//
// Since the orchestrators short-circuit on the first non-ok response,
// the mock returns a 400 sponsor_failed response. We don't exercise
// the sign-or-send path here; that's tested separately in the
// runClaim coverage (which the shared helper inherits from).
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, type Address, type Hex } from 'viem';

import {
  PM_BET_ABI,
  PM_CANCEL_ABI,
  PM_CLAIM_ABI,
  PM_CONFIRM_ABI,
  PM_DISTRIBUTE_ABI,
  PM_EDIT_METADATA_ABI,
  PM_FINALIZE_ABI,
  PM_FINALIZE_METADATA_ABI,
  PM_RESOLVE_ABI,
  PM_STAKE_ABI,
  type PmCreateParamsTuple,
} from '../private-markets/abi-fragments';
import {
  runPmBet,
  runPmCancel,
  runPmClaim,
  runPmConfirm,
  runPmDistribute,
  runPmEditMetadata,
  runPmFinalize,
  runPmFinalizeMetadata,
  runPmResolve,
  runPmStake,
} from '../aa-client';

const PM_ADDRESS: Address = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const USDC_ADDR: Address = '0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
const MAGIC_EOA: Address = '0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const CHAIN_ID = 10143;
const MARKET_ID = 17n;
/// High allowance (max-uint256) so runPmBet / runPmStake takes the
/// single-call branch in the default tests — they were written before
/// Codex r1 MAJ-1 surfaced the batched path requirement. Dedicated
/// batched-path tests live below.
const ALLOWANCE_HIGH = (1n << 255n);

interface CapturedRequest {
  kind: string;
  chainId: number;
  call: { to: Address; value: Hex; data: Hex };
}

let captured: CapturedRequest | null = null;

// signSafeOpHash never runs because we 400 on the sponsor call. Mock
// it anyway in case a regression makes the helper reach the sign step.
vi.mock('../embedded-signer', () => ({
  signSafeOpHash: vi.fn(async () => '0x' + '00'.repeat(77)),
}));

beforeEach(() => {
  captured = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (init?.body && typeof init.body === 'string') {
        const parsed = JSON.parse(init.body);
        if (path.includes('/api/aa/sponsor')) {
          captured = parsed as CapturedRequest;
        }
      }
      // Always reject sponsor with a 400 so the helper short-circuits to
      // a sponsor_failed RunOutcome without trying to sign/send.
      return new Response(JSON.stringify({ error: 'NOT_ALLOWED' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  captured = null;
});

function decodeCallData<T extends readonly unknown[]>(
  abi: unknown,
  data: Hex,
): T {
  const result = decodeFunctionData({ abi: abi as never, data });
  return result.args as unknown as T;
}

describe('PM action orchestrators — request body shape (slice 1D-4)', () => {
  it('runPmBet encodes bet(marketId, side, amount) and tags kind=pm_bet', async () => {
    await runPmBet({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      usdcAddress: USDC_ADDR,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
      side: 1,
      amount: 50_000n,
      currentAllowance: ALLOWANCE_HIGH,
    });
    expect(captured).not.toBeNull();
    expect(captured!.kind).toBe('pm_bet');
    expect(captured!.call.to.toLowerCase()).toBe(PM_ADDRESS.toLowerCase());
    expect(captured!.call.value).toBe('0x0');
    const [id, side, amount] = decodeCallData<readonly [bigint, number, bigint]>(
      PM_BET_ABI,
      captured!.call.data,
    );
    expect(id).toBe(MARKET_ID);
    expect(side).toBe(1);
    expect(amount).toBe(50_000n);
  });

  it('runPmStake encodes stake(marketId, optionIndex, amount) and tags kind=pm_stake', async () => {
    await runPmStake({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      usdcAddress: USDC_ADDR,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
      optionIndex: 3n,
      amount: 100_000n,
      currentAllowance: ALLOWANCE_HIGH,
    });
    expect(captured!.kind).toBe('pm_stake');
    const [id, optionIndex, amount] = decodeCallData<
      readonly [bigint, bigint, bigint]
    >(PM_STAKE_ABI, captured!.call.data);
    expect(id).toBe(MARKET_ID);
    expect(optionIndex).toBe(3n);
    expect(amount).toBe(100_000n);
  });

  it('runPmClaim encodes claim(marketId) and tags kind=pm_claim', async () => {
    await runPmClaim({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
    });
    expect(captured!.kind).toBe('pm_claim');
    const [id] = decodeCallData<readonly [bigint]>(
      PM_CLAIM_ABI,
      captured!.call.data,
    );
    expect(id).toBe(MARKET_ID);
  });

  it('runPmResolve encodes resolve(marketId, outcome) and tags kind=pm_resolve', async () => {
    await runPmResolve({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
      outcome: 1,
    });
    expect(captured!.kind).toBe('pm_resolve');
    const [id, outcome] = decodeCallData<readonly [bigint, number]>(
      PM_RESOLVE_ABI,
      captured!.call.data,
    );
    expect(id).toBe(MARKET_ID);
    expect(outcome).toBe(1);
  });

  it('runPmConfirm encodes confirm(marketId) and tags kind=pm_confirm', async () => {
    await runPmConfirm({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
    });
    expect(captured!.kind).toBe('pm_confirm');
    const [id] = decodeCallData<readonly [bigint]>(
      PM_CONFIRM_ABI,
      captured!.call.data,
    );
    expect(id).toBe(MARKET_ID);
  });

  it('runPmDistribute encodes distribute(marketId) and tags kind=pm_distribute', async () => {
    await runPmDistribute({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
    });
    expect(captured!.kind).toBe('pm_distribute');
    const [id] = decodeCallData<readonly [bigint]>(
      PM_DISTRIBUTE_ABI,
      captured!.call.data,
    );
    expect(id).toBe(MARKET_ID);
  });

  it('runPmCancel encodes cancel(marketId) and tags kind=pm_cancel', async () => {
    await runPmCancel({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
    });
    expect(captured!.kind).toBe('pm_cancel');
    const [id] = decodeCallData<readonly [bigint]>(
      PM_CANCEL_ABI,
      captured!.call.data,
    );
    expect(id).toBe(MARKET_ID);
  });

  it('runPmFinalize encodes finalize(marketId) and tags kind=pm_finalize', async () => {
    await runPmFinalize({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
    });
    expect(captured!.kind).toBe('pm_finalize');
    const [id] = decodeCallData<readonly [bigint]>(
      PM_FINALIZE_ABI,
      captured!.call.data,
    );
    expect(id).toBe(MARKET_ID);
  });

  it('runPmFinalizeMetadata encodes finalizeMetadata(marketId) and tags kind=pm_finalize_metadata', async () => {
    await runPmFinalizeMetadata({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
    });
    expect(captured!.kind).toBe('pm_finalize_metadata');
    const [id] = decodeCallData<readonly [bigint]>(
      PM_FINALIZE_METADATA_ABI,
      captured!.call.data,
    );
    expect(id).toBe(MARKET_ID);
  });

  it('runPmEditMetadata encodes editMetadata(marketId, p) and tags kind=pm_edit_metadata', async () => {
    const params: PmCreateParamsTuple = {
      shape: 0,
      stakingOpensAt: 1_700_000_400n,
      closeAt: 1_700_000_600n,
      title: ('0x' + Buffer.from('edit').toString('hex')) as `0x${string}`,
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
    await runPmEditMetadata({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
      params,
    });
    expect(captured!.kind).toBe('pm_edit_metadata');
    const [id, decodedParams] = decodeCallData<
      readonly [bigint, PmCreateParamsTuple]
    >(PM_EDIT_METADATA_ABI, captured!.call.data);
    expect(id).toBe(MARKET_ID);
    expect(decodedParams.shape).toBe(0);
    expect(decodedParams.stakingOpensAt).toBe(1_700_000_400n);
    expect(decodedParams.closeAt).toBe(1_700_000_600n);
  });
});

// ── Codex r1 MAJ-1: allowance-branching orchestrator paths ─────────────────

interface CapturedBatched {
  kind: string;
  chainId: number;
  calls: readonly [
    { to: Address; value: Hex; data: Hex },
    { to: Address; value: Hex; data: Hex },
  ];
}

describe('PM bet/stake orchestrators — allowance branching', () => {
  it('runPmBet with currentAllowance >= amount sends kind=pm_bet (single-call)', async () => {
    await runPmBet({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      usdcAddress: USDC_ADDR,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
      side: 1,
      amount: 50_000n,
      currentAllowance: 50_000n, // exact match — must NOT batch
    });
    expect(captured!.kind).toBe('pm_bet');
  });

  it('runPmBet with currentAllowance < amount sends kind=pm_bet_batched', async () => {
    await runPmBet({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      usdcAddress: USDC_ADDR,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
      side: 1,
      amount: 50_000n,
      currentAllowance: 49_999n, // 1 base unit short — must batch
    });
    const batched = captured as unknown as CapturedBatched;
    expect(batched.kind).toBe('pm_bet_batched');
    // tuple[0] = approve(USDC → PM, MaxUint256)
    expect(batched.calls[0].to.toLowerCase()).toBe(USDC_ADDR.toLowerCase());
    // tuple[1] = bet(...)
    expect(batched.calls[1].to.toLowerCase()).toBe(PM_ADDRESS.toLowerCase());
    const [id, side, amount] = decodeCallData<
      readonly [bigint, number, bigint]
    >(
      // re-decode tuple[1] data with PM_BET_ABI
      [
        {
          type: 'function',
          name: 'bet',
          inputs: [
            { name: 'marketId', type: 'uint256' },
            { name: 'side', type: 'uint8' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [],
          stateMutability: 'nonpayable',
        },
      ],
      batched.calls[1].data,
    );
    expect(id).toBe(MARKET_ID);
    expect(side).toBe(1);
    expect(amount).toBe(50_000n);
  });

  it('runPmStake with currentAllowance >= amount sends kind=pm_stake', async () => {
    await runPmStake({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      usdcAddress: USDC_ADDR,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
      optionIndex: 0n,
      amount: 50_000n,
      currentAllowance: 100_000n,
    });
    expect(captured!.kind).toBe('pm_stake');
  });

  it('runPmStake with currentAllowance=0n sends kind=pm_stake_batched', async () => {
    await runPmStake({
      chainId: CHAIN_ID,
      pmAddress: PM_ADDRESS,
      usdcAddress: USDC_ADDR,
      magicEoa: MAGIC_EOA,
      marketId: MARKET_ID,
      optionIndex: 0n,
      amount: 50_000n,
      currentAllowance: 0n,
    });
    expect(captured!.kind).toBe('pm_stake_batched');
  });
});
