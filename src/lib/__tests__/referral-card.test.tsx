// The Me invite card: the link is the main button, the code sits beneath it with its own Copy, the counts are the
// caller's own, and the "Invited by a friend?" field shows only while the account may still take an inviter.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReferralCard } from '@/app/me/ReferralCard';

const ACCOUNT = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195' as const;
const CODE = 'r-bc5a58487d7949da2b76ac84afc032';

function mount(counts: { joined: number; qualified: number; canAddInviter: boolean }, post?: (body: string) => Response) {
  const posted: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/user/referrals') return Response.json(counts);
    if (url === '/api/user/referrer' && post) {
      posted.push(String(init?.body));
      return post(String(init?.body));
    }
    return new Response('{}', { status: 404 });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ReferralCard account={ACCOUNT} variant="desktop" />
    </QueryClientProvider>,
  );
  return posted;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReferralCard', () => {
  it('shows the link button, the code with Copy code, and the caller’s counts', async () => {
    mount({ joined: 3, qualified: 2, canAddInviter: false });
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeTruthy();
    expect(screen.getByText(CODE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
    expect(await screen.findByText('3 signed up with your link or code')).toBeTruthy();
    expect(screen.getByText('2 of them placed a bet')).toBeTruthy();
    expect(screen.getByText('You are entered in the competition.')).toBeTruthy();
    expect(screen.queryByLabelText('Invited by a friend? Enter their code')).toBeNull();
  });

  it('offers the inviter field while allowed, and shows a refusal in words', async () => {
    const posted = mount({ joined: 0, qualified: 0, canAddInviter: true }, () => Response.json({ error: 'own' }, { status: 400 }));
    const field = await screen.findByLabelText('Invited by a friend? Enter their code');
    expect(screen.getByText('Not entered yet: 2 friends who placed a bet are needed.')).toBeTruthy();
    fireEvent.change(field, { target: { value: ` ${CODE} ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect((await screen.findByRole('alert')).textContent).toBe("You can't use your own code");
    expect(posted).toEqual([JSON.stringify({ code: CODE })]);
  });
});
