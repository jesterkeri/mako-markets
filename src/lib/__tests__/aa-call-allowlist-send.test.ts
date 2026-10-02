// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-call-allowlist-send.test.ts
//
// Phase 1E /profile send-USDC allowlist test matrix. Two describe blocks:
//
//   describe('assertSendUsdcCall', ...)
//     Sponsor-time, single USDC.transfer(arbitraryRecipient, amount) call.
//     Validates target=USDC, value=0n, decode succeeds, recipient is not
//     self/USDC/MAKO, amount > 0n, amount <= per-op cap.
//
//   describe('assertSponsoredCallData (extended for send_usdc)', ...)
//     Send-time, decodes the persisted wrapper. Wrapper is op=0
//     (single-call) with to=USDC. Dispatch on `recipient === safeAddress`:
//     self → smoke flow (covered in aa-call-allowlist.test.ts), non-self
//     → send_usdc flow (covered here).
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';

import {
  assertSendUsdcCall,
  assertSponsoredCallData,
  NotAllowedError,
} from '../aa-call-allowlist';
import { SEND_USDC_MAX_PER_OP_BASE_UNITS } from '../aa-constants';
import { MAKO_ADDRESS, PM_CONTRACT_ADDRESS } from '../contract';
import { MONAD_TESTNET_ID } from '../chain';
import { USDC_ADDRESS } from '../usdc';

const SAFE: Address = '0x1111111111111111111111111111111111111111';
const RECIPIENT: Address = '0x2222222222222222222222222222222222222222';
const ANOTHER: Address = '0x3333333333333333333333333333333333333333';

const TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

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

function encodeTransfer(to: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: TRANSFER_ABI,
    functionName: 'transfer',
    args: [to, amount],
  });
}

function wrapOpZero(args: { to: Address; value: bigint; data: Hex }): Hex {
  return encodeFunctionData({
    abi: SAFE_WRAPPER_ABI,
    functionName: 'executeUserOp',
    args: [args.to, args.value, args.data, 0],
  });
}

describe('assertSendUsdcCall', () => {
  it('accepts a valid send to a non-self, non-protocol recipient', () => {
    expect(() =>
      assertSendUsdcCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: USDC_ADDRESS,
          value: 0n,
          data: encodeTransfer(RECIPIENT, 1_000_000n), // 1 USDC
        },
      }),
    ).not.toThrow();
  });

  it('accepts a send at exactly the per-op cap', () => {
    expect(() =>
      assertSendUsdcCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: USDC_ADDRESS,
          value: 0n,
          data: encodeTransfer(RECIPIENT, SEND_USDC_MAX_PER_OP_BASE_UNITS),
        },
      }),
    ).not.toThrow();
  });

  it('rejects unsupported chainId with bad_send_args', () => {
    try {
      assertSendUsdcCall({
        chainId: 1, // mainnet
        safeAddress: SAFE,
        call: {
          to: USDC_ADDRESS,
          value: 0n,
          data: encodeTransfer(RECIPIENT, 1_000_000n),
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_send_args');
    }
  });

  it('rejects target ≠ USDC with bad_send_args', () => {
    try {
      assertSendUsdcCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: ANOTHER, // wrong target
          value: 0n,
          data: encodeTransfer(RECIPIENT, 1_000_000n),
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_send_args');
    }
  });

  it('rejects nonzero outer value with bad_value', () => {
    try {
      assertSendUsdcCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: USDC_ADDRESS,
          value: 1n, // nonzero
          data: encodeTransfer(RECIPIENT, 1_000_000n),
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_value');
    }
  });

  it('rejects malformed selector with bad_send_args', () => {
    try {
      assertSendUsdcCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: USDC_ADDRESS,
          value: 0n,
          data: '0xdeadbeef' as Hex, // not transfer
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_send_args');
    }
  });

  it('rejects send to self with bad_send_recipient', () => {
    try {
      assertSendUsdcCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: USDC_ADDRESS,
          value: 0n,
          data: encodeTransfer(SAFE, 1_000_000n),
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_send_recipient');
    }
  });

  it('rejects send to USDC contract with bad_send_recipient', () => {
    try {
      assertSendUsdcCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: USDC_ADDRESS,
          value: 0n,
          data: encodeTransfer(USDC_ADDRESS, 1_000_000n),
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_send_recipient');
    }
  });

  it('rejects send to MAKO contract with bad_send_recipient', () => {
    try {
      assertSendUsdcCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: USDC_ADDRESS,
          value: 0n,
          data: encodeTransfer(MAKO_ADDRESS, 1_000_000n),
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_send_recipient');
    }
  });

  it('rejects amount === 0n with bad_send_amount', () => {
    try {
      assertSendUsdcCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: USDC_ADDRESS,
          value: 0n,
          data: encodeTransfer(RECIPIENT, 0n),
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_send_amount');
    }
  });

  it('rejects amount above per-op cap with bad_send_amount', () => {
    try {
      assertSendUsdcCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: USDC_ADDRESS,
          value: 0n,
          data: encodeTransfer(
            RECIPIENT,
            SEND_USDC_MAX_PER_OP_BASE_UNITS + 1n,
          ),
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_send_amount');
    }
  });

  it('case-insensitive recipient comparison rejects mixed-case self-address', () => {
    // Address-equality comparisons MUST be lowercased before strcmp.
    // A user pasting their Safe address with mixed case must still
    // hit the self-recipient guard.
    const SAFE_MIXED: Address =
      ('0x' +
        SAFE.slice(2)
          .split('')
          .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
          .join('')) as Address;
    try {
      assertSendUsdcCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: USDC_ADDRESS,
          value: 0n,
          data: encodeTransfer(SAFE_MIXED, 1_000_000n),
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_send_recipient');
    }
  });
});

describe('assertSponsoredCallData (extended for send_usdc)', () => {
  it('accepts op=0 wrapper with USDC.transfer to non-self recipient', async () => {
    const wrapped = wrapOpZero({
      to: USDC_ADDRESS,
      value: 0n,
      data: encodeTransfer(RECIPIENT, 5_000_000n), // 5 USDC
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects op=0 wrapper with send to USDC contract (bad_send_recipient)', async () => {
    const wrapped = wrapOpZero({
      to: USDC_ADDRESS,
      value: 0n,
      data: encodeTransfer(USDC_ADDRESS, 1_000_000n),
    });
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_send_recipient');
    }
  });

  it('rejects op=0 wrapper with send to MAKO contract (bad_send_recipient)', async () => {
    const wrapped = wrapOpZero({
      to: USDC_ADDRESS,
      value: 0n,
      data: encodeTransfer(MAKO_ADDRESS, 1_000_000n),
    });
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_send_recipient');
    }
  });

  it('rejects op=0 wrapper with send above per-op cap (bad_send_amount)', async () => {
    const wrapped = wrapOpZero({
      to: USDC_ADDRESS,
      value: 0n,
      data: encodeTransfer(
        RECIPIENT,
        SEND_USDC_MAX_PER_OP_BASE_UNITS + 1n,
      ),
    });
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_send_amount');
    }
  });

  it('dispatches USDC.transfer-to-self to the smoke validator (covered separately)', async () => {
    // Send-side dispatch: when the inner transfer recipient === safeAddress,
    // the validator routes to assertSponsorableCall (smoke flow). This test
    // uses amount=2n which the smoke validator REJECTS (smoke allows only
    // 0n|1n) — proving dispatch reaches the smoke validator instead of
    // being silently accepted as a send_usdc call.
    const wrapped = wrapOpZero({
      to: USDC_ADDRESS,
      value: 0n,
      data: encodeTransfer(SAFE, 2n),
    });
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_amount');
    }
  });

  it('dispatches USDC.transfer-to-self with amount=1n to the smoke validator (accepted)', async () => {
    // Symmetric of the above: smoke flow's allowed amount (1n) to self
    // must still be accepted after the send_usdc extension. Pins the
    // dispatch logic so a future refactor can't break smoke flow.
    const wrapped = wrapOpZero({
      to: USDC_ADDRESS,
      value: 0n,
      data: encodeTransfer(SAFE, 1n),
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      }),
    ).resolves.toBeUndefined();
  });
});

// Codex batch r1 F1: the server refuses every protocol address the /wallet form refuses (one shared list,
// src/lib/protocol-recipients.ts), at sponsor time and at send time. Any other contract is allowed by policy, since
// every Mako Market email account is itself a contract; the form asks for an acknowledgement instead.
describe('send_usdc recipients: the shared protocol list', () => {
  const sponsorReason = (recipient: Address) => {
    try {
      assertSendUsdcCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: USDC_ADDRESS, value: 0n, data: encodeTransfer(recipient, 1_000_000n) },
      });
      return 'allowed';
    } catch (e) {
      return (e as NotAllowedError).reason;
    }
  };
  const sendReason = async (recipient: Address) => {
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero({ to: USDC_ADDRESS, value: 0n, data: encodeTransfer(recipient, 1_000_000n) }),
      });
      return 'allowed';
    } catch (e) {
      return (e as NotAllowedError).reason;
    }
  };

  it('refuses the Private Markets contract at sponsor time and at send time', async () => {
    expect(sponsorReason(PM_CONTRACT_ADDRESS)).toBe('bad_send_recipient');
    expect(await sendReason(PM_CONTRACT_ADDRESS)).toBe('bad_send_recipient');
  });

  it('allows a recipient that is not on the protocol list, contract or not, at both points', async () => {
    const otherContract: Address = '0x4444444444444444444444444444444444444444';
    expect(sponsorReason(otherContract)).toBe('allowed');
    expect(await sendReason(otherContract)).toBe('allowed');
  });

  it('refuses a protocol address lowercase or checksummed', async () => {
    expect(sponsorReason(PM_CONTRACT_ADDRESS.toLowerCase() as Address)).toBe('bad_send_recipient');
    expect(sponsorReason(getAddress(PM_CONTRACT_ADDRESS))).toBe('bad_send_recipient');
  });
});
