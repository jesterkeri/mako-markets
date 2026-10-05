// The browser's signing check (src/lib/op-binding.ts, INBOX_GAP_PLAN r10 item 6), on real Safe operations built
// with the same encoders and hash the sponsor uses: an honest operation passes, and each thing a taken-over server
// could change is refused with its own reason, before anything is signed.

import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, maxUint256, toHex, type Address, type Hex } from 'viem';

import { MONAD_TESTNET_ID } from '../chain';
import { assertSignableOp, OpBindingError, type ExpectedOp, type SponsoredForSigning } from '../op-binding';
import { deriveSafeAddress } from '../safe';
import { buildSafeProxyInitCode } from '../safe-init';
import { computeSafeOpHash } from '../safe-op-hash';
import { wrapperCallDataFor } from '../user-op-encode';
import { storedToPacked, type StoredSplitFormUserOp } from '../user-op-types';

const OWNER: Address = '0x1111111111111111111111111111111111111111';
const OTHER_OWNER: Address = '0x2222222222222222222222222222222222222222';
const USDC: Address = '0x534b2f3A21130d7a60830c2Df862319e593943A3';
const POOL: Address = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';
const ATTACKER: Address = '0x6666666666666666666666666666666666666666';
const PAYMASTER: Address = '0x777777777777AeC03fd955926DbF81597e66834C';
const MAX_UINT48 = (1n << 48n) - 1n;

const transfer = (to: Address, amount: bigint) => ({ to: USDC, value: '0x0' as Hex, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }) });
const approve = (spender: Address, amount: bigint) => ({ to: USDC, value: '0x0' as Hex, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) });
const big = (c: { to: Address; value: Hex; data: Hex }) => ({ to: c.to, value: BigInt(c.value), data: c.data });

function opFor(expected: ExpectedOp, over: Partial<StoredSplitFormUserOp> = {}, window: { validAfter?: bigint; validUntil?: bigint } = {}): SponsoredForSigning {
  const callData = expected.call ? wrapperCallDataFor({ call: big(expected.call) }) : wrapperCallDataFor({ calls: [big(expected.calls[0]), big(expected.calls[1])] });
  const userOp: StoredSplitFormUserOp = {
    sender: deriveSafeAddress(OWNER),
    nonce: '0x3',
    initCode: '0x',
    callData,
    callGasLimit: toHex(200_000n),
    verificationGasLimit: toHex(300_000n),
    preVerificationGas: toHex(60_000n),
    maxFeePerGas: toHex(100_000_000_000n),
    maxPriorityFeePerGas: toHex(2_000_000_000n),
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: toHex(50_000n),
    paymasterPostOpGasLimit: toHex(1n),
    paymasterData: '0xabcdef',
    ...over,
  };
  const validAfter = window.validAfter ?? 0n;
  const validUntil = window.validUntil ?? MAX_UINT48;
  const safeOpHash = computeSafeOpHash({ userOp: storedToPacked(userOp), validAfter, validUntil, chainId: MONAD_TESTNET_ID });
  return { userOp, safeOpHash, validAfter: toHex(validAfter), validUntil: toHex(validUntil) };
}

const reason = (f: () => void) => {
  try {
    f();
    return 'signed';
  } catch (e) {
    if (e instanceof OpBindingError) return e.reason;
    throw e;
  }
};

const SEND: ExpectedOp = { call: transfer(OTHER_OWNER, 5_000_000n) };
const BATCH: ExpectedOp = { calls: [approve(POOL, 5_000_000n), { to: POOL, value: '0x0', data: '0x12345678' }] };

describe('assertSignableOp', () => {
  it('an honest single-call operation passes', () => {
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: opFor(SEND) }))).toBe('signed');
  });

  it('an honest batched operation passes, and the first-operation setup code for this owner is accepted', () => {
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: BATCH, sponsored: opFor(BATCH) }))).toBe('signed');
    const firstOp = opFor(SEND, { initCode: buildSafeProxyInitCode(OWNER).initCode });
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: firstOp }))).toBe('signed');
  });

  it('a different call with its own true hash is refused (a transfer in place of what was asked)', () => {
    const drain = opFor({ call: transfer(ATTACKER, 1_000_000_000n) });
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: drain }))).toBe('call_data');
  });

  it('a batch in the wrong order, or with an unlimited approval, is refused', () => {
    const swapped = opFor({ calls: [BATCH.calls![1], BATCH.calls![0]] });
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: BATCH, sponsored: swapped }))).toBe('call_data');
    const unlimited = opFor({ calls: [approve(POOL, maxUint256), BATCH.calls![1]] });
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: BATCH, sponsored: unlimited }))).toBe('call_data');
  });

  it('another Safe is refused, the sender is derived from the owner, never trusted', () => {
    const other = opFor(SEND, { sender: deriveSafeAddress(OTHER_OWNER) });
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: other }))).toBe('sender');
  });

  it('setup code for anyone else is refused', () => {
    const foreign = opFor(SEND, { initCode: buildSafeProxyInitCode(OTHER_OWNER).initCode });
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: foreign }))).toBe('init_code');
  });

  it('no paymaster is refused: the Safe would pay its own gas', () => {
    const unpaid = opFor(SEND, { paymaster: '0x0000000000000000000000000000000000000000', paymasterData: '0x', paymasterVerificationGasLimit: '0x0', paymasterPostOpGasLimit: '0x0' });
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: unpaid }))).toBe('paymaster');
  });

  it('a nonce key other than 0 is refused', () => {
    const keyed = opFor(SEND, { nonce: toHex((1n << 64n) + 3n) });
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: keyed }))).toBe('nonce_key');
  });

  it("a hash that is not this operation's is refused (the bet shown, a transfer's hash handed over)", () => {
    const shown = opFor(SEND);
    const swappedHash = { ...shown, safeOpHash: opFor({ call: transfer(ATTACKER, 1n) }).safeOpHash };
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: swappedHash }))).toBe('hash');
  });

  it('a validity window that does not match the hash is refused', () => {
    const op = opFor(SEND, {}, { validUntil: 1_900_000_000n });
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: { ...op, validUntil: toHex(MAX_UINT48) } }))).toBe('hash');
  });

  it("the chain is the page's own: a hash computed for another chain is refused", () => {
    const op = opFor(SEND);
    const otherChain = computeSafeOpHash({ userOp: storedToPacked(op.userOp), validAfter: 0n, validUntil: MAX_UINT48, chainId: 1 });
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: { ...op, safeOpHash: otherChain } }))).toBe('hash');
  });

  it('malformed numbers are refused, not thrown as something else', () => {
    const op = opFor(SEND);
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: { ...op, userOp: { ...op.userOp, nonce: 'zz' as Hex } } }))).toBe('malformed');
    expect(reason(() => assertSignableOp({ owner: OWNER, expected: SEND, sponsored: { ...op, validAfter: 'later' as Hex } }))).toBe('malformed');
  });
});
