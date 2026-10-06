// The one list of addresses a USDC send may never reach (src/lib/protocol-recipients.ts), shared by the gas
// sponsor and the /wallet form. Rounds joins it as soon as its address is configured.

import { describe, expect, it, vi } from 'vitest';

const ROUNDS = '0x5555555555555555555555555555555555555555';

vi.mock('../contract', () => ({
  MAKO_ADDRESS: '0x000000000000000000000000000000000000abcd',
  PM_CONTRACT_ADDRESS: '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f',
  ROUNDS_ADDRESS: '0x5555555555555555555555555555555555555555',
}));
vi.mock('../usdc', () => ({ USDC_ADDRESS: ' 0x000000000000000000000000000000000000DCBA\n' }));
// The release record's own address is covered in protocol-recipients-adversary-91fe6ae.test.ts; here it is empty so
// this list is exactly the configured addresses.
vi.mock('../rounds-release-record', () => ({ ROUNDS_RELEASE_RECORD: null }));

import { isProtocolRecipient, protocolRecipients } from '../protocol-recipients';

describe('protocol recipients', () => {
  it('lists USDC, Pools, Private Markets and Rounds, trimmed and lowercased', () => {
    expect(protocolRecipients()).toEqual([
      '0x000000000000000000000000000000000000dcba',
      '0x000000000000000000000000000000000000abcd',
      '0xc9c6575a14d0e84afd5ab21c506916fd2864bb8f',
      ROUNDS,
    ]);
  });

  it('refuses the configured Rounds contract', () => {
    expect(isProtocolRecipient(ROUNDS)).toBe(true);
  });

  it('matches whatever the letter case or surrounding space', () => {
    expect(isProtocolRecipient(' 0x000000000000000000000000000000000000ABCD ')).toBe(true);
    expect(isProtocolRecipient('0x4444444444444444444444444444444444444444')).toBe(false);
  });
});
