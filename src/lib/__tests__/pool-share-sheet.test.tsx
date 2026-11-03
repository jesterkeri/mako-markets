// Share (15a) for a pool: the card (its link preview), its targets, Copy link, and closing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { PoolShareSheet } from '@/components/PoolShareSheet';
import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { intentUrl, poolInviteLink } from '@/lib/pool-invite';

const USDC = 1_000_000n;
const NOW = 1_800_000_000;

const OPEN: MarketWithId = {
  id: 88n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: '0x4254433a67743a31000000000000000000000000000000000000000000000000', // BTC:gt:1, a reference the resolver reads
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
  render(<PoolShareSheet market={market} onClose={onClose} />);
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

describe('the card', () => {
  it('is the pool\'s link preview itself (the new card design, Joshua 2026-10-26), so the sheet shows what a pasted link shows', () => {
    mount();
    // Both layouts render (CSS shows one).
    const imgs = screen.getAllByRole('img', { name: `Share card for ${OPEN.question}` });
    expect(imgs).toHaveLength(2);
    for (const i of imgs) expect(i.getAttribute('src')).toBe('/pools/88/opengraph-image');
  });

  it('offers Download for the card image (the old Save image slot, now working)', () => {
    mount();
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Save image/ })).toBeNull();
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
