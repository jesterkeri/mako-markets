// The feedback sheet: says "Sent" only when the server delivered the message, says plainly when it did not (bot not
// configured, too many messages, network), keeps the text for a retry, and counts characters like the server.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

const mocks = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: mocks.user, isLoading: false, isError: false, refetch: vi.fn() }),
  accountAddress: (u: { authType: string; safeAddress?: string; walletAddress?: string }) => (u.authType === 'magic' ? u.safeAddress : u.walletAddress),
}));

import { FeedbackSheet } from '@/components/FeedbackSheet';
import { closeFeedback, openFeedback } from '@/lib/feedback-store';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.user = null;
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});
afterEach(() => {
  act(() => closeFeedback());
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount() {
  render(<FeedbackSheet />);
  act(() => openFeedback());
}
const textareas = () => screen.getAllByLabelText('Your feedback') as HTMLTextAreaElement[];
const type = (s: string) => fireEvent.change(textareas()[0], { target: { value: s } });
const sendButtons = () => screen.getAllByRole('button', { name: 'Send' }) as HTMLButtonElement[];

describe('FeedbackSheet', () => {
  it('is closed until opened, and Escape closes it', () => {
    render(<FeedbackSheet />);
    expect(screen.queryByText('Send feedback')).toBeNull();
    act(() => openFeedback());
    expect(screen.getAllByText('Send feedback').length).toBeGreaterThan(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Send feedback')).toBeNull();
  });

  it('Send stays off until there is text, and past 1,000 characters', () => {
    mount();
    expect(sendButtons().every((b) => b.disabled)).toBe(true);
    type('   ');
    expect(sendButtons().every((b) => b.disabled)).toBe(true);
    type('The claim button spins');
    expect(sendButtons().every((b) => !b.disabled)).toBe(true);
    expect(screen.getAllByText('22 / 1,000').length).toBeGreaterThan(0);
    type('x'.repeat(1001));
    expect(sendButtons().every((b) => b.disabled)).toBe(true);
    expect(screen.getAllByText('That’s over 1,000 characters.').length).toBeGreaterThan(0);
  });

  it('says who it is sent as', () => {
    mount();
    expect(screen.getAllByText('Sent without an account').length).toBeGreaterThan(0);
    cleanup();
    act(() => closeFeedback());
    mocks.user = { authType: 'magic', safeAddress: '0xC8BF000000000000000000000000000000090F1a' };
    mount();
    expect(screen.getAllByText('Sent with 0xC8BF…0F1a').length).toBeGreaterThan(0);
  });

  it('posts the message and the page path, and says Sent only on success', async () => {
    window.history.pushState({}, '', '/pools/12?tab=comments');
    mount();
    type('Claim spins forever');
    fireEvent.click(sendButtons()[0]);
    await waitFor(() => expect(screen.getAllByText('Sent').length).toBeGreaterThan(0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/feedback');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ message: 'Claim spins forever', path: '/pools/12' });
  });

  it('a missing bot says feedback is unavailable, never Sent', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'feedback_unavailable' }), { status: 503 }));
    mount();
    type('hello');
    fireEvent.click(sendButtons()[0]);
    await waitFor(() => expect(screen.getAllByText('Feedback is unavailable right now. Nothing was sent.').length).toBeGreaterThan(0));
    expect(screen.queryByText('Sent')).toBeNull();
    expect(screen.getAllByText('Not sent').length).toBeGreaterThan(0);
  });

  it('over the limit says "Too many messages. Try again later."', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }));
    mount();
    type('hello');
    fireEvent.click(sendButtons()[0]);
    await waitFor(() => expect(screen.getAllByText('Too many messages. Try again later.').length).toBeGreaterThan(0));
  });

  it('a network failure keeps the text for Try again', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mount();
    type('keep me');
    fireEvent.click(sendButtons()[0]);
    await waitFor(() => expect(screen.getAllByText('Couldn’t reach Mako Market. Check your connection and try again.').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
    expect(textareas()[0].value).toBe('keep me');
  });

  it('cannot be closed while sending', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (resolve = r)));
    mount();
    type('hello');
    fireEvent.click(sendButtons()[0]);
    await waitFor(() => expect(screen.getAllByText('Sending…').length).toBeGreaterThan(0));
    expect(screen.queryAllByLabelText('Close')).toHaveLength(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getAllByText('Sending…').length).toBeGreaterThan(0);
    await act(async () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await waitFor(() => expect(screen.getAllByText('Sent').length).toBeGreaterThan(0));
  });
});
