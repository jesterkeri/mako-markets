// ----------------------------------------------------------------------------
// src/lib/__tests__/inbox-gap-sponsor-hash-binding.test.ts
//
// Adversary test for INBOX_GAP_PLAN r2 (mako-design, 2026-10-02).
//
// Threat model given for the plan: "A breach of Mako's servers/DB/backups must
// also not let anyone move user funds." The plan's copy (item 6) promises
// "nobody can move your funds without your phone or passkey, including Mako
// Market", and its opening section says a breach of Mako Market "cannot do
// this".
//
// Privy wallet MFA only proves that the person at the keyboard holds the
// factor. It does not tell them WHAT they sign: signSafeOpHash asks the
// embedded wallet for a personal_sign over the 32-byte SafeOp hash that
// /api/aa/sponsor returned. If the browser signs whatever hash the server
// sends, a compromised Mako server answers a bet with the hash of a Safe
// operation that transfers the Safe's USDC to itself, the user passes the MFA
// prompt for what they believe is their bet, and the signature authorizes the
// drain.
//
// Contract under test: the browser signs only a SafeOp hash it recomputed
// itself from the operation it asked for. Both hashes below are built with the
// repo's own encoders (encodeSingleExecuteUserOpCallData, computeSafeOpHash).
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseAbi, toHex, type Address, type Hex } from 'viem';

const mocks = vi.hoisted(() => ({
  signSafeOpHash: vi.fn(),
}));
vi.mock('../embedded-signer', () => ({
  signSafeOpHash: (args: unknown) => mocks.signSafeOpHash(args),
}));

import { runPlaceBet } from '../aa-client';
import { MONAD_TESTNET_ID } from '../chain';
import { deriveSafeAddress } from '../safe';
import { computeSafeOpHash } from '../safe-op-hash';
import { encodeSingleExecuteUserOpCallData } from '../user-op';
import type { PackedUserOpFields } from '../user-op-types';

const MAKO: Address = '0x000000000000000000000000000000000000ca11';
const USDC: Address = '0x000000000000000000000000000000000000c0c0';
const OWNER_EOA: Address = '0x000000000000000000000000000000000000ee0a';
const ATTACKER: Address = '0x000000000000000000000000000000000000bad0';
// The owner's real counterfactual Safe, so a fix that also pins `sender` still passes the control case.
const SAFE: Address = deriveSafeAddress(OWNER_EOA);

const VALID_AFTER = 0n;
const VALID_UNTIL = 0xffffffffffffn;

const ERC20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const PLACEBET = parseAbi(['function placeBet(uint256 marketId, bool isYes, uint256 amount)']);

function packed(callData: Hex): PackedUserOpFields {
  return {
    sender: SAFE,
    nonce: 0n,
    initCode: '0x',
    callData,
    callGasLimit: 100_000n,
    verificationGasLimit: 100_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    paymaster: '0x3333333333333333333333333333333333333333',
    paymasterVerificationGasLimit: 100_000n,
    paymasterPostOpGasLimit: 100_000n,
    paymasterData: '0x',
  };
}

function wire(op: PackedUserOpFields) {
  return {
    sender: op.sender,
    nonce: toHex(op.nonce),
    initCode: op.initCode,
    callData: op.callData,
    callGasLimit: toHex(op.callGasLimit),
    verificationGasLimit: toHex(op.verificationGasLimit),
    preVerificationGas: toHex(op.preVerificationGas),
    maxFeePerGas: toHex(op.maxFeePerGas),
    maxPriorityFeePerGas: toHex(op.maxPriorityFeePerGas),
    paymaster: op.paymaster,
    paymasterVerificationGasLimit: toHex(op.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: toHex(op.paymasterPostOpGasLimit),
    paymasterData: op.paymasterData,
  };
}

const hashOf = (op: PackedUserOpFields) =>
  computeSafeOpHash({ userOp: op, validAfter: VALID_AFTER, validUntil: VALID_UNTIL, chainId: MONAD_TESTNET_ID });

// The operation the user asked for: placeBet(7, yes, 1 USDC) on MAKO.
const BET_CALLDATA = encodeSingleExecuteUserOpCallData({
  to: MAKO,
  value: 0n,
  data: encodeFunctionData({ abi: PLACEBET, functionName: 'placeBet', args: [7n, true, 1_000_000n] }),
});
// The operation a compromised server substitutes: USDC.transfer(attacker, 500 USDC) from the Safe.
const DRAIN_CALLDATA = encodeSingleExecuteUserOpCallData({
  to: USDC,
  value: 0n,
  data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [ATTACKER, 500_000_000n] }),
});

function sponsorResponse(userOp: PackedUserOpFields, safeOpHash: Hex) {
  return {
    pendingUserOpId: '00000000-0000-0000-0000-00000000aaaa',
    userOp: wire(userOp),
    safeOpHash,
    userOpHash: ('0x' + 'bb'.repeat(32)) as Hex,
    validAfter: '0x0',
    validUntil: '0xffffffffffff',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
}

const BET_ARGS = {
  chainId: MONAD_TESTNET_ID,
  marketId: 7n,
  isYes: true,
  amountUsdc: 1_000_000n,
  usdcAddress: USDC,
  makoAddress: MAKO,
  magicEoa: OWNER_EOA,
  currentAllowance: 10n ** 30n, // allowance covers the stake: the client asks for bet_single
};

describe('a compromised sponsor route cannot get a drain signed in place of a bet', () => {
  let sponsorBody: unknown;

  beforeEach(() => {
    mocks.signSafeOpHash.mockReset();
    mocks.signSafeOpHash.mockResolvedValue('0x' + 'dd'.repeat(77));
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === '/api/aa/sponsor') return { ok: true, status: 200, json: async () => sponsorBody } as Response;
      return { ok: true, status: 200, json: async () => ({ status: 'sent', txHash: '0x' + 'cc'.repeat(32) }) } as Response;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to sign when the server returns a transfer operation and its true hash', async () => {
    const drain = packed(DRAIN_CALLDATA);
    sponsorBody = sponsorResponse(drain, hashOf(drain));

    await runPlaceBet(BET_ARGS).catch(() => undefined);

    // The user would be shown an opaque hash and asked for their factor; it must never reach the wallet.
    expect(mocks.signSafeOpHash).not.toHaveBeenCalled();
  });

  it('refuses to sign when the server shows the bet but hands over the hash of a transfer', async () => {
    const bet = packed(BET_CALLDATA);
    const drain = packed(DRAIN_CALLDATA);
    sponsorBody = sponsorResponse(bet, hashOf(drain));

    await runPlaceBet(BET_ARGS).catch(() => undefined);

    expect(mocks.signSafeOpHash).not.toHaveBeenCalled();
  });

  it('control: the honest bet, with its own hash, is still signed', async () => {
    const bet = packed(BET_CALLDATA);
    sponsorBody = sponsorResponse(bet, hashOf(bet));

    await runPlaceBet(BET_ARGS).catch(() => undefined);

    expect(mocks.signSafeOpHash).toHaveBeenCalledTimes(1);
    expect((mocks.signSafeOpHash.mock.calls[0][0] as { hash: Hex }).hash).toBe(hashOf(bet));
  });
});
