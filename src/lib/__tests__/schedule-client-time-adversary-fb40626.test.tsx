// Adversary on fb40626 (spec 2026-10-08, item 3): the Rounds schedule form uses its default start exactly, even when
// that default falls in the second pass of a repeated fall-back hour, parses typed text with the strict shared parser,
// and shows the true reason when a typed value is refused. Rendered in America/New_York, whose 2027 fall-back is
// 2027-11-07 02:00 EDT -> 01:00 EST, so 01:00 to 01:59 that night happens twice.
process.env.TZ = 'America/New_York';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

// 2027-11-07 06:05 UTC = 01:05 EST (the second 01:05). The default is the first whole minute 15 minutes out: 06:20 UTC,
// which prints as 01:20 and, read back as text, would be 01:20 EDT (05:20 UTC), an hour early.
const NOW = Date.UTC(2027, 10, 7, 6, 5) / 1000;
const SECOND_0120 = Date.UTC(2027, 10, 7, 6, 20) / 1000;

const open = vi.fn();
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/use-live-clock', () => ({ useLiveNowSec: () => NOW }));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: { authType: 'external', walletAddress: '0x0000000000000000000000000000000000000001' } }),
  accountAddress: (u: { walletAddress: string }) => u.walletAddress,
}));
vi.mock('@/lib/use-rounds', () => ({ roundsContract: '0x0000000000000000000000000000000000000002', useIsCreator: () => true }));
vi.mock('@/lib/use-round-tx', () => ({
  useRoundTx: () => ({ tx: null, phase: 'idle', open, confirm: vi.fn(), close: vi.fn(), retry: vi.fn() }),
}));

import { ScheduleClient } from '@/app/rounds/new/ScheduleClient';

afterEach(() => {
  cleanup();
  open.mockReset();
});

describe('Rounds schedule form, start time', () => {
  it('schedules the default exactly, in the second pass of a repeated hour', () => {
    render(<ScheduleClient />);
    const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    expect(input.value).toBe('2027-11-07T01:20');
    fireEvent.click(screen.getByRole('button'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toEqual({ kind: 'schedule', startTime: BigInt(SECOND_0120) });
  });

  it('an impossible date never reaches the form as text: the input sanitises it to empty and scheduling is refused', () => {
    // HTML value sanitisation turns an invalid datetime-local string into '', as browsers do, so the form asks for a
    // time instead of naming the date; localInputProblem's impossible-date branch is covered by the unit tests.
    render(<ScheduleClient />);
    const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2027-11-31T10:00' } });
    expect(input.value).toBe('');
    expect(screen.getByText('Pick a start time.')).toBeTruthy();
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses a typed time inside the spring-forward gap and blames the clocks', () => {
    render(<ScheduleClient />);
    const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2028-03-12T02:30' } });
    expect(screen.getByText(/clocks jump forward/)).toBeTruthy();
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a typed real time is that time (strict parser, no shift)', () => {
    render(<ScheduleClient />);
    const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2027-11-08T09:00' } });
    fireEvent.click(screen.getByRole('button'));
    expect(open.mock.calls[0][0]).toEqual({ kind: 'schedule', startTime: BigInt(Date.UTC(2027, 10, 8, 14, 0) / 1000) });
  });
});
