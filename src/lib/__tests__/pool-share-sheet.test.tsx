// Share (15a) for a pool: the invite card, its targets, Copy link, the Save image slot, and closing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QRCodeSVG } from 'qrcode.react';
import * as React from 'react';

import { PoolShareSheet } from '@/components/PoolShareSheet';
import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { intentUrl, poolInviteLink } from '@/lib/pool-invite';
import { formatPays, poolRow } from '@/lib/pool-list';

const USDC = 1_000_000n;
const NOW = 1_800_000_000;
const LABELS = { yes: 'YES', no: 'NO' };

const OPEN: MarketWithId = {
  id: 88n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: `0x${'00'.repeat(32)}`,
  question: 'Will BTC close above $80,000 in 1 day?',
  createdAt: BigInt(NOW - 3_600),
  bettingCloseTime: BigInt(NOW + 6 * 3_600 + 11 * 60),
  closeTime: BigInt(NOW + 8 * 3_600),
  totalYes: 30n * USDC,
  totalNo: 10n * USDC,
  yesBettorCount: 2,
  noBettorCount: 1,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};
const SETTLED: MarketWithId = { ...OPEN, bettingCloseTime: BigInt(NOW - 7_200), closeTime: BigInt(NOW - 3_600), resolved: true, outcome: Outcome.YES };

function mount(market: MarketWithId = OPEN) {
  const onClose = vi.fn();
  render(<PoolShareSheet market={market} now={NOW} labels={LABELS} by="0xC8BF…90F1" onClose={onClose} />);
  return onClose;
}

function setClipboard(writeText: (s: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}
function setShare(share: ((d: ShareData) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
}

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  setShare(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the invite card', () => {
  it('quotes the same multipliers as the pool page helper, with the amount and bettors per side', () => {
    mount();
    const row = poolRow(OPEN, NOW);
    // Both layouts render (CSS shows one), so each figure appears once per layout.
    expect(screen.getAllByText(formatPays(row.yesPays))).toHaveLength(2);
    expect(screen.getAllByText(formatPays(row.noPays))).toHaveLength(2);
    expect(screen.getAllByText('1.29x')).toHaveLength(2);
    expect(screen.getAllByText('3.88x')).toHaveLength(2);
    expect(screen.getAllByText('30.00 · 2 in')).toHaveLength(2);
    expect(screen.getAllByText('10.00 · 1 in')).toHaveLength(2);
  });

  it('names the category and the creator label it is given, and the question', () => {
    mount();
    expect(screen.getAllByText('CRYPTO · HOSTED BY 0xC8BF…90F1')).toHaveLength(2);
    expect(screen.getAllByText('Will BTC close above $80,000 in 1 day?')).toHaveLength(2);
  });

  it('while open, asks for a bet and says Scan to join', () => {
    mount(OPEN);
    expect(screen.getAllByText('OPEN')).toHaveLength(2);
    expect(screen.getAllByText('Scan to join')).toHaveLength(2);
    expect(screen.getAllByText('Bet YES or NO · settled by Mako Market')).toHaveLength(2);
    expect(screen.getAllByText('Min 0.10 USDC · gas-free with email')).toHaveLength(2);
  });

  it('once the pool is settled, shows its state instead of a call to bet', () => {
    mount(SETTLED);
    expect(screen.getAllByText('YES WON')).toHaveLength(2);
    expect(screen.getAllByText('Scan to view')).toHaveLength(2);
    expect(screen.queryByText('Scan to join')).toBeNull();
    expect(screen.queryByText(/Bet YES or NO/)).toBeNull();
    expect(screen.queryByText(/Min 0\.10 USDC/)).toBeNull();
    expect(screen.queryByText('OPEN')).toBeNull();
  });

  it('draws a QR of the link', () => {
    mount();
    const qrs = screen.getAllByRole('img', { name: 'QR code for makomarket.xyz/pools/88?utm_source=link&utm_campaign=pool-88' });
    expect(qrs).toHaveLength(2);
    expect(qrs[0].tagName.toLowerCase()).toBe('svg');
    // Same modules as a reference QR of the link: the code encodes the link, not just its label.
    const ref = render(<QRCodeSVG value={poolInviteLink(88n, 'link')} size={72} level="M" />);
    const modules = (svg: Element) => [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('|');
    const refModules = modules(ref.container.querySelector('svg')!);
    expect(refModules.length).toBeGreaterThan(100);
    for (const q of qrs) expect(modules(q)).toBe(refModules);
  });
});

describe('share targets', () => {
  it.each([
    ['Share on X', 'x'],
    ['Share on WhatsApp', 'whatsapp'],
    ['Share on Telegram', 'telegram'],
  ] as const)('%s opens the official intent in a new tab, without an opener or a referrer', (name, target) => {
    mount();
    const links = screen.getAllByRole('link', { name });
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.getAttribute('href')).toBe(intentUrl(target, 88n, OPEN.question));
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')?.split(' ').sort()).toEqual(['noopener', 'noreferrer']);
    }
  });

  it('Copy link copies the link (tagged "link") and shows "Copied"', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard(writeText);
    mount();
    expect(screen.getAllByRole('button', { name: 'Copy link' })).toHaveLength(2);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Copy link' })[0]);
    });
    expect(writeText).toHaveBeenCalledWith(poolInviteLink(88n, 'link'));
    expect(screen.getAllByRole('button', { name: 'Copied' }).length).toBeGreaterThan(0);
  });

  it('a refused copy says so instead of claiming "Copied"', async () => {
    setClipboard(async () => {
      throw new Error('denied');
    });
    mount();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Copy link' })[0]);
    });
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Copy failed' }).length).toBeGreaterThan(0);
  });

  it('Save image is the design slot, disabled, marked coming soon', () => {
    mount();
    const buttons = screen.getAllByRole('button', { name: 'Save image · coming soon' });
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
      expect(b.getAttribute('aria-disabled')).toBe('true');
    }
  });

  it('offers the device share where it exists, with the link tagged "link"', async () => {
    const share = vi.fn(async () => {});
    setShare(share);
    mount();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'More ways to share' })[0]);
    });
    expect(share).toHaveBeenCalledWith({ title: OPEN.question, text: `${OPEN.question} on Mako Market`, url: poolInviteLink(88n, 'link') });
  });

  it('hides the device share where it does not exist', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'More ways to share' })).toBeNull();
  });
});

describe('closing', () => {
  it('Escape closes', () => {
    const onClose = mount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the scrim and the close button close', () => {
    const onClose = mount();
    fireEvent.click(document.querySelector('.mk-scrim')!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps the canvas on mobile in dark mode (no yellow action sheet) and is a modal dialog named Share', () => {
    mount();
    const dialogs = screen.getAllByRole('dialog', { name: 'Share' });
    expect(dialogs).toHaveLength(2);
    for (const d of dialogs) expect(d.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('.mk-ysheet')).toBeNull();
  });

  it('never speaks as "we" or "our"', () => {
    mount(OPEN);
    expect(document.body.textContent).not.toMatch(/\b(we|our|us|team)\b/i);
    expect(document.body.textContent).not.toContain('—');
    cleanup();
    mount(SETTLED);
    expect(document.body.textContent).not.toMatch(/\b(we|our|us|team)\b/i);
    expect(document.body.textContent).not.toContain('—');
  });
});
