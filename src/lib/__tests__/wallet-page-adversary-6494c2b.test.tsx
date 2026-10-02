// Adversary on 6494c2b (/wallet send, the unresolved-send hold). Spec items quoted per case. Each case fails
// against 6494c2b. Harness copied from wallet-page-adversary-1e0fd99.test.tsx, wallet-account path only: a wallet
// account has no server-side in-flight lock, so the page's hold is the only thing between an unknown outcome and
// a second identical transfer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const TO = '0xcccccccccccccccccccccccccccccccccccccccc' as const;
const OTHER = '0xdddddddddddddddddddddddddddddddddddddddd' as const;
const HASH = `0x${'d4'.repeat(32)}` as const;

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  connected: undefined as `0x${string}` | undefined,
  balance: 200_000_000n as bigint | undefined,
  write: vi.fn(),
  receipt: vi.fn(),
  refetchBalance: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <svg data-qr={value} /> }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: mocks.connected }),
  usePublicClient: () => ({ waitForTransactionReceipt: (args: unknown) => mocks.receipt(args), getCode: async () => (mocks as { code?: string }).code ?? '0x' }),
  useWriteContract: () => ({ writeContractAsync: mocks.write }),
}));
vi.mock('@/lib/hooks', () => ({
  useUsdcBalance: () => ({ data: mocks.balance, isError: false, refetch: mocks.refetchBalance }),
  useEnsureMonadChain: () => async () => {},
}));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: mocks.user, isLoading: false, isError: false, refetch: vi.fn() }),
  accountAddress: (u: { authType: string; safeAddress?: string; walletAddress?: string }) => (u.authType === 'magic' ? u.safeAddress : u.walletAddress),
}));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: ({ children }: { children: React.ReactNode }) => <a href="/signin">{children}</a> }));

import { WalletClient } from '@/app/wallet/WalletClient';

const walletUser = { authed: true, authType: 'wallet', walletAddress: A, displayName: null, avatarUrl: null, lastSignInAt: null };

beforeEach(() => {
  window.localStorage.clear(); // send holds persist per account (src/lib/send-holds.ts)
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.user = walletUser;
  mocks.connected = A;
  mocks.balance = 200_000_000n;
  mocks.write.mockReset();
  mocks.receipt.mockReset();
  mocks.refetchBalance.mockReset();
  mocks.write.mockResolvedValue(HASH);
  // The transfer was broadcast and no receipt came back in time: "Still confirming", an unknown outcome.
  mocks.receipt.mockRejectedValue(Object.assign(new Error('Timed out while waiting for transaction'), { name: 'WaitForTransactionReceiptTimeoutError' }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function review(to: string, amount: string) {
  fireEvent.change(screen.getAllByLabelText('Recipient address')[0]!, { target: { value: to } });
  fireEvent.change(screen.getAllByLabelText('Amount in USDC')[0]!, { target: { value: amount } });
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Review send' })[0]!);
  });
}

async function sendUnknown(to: string, amount: string) {
  await review(to, amount);
  fireEvent.click(screen.getAllByRole('button', { name: 'Send' })[0]!);
  await waitFor(() => expect(screen.getAllByText('Still confirming').length).toBeGreaterThan(0));
  expect(mocks.write).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
}

/// Reviews once and presses Send if the sheet opened. Returns the hold warning shown, if any.
async function reviewAndSendOnce(to: string, amount: string): Promise<string> {
  await review(to, amount);
  const warning = screen.queryAllByRole('alert').map((n) => n.textContent ?? '').join(' ');
  const send = screen.queryAllByRole('button', { name: 'Send' });
  if (send.length > 0) fireEvent.click(send[0]!);
  await new Promise((r) => setTimeout(r, 20));
  return warning;
}

describe('/wallet adversary on 6494c2b', () => {
  // Control (passes on 6494c2b): the harness sees the hold where the hold does work, so the cases below fail for
  // the hold being released, not for the harness missing its warning.
  it('control: closing and reviewing the same send straight away is held with a warning', async () => {
    render(<WalletClient initialTab="send" />);
    await sendUnknown(TO, '150');
    const warning = await reviewAndSendOnce(TO, '150');
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(warning).toMatch(/isn.t confirmed yet/);
  });

  // Spec 3: "After such an unknown outcome, the same send cannot go out again without a deliberate second
  // confirmation." 150 USDC to TO is "Still confirming". The person opens the sheet for a different amount (149,
  // a typo they then cancel), and that review clears the hold for the 150 send without it ever being shown. The
  // 150 send then goes out again on a single Review + Send, no warning.
  it('reviewing a different send, then cancelling it, does not release the hold on the unresolved one', async () => {
    render(<WalletClient initialTab="send" />);
    await sendUnknown(TO, '150');

    await review(TO, '149');
    expect(screen.getAllByRole('button', { name: 'Send' }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!);

    const warning = await reviewAndSendOnce(TO, '150');
    // The second identical transfer was asked of the wallet: the money consequence, checked first.
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(warning).toMatch(/isn.t confirmed yet/);
  });

  // The same, with a different recipient instead of a different amount.
  it('reviewing a send to another address, then cancelling it, does not release the hold either', async () => {
    render(<WalletClient initialTab="send" />);
    await sendUnknown(TO, '150');

    await review(OTHER, '150');
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!);

    const warning = await reviewAndSendOnce(TO, '150');
    // The second identical transfer was asked of the wallet: the money consequence, checked first.
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(warning).toMatch(/isn.t confirmed yet/);
  });

  // Spec 3: same rule. The hold lives only in a React ref, so leaving the page drops it. The unknown-outcome
  // card's own primary action ("Open explorer") is a same-tab link to the explorer (no target), so following the
  // sheet's advice and pressing Back remounts /wallet with no hold. Remount stands in for that reload.
  it('a reload of /wallet (remount) does not release the hold on an unresolved send', async () => {
    const first = render(<WalletClient initialTab="send" />);
    await sendUnknown(TO, '150');
    first.unmount();

    render(<WalletClient initialTab="send" />);
    const warning = await reviewAndSendOnce(TO, '150');
    // The second identical transfer was asked of the wallet: the money consequence, checked first.
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(warning).toMatch(/isn.t confirmed yet/);
  });
});
