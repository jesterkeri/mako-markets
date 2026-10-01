// Adversary pass on the feedback sheet: it must say "Sent" only when the server said the message was delivered
// (the route answers 200 { ok: true } and nothing else on delivery). A 2xx that is not that answer, such as a
// captive portal's 200 HTML page or a 204 from a proxy, means nothing reached Telegram.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: null, isLoading: false, isError: false, refetch: vi.fn() }),
  accountAddress: () => null,
}));

import { FeedbackSheet } from '@/components/FeedbackSheet';
import { closeFeedback, openFeedback } from '@/lib/feedback-store';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});
afterEach(() => {
  act(() => closeFeedback());
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function sendWith(res: Response) {
  fetchMock.mockResolvedValueOnce(res);
  render(<FeedbackSheet />);
  act(() => openFeedback());
  fireEvent.change((screen.getAllByLabelText('Your feedback') as HTMLTextAreaElement[])[0], { target: { value: 'claim spins' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Send' })[0]);
  await waitFor(() => expect(screen.queryAllByText('Sending…')).toHaveLength(0));
}

describe('FeedbackSheet never says Sent without the server saying delivered', () => {
  it('a 200 that is an HTML page (captive portal), not { ok: true }', async () => {
    await sendWith(new Response('<html><body>Sign in to the Wi-Fi</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(screen.queryAllByText('Sent')).toHaveLength(0);
  });

  it('a 204 No Content', async () => {
    await sendWith(new Response(null, { status: 204 }));
    expect(screen.queryAllByText('Sent')).toHaveLength(0);
  });
});
