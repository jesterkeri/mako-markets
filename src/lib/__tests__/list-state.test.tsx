// The shared list states (16a) as rendered: "Try again" calls its handler, and is disabled rather than inert when
// a caller passes none (Codex S1 r1); links and "coming soon" render as what they are.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/components/Mascot', () => ({ Mascot: () => null }));

import { ListStateDesktop, ListStateMobile } from '@/components/ListState';

afterEach(cleanup);

describe.each([
  ['desktop', ListStateDesktop],
  ['mobile', ListStateMobile],
] as const)('list states, %s', (_name, ListState) => {
  it('"Try again" on an error calls onRetry', () => {
    const onRetry = vi.fn();
    render(<ListState kind="pools" state="error" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('"Try again" with no onRetry is disabled, not a live-looking button that does nothing', () => {
    render(<ListState kind="pools" state="error" />);
    const retry = screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('aria-disabled')).toBe('true');
  });

  it("Me's error offers the account's explorer page in a new tab", () => {
    render(<ListState kind="me" state="error" onRetry={() => {}} explorerHref="https://testnet.monadvision.com/address/0xabc" />);
    const link = screen.getByRole('link', { name: 'View on explorer' });
    expect(link.getAttribute('href')).toBe('https://testnet.monadvision.com/address/0xabc');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('an unbuilt action is a disabled "coming soon", and a link goes where it says', () => {
    render(<ListState kind="rounds" state="empty" />);
    const soon = screen.getByRole('button', { name: /coming soon/ }) as HTMLButtonElement;
    expect(soon.disabled).toBe(true);
    expect(screen.getByRole('link', { name: 'Browse pools' }).getAttribute('href')).toBe('/pools');
  });
});
