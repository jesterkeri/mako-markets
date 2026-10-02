// Adversary pass on Codex S4 r2 (2794f4b): the /profile USDC send from an external browser wallet, rendered as a page.
//
// Spec rule 1: the transfer may only ever be signed by the wallet the user is signed in with (`user.walletAddress` for
// a wallet session; with no session, the wallet that was connected when Review was pressed). A switch at any point
// after Review must never show a transfer to another wallet, and the user is told the send was not sent.
//
// The wallet model follows @wagmi/core 2.22.1 (src/actions/getConnectorClient.ts): a write with no `account` goes to
// the connector's current account; a write naming an account the connector no longer holds throws
// ConnectorAccountNotFoundError before the wallet sees it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const TO = '0xcccccccccccccccccccccccccccccccccccccccc' as const;
const HASH = `0x${'d4'.repeat(32)}` as const;

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  connected: undefined as `0x${string}` | undefined,
  /// The wallet each transfer was actually shown to.
  asked: [] as string[],
  write: vi.fn(),
  receipt: vi.fn(),
  runSendUsdc: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }) }));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: { Custom: () => null } }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: mocks.connected }),
  useBalance: () => ({
    data: { value: 100_000_000n, formatted: '100' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useDisconnect: () => ({ disconnect: vi.fn(), disconnectAsync: vi.fn(async () => {}) }),
  usePublicClient: () => ({ waitForTransactionReceipt: (args: unknown) => mocks.receipt(args) }),
  useWriteContract: () => ({ writeContractAsync: mocks.write }),
}));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: mocks.user, isLoading: false, isError: false, refetch: vi.fn() }),
  USER_QUERY_KEY: ['user'],
}));
vi.mock('@/components/PrivyAuth', () => ({ useEmbeddedActions: () => ({ logout: vi.fn(), exportKey: vi.fn() }) }));
vi.mock('@/lib/aa-client', () => ({ runSendUsdc: mocks.runSendUsdc }));
vi.mock('@/lib/contract', () => ({ MAKO_ADDRESS: '0x1111111111111111111111111111111111111111' }));
vi.mock('@/components/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/MobileChromeHeader', () => ({ MobileChromeHeader: () => null }));
vi.mock('@/components/AvatarCircle', () => ({ AvatarCircle: () => null }));
vi.mock('@/components/WalletDriftBanner', () => ({ WalletDriftBanner: () => <div>drift-banner</div> }));
vi.mock('@/components/profile/IdentityBlock', () => ({ IdentityBlock: () => null }));
vi.mock('@/components/profile/TotpSection', () => ({ TotpSection: () => null }));

import ProfilePage from '@/app/profile/page';

const walletUser = (address: string) => ({
  authed: true,
  authType: 'wallet',
  walletAddress: address,
  displayName: null,
  avatarUrl: null,
  lastSignInAt: null,
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.asked = [];
  mocks.write.mockReset();
  mocks.receipt.mockReset();
  mocks.write.mockImplementation(async (req: { account?: string }) => {
    const now = mocks.connected;
    if (req.account && (!now || req.account.toLowerCase() !== now.toLowerCase())) {
      throw Object.assign(new Error('Account not found for connector.'), { name: 'ConnectorAccountNotFoundError' });
    }
    if (!now) throw Object.assign(new Error('Connector not connected.'), { name: 'ConnectorNotConnectedError' });
    mocks.asked.push((req.account ?? now).toLowerCase());
    return HASH;
  });
  mocks.receipt.mockResolvedValue({ status: 'success' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/// Fill the form while `mocks.connected` is the Review-time wallet and press REVIEW SEND.
function review() {
  fireEvent.change(screen.getByPlaceholderText('0x...'), { target: { value: TO } });
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: 'REVIEW SEND' }));
  expect(screen.getByRole('button', { name: 'SEND NOW' })).toBeTruthy();
}

describe('/profile wallet send: a switch after Review never sends from another wallet', () => {
  it('control: wallet session A, browser wallet switched to B while the confirm modal is open', async () => {
    mocks.user = walletUser(A);
    mocks.connected = A;
    const view = render(<ProfilePage />);
    review();
    mocks.connected = B;
    view.rerender(<ProfilePage />);
    fireEvent.click(screen.getByRole('button', { name: 'SEND NOW' }));
    await waitFor(() => expect(screen.getByText(/Send was not sent/)).toBeTruthy());
    expect(mocks.asked).toEqual([]);
  });

  it('no session: Review with A connected, switch to B while the confirm modal is open, B is never asked', async () => {
    mocks.user = null;
    mocks.connected = A; // the wallet connected when Review is pressed
    const view = render(<ProfilePage />);
    review();
    mocks.connected = B; // the browser wallet switches while CONFIRM SEND is open
    view.rerender(<ProfilePage />);
    fireEvent.click(screen.getByRole('button', { name: 'SEND NOW' }));
    // Let the send run to an outcome either way.
    await waitFor(() =>
      expect(screen.queryByText(/Send was not sent/) ?? screen.queryByText(/SENT|NOT CONFIRMED|SEND FAILED/)).toBeTruthy(),
    );
    // The transfer may only be shown to the wallet that was connected at Review.
    expect(mocks.asked).toEqual([]);
    expect(screen.getByText(/Send was not sent/)).toBeTruthy();
  });
});
