// Adversary on 91fe6ae (one recipient list, src/lib/protocol-recipients.ts). Spec item 2: "Never to: ... the Rounds
// contract once its address is configured." Rounds' address is configured in the reviewed release record
// (src/lib/rounds-release-record.ts: "Rounds is live only for the deployment written here"). This case supplies a
// record and leaves NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS unset, the state of any environment where the variable was not
// added (or was mistyped) when the record landed. Fails against 91fe6ae.

import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, type Address } from 'viem';

const ROUNDS = '0x5555555555555555555555555555555555555555' as const;
const SAFE = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe' as const;

vi.mock('@/lib/rounds-release-record', async () => {
  const { USDC_ADDRESS } = await import('@/lib/usdc');
  return { ROUNDS_RELEASE_RECORD: { address: '0x5555555555555555555555555555555555555555', runtimeCodeHash: `0x${'11'.repeat(32)}`, usdc: USDC_ADDRESS } };
});

import { assertSendUsdcCall, NotAllowedError } from '../aa-call-allowlist';
import { MONAD_TESTNET_ID } from '../chain';
import { isProtocolRecipient } from '../protocol-recipients';
import { USDC_ADDRESS } from '../usdc';

const TRANSFER_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

function sponsorReason(recipient: Address): string {
  try {
    assertSendUsdcCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: { to: USDC_ADDRESS, value: 0n, data: encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [recipient, 1_000_000n] }) },
    });
    return 'allowed';
  } catch (e) {
    return (e as NotAllowedError).reason;
  }
}

describe('protocol recipients: the reviewed Rounds contract', () => {
  it('refuses the Rounds contract from the release record when the environment variable is not set', () => {
    expect(process.env.NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS ?? '').toBe('');
    expect(isProtocolRecipient(ROUNDS)).toBe(true);
    expect(sponsorReason(ROUNDS)).toBe('bad_send_recipient');
  });
});
