// ----------------------------------------------------------------------------
// identity-block.test.tsx
//
// DOM-level tests for IdentityBlock (Group 4 Sub-B + 4-E avatar
// upload migration). The component owns the display-name edit state
// machine + avatar file-upload flow + email-edit flow; the
// mounted-ref + AbortController discipline mirrors the load-bearing
// patterns the modals will use in Sub-C.
//
// Pins:
//   - Wallet-only branch shows address + no edit affordances
//   - Magic branch surfaces SIGNED IN AS / DISPLAY NAME / AVATAR
//   - Display name SAVE posts { displayName: <trimmed> } and writes
//     the optimistic cache entry
//   - Display name CLEAR posts { displayName: null }
//   - Client-side validation catches bad display names BEFORE fetch
//   - Avatar upload: oversize file rejected client-side; bad MIME
//     rejected client-side; valid file POSTs FormData to
//     /api/user/avatar/upload; success path writes the optimistic
//     cache entry. (URL paste is gone since 1G Group 4-E — the
//     upload route is the SOLE non-null avatarUrl writer.)
//   - Late response after unmount drops without console.error
//   - 400 from server stays on form + surfaces inline error
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock wagmi at the test level so the new wallet-pre-signin branch
// (WalletSignInPrompt → useSignMessage) doesn't require a real
// WagmiProvider in this test surface. The Magic-user tests below don't
// touch wagmi at all; they're unaffected by the mock.
vi.mock('wagmi', () => ({
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
}));

import { IdentityBlock } from '../../components/profile/IdentityBlock';
import { USER_QUERY_KEY, type AuthedUser } from '../use-user';

afterEach(cleanup);

const MAGIC_USER: AuthedUser = {
  authed: true,
  authType: 'magic',
  email: 'joshua@example.com',
  magicEoa: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  safeAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  displayName: null,
  avatarUrl: null,
  totpEnabled: false,
  totpEnabledAt: null,
  lastSignInAt: null,
  nextEmailChangeAvailableAt: null,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeQueryClient(seed: AuthedUser): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(USER_QUERY_KEY, seed);
  return qc;
}

function withProvider(ui: React.ReactNode, qc: QueryClient) {
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe('IdentityBlock — wallet-only branch', () => {
  it('renders the formatted wallet address and no Magic edit affordances', () => {
    const qc = new QueryClient();
    const { queryByText, container } = render(
      withProvider(
        <IdentityBlock user={null} connectedWallet="0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" />,
        qc,
      ),
    );
    expect(container.textContent).toContain('0xaaaa…aaaa');
    expect(queryByText('DISPLAY NAME')).toBeNull();
    expect(queryByText('AVATAR URL')).toBeNull();
    expect(queryByText('EDIT')).toBeNull();
  });
});

// Display-name section uses a SET / EDIT / CLEAR button affordance.
// Avatar section is now a file-upload picker (no SET; the trigger is
// UPLOAD IMAGE / REPLACE IMAGE depending on whether a value exists).
function clickSetForDisplayName(getAllByText: (s: string) => HTMLElement[]) {
  fireEvent.click(getAllByText('SET')[0]);
}

function getAvatarFileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error('avatar file input not found');
  return input as HTMLInputElement;
}

function pickAvatarFile(file: File) {
  const input = getAvatarFileInput();
  fireEvent.change(input, { target: { files: [file] } });
}

describe('IdentityBlock — display name', () => {
  it('SAVE posts { displayName: trimmed } and writes optimistic cache', async () => {
    const qc = makeQueryClient(MAGIC_USER);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ...MAGIC_USER,
          ok: true,
          authed: true,
          displayName: 'Joshua',
        }),
    });
    const { getByText, getByLabelText, getAllByText } = render(
      withProvider(
        <IdentityBlock user={MAGIC_USER} connectedWallet={undefined} />,
        qc,
      ),
    );
    clickSetForDisplayName(getAllByText);
    const input = getByLabelText('NEW DISPLAY NAME');
    fireEvent.change(input, { target: { value: '  Joshua  ' } });
    fireEvent.click(getByText('SAVE'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/user/profile/update');
    const body = JSON.parse((opts as { body: string }).body);
    expect(body).toEqual({ displayName: 'Joshua' });

    await waitFor(() => {
      const cached = qc.getQueryData(USER_QUERY_KEY) as AuthedUser | undefined;
      expect(cached?.displayName).toBe('Joshua');
    });
  });

  it('CLEAR posts { displayName: null }', async () => {
    const userWithName: AuthedUser = { ...MAGIC_USER, displayName: 'Joshua' };
    const qc = makeQueryClient(userWithName);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ...userWithName,
          ok: true,
          authed: true,
          displayName: null,
        }),
    });
    const { getByText, getAllByText } = render(
      withProvider(
        <IdentityBlock user={userWithName} connectedWallet={undefined} />,
        qc,
      ),
    );
    // Two EDITs: email row [0] + display-name row [1]. Click the
    // display-name one.
    const edits = getAllByText('EDIT');
    fireEvent.click(edits[1]);
    fireEvent.click(getByText('CLEAR'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body).toEqual({ displayName: null });
  });

  it('client-side validation rejects empty / too-long / illegal chars without fetching', async () => {
    const qc = makeQueryClient(MAGIC_USER);
    const { getByText, getByLabelText, getAllByText } = render(
      withProvider(
        <IdentityBlock user={MAGIC_USER} connectedWallet={undefined} />,
        qc,
      ),
    );
    clickSetForDisplayName(getAllByText);
    const input = getByLabelText('NEW DISPLAY NAME') as HTMLInputElement;

    function getAlert(): HTMLElement | null {
      return document.querySelector('[role="alert"]');
    }

    // Whitespace-only
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(getByText('SAVE'));
    await waitFor(() => {
      expect(getAlert()?.textContent ?? '').toMatch(/cannot be empty/i);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Too long (33 chars). The native maxLength=32 caps keyboard
    // entry but the regex MUST still reject paste / programmatic
    // values that bypass it.
    input.removeAttribute('maxlength');
    fireEvent.change(input, { target: { value: 'a'.repeat(33) } });
    fireEvent.click(getByText('SAVE'));
    await waitFor(() => {
      expect(getAlert()?.textContent ?? '').toMatch(/letters, numbers/i);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Illegal char (emoji / angle bracket)
    fireEvent.change(input, { target: { value: '<script>' } });
    fireEvent.click(getByText('SAVE'));
    await waitFor(() => {
      expect(getAlert()?.textContent ?? '').toMatch(/letters, numbers/i);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400 from server stays on form + surfaces an inline error', async () => {
    const qc = makeQueryClient(MAGIC_USER);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'bad_body' }),
    });
    const { getByText, getByLabelText, getAllByText } = render(
      withProvider(
        <IdentityBlock user={MAGIC_USER} connectedWallet={undefined} />,
        qc,
      ),
    );
    clickSetForDisplayName(getAllByText);
    fireEvent.change(getByLabelText('NEW DISPLAY NAME'), {
      target: { value: 'Joshua' },
    });
    fireEvent.click(getByText('SAVE'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent ?? '').toMatch(/rejected/i);
    });
    // Form is still open (still see SAVE).
    expect(getByText('SAVE')).toBeTruthy();
  });
});

describe('IdentityBlock — avatar upload', () => {
  it('client-side validation rejects oversize file and disallowed MIME without fetching', async () => {
    const qc = makeQueryClient(MAGIC_USER);
    render(
      withProvider(
        <IdentityBlock user={MAGIC_USER} connectedWallet={undefined} />,
        qc,
      ),
    );

    function getAlert(): HTMLElement | null {
      return document.querySelector('[role="alert"]');
    }

    // Oversize: 5 MB > 4 MB cap.
    const oversize = new File(['x'.repeat(5 * 1024 * 1024)], 'big.png', {
      type: 'image/png',
    });
    pickAvatarFile(oversize);
    await waitFor(() => {
      expect(getAlert()?.textContent ?? '').toMatch(/4 MB/);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Disallowed MIME: image/gif is not in the allowlist.
    const wrongMime = new File(['gif'], 'a.gif', { type: 'image/gif' });
    pickAvatarFile(wrongMime);
    await waitFor(() => {
      expect(getAlert()?.textContent ?? '').toMatch(/PNG, JPG, or WEBP/i);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Empty file: zero bytes.
    const empty = new File([], 'empty.png', { type: 'image/png' });
    pickAvatarFile(empty);
    await waitFor(() => {
      expect(getAlert()?.textContent ?? '').toMatch(/empty/i);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('upload posts FormData to /api/user/avatar/upload and writes optimistic cache', async () => {
    const qc = makeQueryClient(MAGIC_USER);
    const blobUrl =
      'https://abc123.public.blob.vercel-storage.com/avatars/u/123.webp';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ...MAGIC_USER,
          ok: true,
          authed: true,
          avatarUrl: blobUrl,
        }),
    });
    render(
      withProvider(
        <IdentityBlock user={MAGIC_USER} connectedWallet={undefined} />,
        qc,
      ),
    );

    const file = new File(['png-bytes'], 'avatar.png', { type: 'image/png' });
    pickAvatarFile(file);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; body: FormData },
    ];
    expect(url).toBe('/api/user/avatar/upload');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    const sent = (init.body as FormData).get('avatar');
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe('avatar.png');

    await waitFor(() => {
      const cached = qc.getQueryData(USER_QUERY_KEY) as AuthedUser | undefined;
      expect(cached?.avatarUrl).toBe(blobUrl);
    });
  });
});

describe('IdentityBlock — concurrent edits', () => {
  it('submitting avatar mid-flight does NOT abort an in-flight display submit (codex round-1 MAJOR)', async () => {
    const qc = makeQueryClient(MAGIC_USER);

    // First call: display submit. Defer the response so we can fire
    // a second submit (avatar) before this resolves. Second call:
    // avatar, resolves immediately.
    let resolveDisplay!: (res: unknown) => void;
    const deferredDisplay = new Promise((r) => {
      resolveDisplay = r;
    });
    fetchMock
      .mockReturnValueOnce(deferredDisplay)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ...MAGIC_USER,
            ok: true,
            authed: true,
            avatarUrl: 'https://example.com/a.png',
          }),
      });

    const { getByText, getByLabelText, getAllByText } = render(
      withProvider(
        <IdentityBlock user={MAGIC_USER} connectedWallet={undefined} />,
        qc,
      ),
    );

    // Open the display-name edit form (avatar upload is one-shot file
    // picker — no edit form to open).
    clickSetForDisplayName(getAllByText);

    // Submit display first.
    fireEvent.change(getByLabelText('NEW DISPLAY NAME'), {
      target: { value: 'Joshua' },
    });
    fireEvent.click(getByText('SAVE'));

    // Now upload avatar BEFORE display resolves.
    const file = new File(['png'], 'avatar.png', { type: 'image/png' });
    pickAvatarFile(file);

    // Avatar should land synchronously; display should still be
    // mid-flight (SAVING…). Resolve display now.
    resolveDisplay({
      ok: true,
      json: () =>
        Promise.resolve({
          ...MAGIC_USER,
          ok: true,
          authed: true,
          displayName: 'Joshua',
          avatarUrl: 'https://example.com/a.png',
        }),
    });

    // Wait for both fetches to land.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // Critical assertion: NO leftover SAVING… / UPLOADING… stuck on a
    // dead in-flight controller. Codex round-1 MAJOR regression would
    // manifest as a stuck SAVING… on display when avatar upload
    // aborted its sibling controller.
    await waitFor(() => {
      const stuckButtons = Array.from(
        document.querySelectorAll('button'),
      ).filter((b) => /SAVING|UPLOADING/.test(b.textContent ?? ''));
      expect(stuckButtons.length).toBe(0);
    });
  });
});

describe('IdentityBlock — async safety', () => {
  it('late response after unmount does NOT setState on dead component', async () => {
    const qc = makeQueryClient(MAGIC_USER);
    let resolveFetch!: (res: unknown) => void;
    const deferred = new Promise((r) => {
      resolveFetch = r;
    });
    fetchMock.mockReturnValueOnce(deferred);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { getByText, getByLabelText, getAllByText, unmount } = render(
        withProvider(
          <IdentityBlock user={MAGIC_USER} connectedWallet={undefined} />,
          qc,
        ),
      );
      clickSetForDisplayName(getAllByText);
      fireEvent.change(getByLabelText('NEW DISPLAY NAME'), {
        target: { value: 'Joshua' },
      });
      fireEvent.click(getByText('SAVE'));
      // fetch is awaiting; unmount before resolving.
      unmount();
      resolveFetch({
        ok: true,
        json: () =>
          Promise.resolve({
            ...MAGIC_USER,
            ok: true,
            authed: true,
            displayName: 'Joshua',
          }),
      });
      // Flush microtasks.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
