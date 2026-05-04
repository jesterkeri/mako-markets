// ----------------------------------------------------------------------------
// identity-block.test.tsx
//
// DOM-level tests for IdentityBlock (Group 4 Sub-B). The component
// owns the display-name + avatar-URL edit state machines plus the
// extracted email-edit flow; the validation + mounted-ref +
// AbortController discipline mirror the load-bearing patterns the
// modals will use in Sub-C.
//
// Pins:
//   - Wallet-only branch shows address + no edit affordances
//   - Magic branch surfaces SIGNED IN AS / DISPLAY NAME / AVATAR URL
//   - Display name SAVE posts { displayName: <trimmed> } and writes
//     the optimistic cache entry
//   - Display name CLEAR posts { displayName: null }
//   - Client-side validation catches bad display names BEFORE fetch
//   - Avatar URL validation: http://, userinfo, fragment, > 512 all
//     rejected before fetch
//   - Avatar URL SAVE posts { avatarUrl: <value> }
//   - Late response after unmount drops without console.error
//   - 400 from server stays on form + surfaces inline error
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { IdentityBlock } from '../../components/profile/IdentityBlock';
import { USER_QUERY_KEY, type AuthedUser } from '../use-user';

afterEach(cleanup);

const MAGIC_USER: AuthedUser = {
  authed: true,
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

// When both displayName and avatarUrl are null, two SET buttons
// appear. Index 0 is the display-name section; index 1 is the
// avatar-url section. Same goes for SAVE / CANCEL / CLEAR while
// both edit forms might be open simultaneously.
function clickSetForDisplayName(getAllByText: (s: string) => HTMLElement[]) {
  fireEvent.click(getAllByText('SET')[0]);
}
function clickSetForAvatarUrl(getAllByText: (s: string) => HTMLElement[]) {
  const all = getAllByText('SET');
  fireEvent.click(all[all.length - 1]);
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

describe('IdentityBlock — avatar URL', () => {
  it('client-side validation rejects http://, userinfo, fragments, length > 512', async () => {
    const qc = makeQueryClient(MAGIC_USER);
    const { getByText, getByLabelText, getAllByText } = render(
      withProvider(
        <IdentityBlock user={MAGIC_USER} connectedWallet={undefined} />,
        qc,
      ),
    );
    clickSetForAvatarUrl(getAllByText);

    const input = getByLabelText('NEW AVATAR URL') as HTMLInputElement;

    function getAlert(): HTMLElement | null {
      return document.querySelector('[role="alert"]');
    }

    fireEvent.change(input, { target: { value: 'http://example.com/a.png' } });
    fireEvent.click(getByText('SAVE'));
    await waitFor(() => {
      const alert = getAlert();
      expect(alert?.textContent ?? '').toMatch(/https/i);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(input, {
      target: { value: 'https://user:pass@example.com/a.png' },
    });
    fireEvent.click(getByText('SAVE'));
    await waitFor(() => {
      const alert = getAlert();
      expect(alert?.textContent ?? '').toMatch(/user:password@host/i);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(input, {
      target: { value: 'https://example.com/a.png#frag' },
    });
    fireEvent.click(getByText('SAVE'));
    await waitFor(() => {
      const alert = getAlert();
      expect(alert?.textContent ?? '').toMatch(/fragment/i);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Length > 512. The native maxLength caps keyboard entry; a paste
    // / programmatic value of 513 chars should still bounce off the
    // length guard without a fetch (codex round-2 MINOR).
    input.removeAttribute('maxlength');
    const longUrl = 'https://example.com/' + 'a'.repeat(500); // 520 chars
    expect(longUrl.length).toBeGreaterThan(512);
    fireEvent.change(input, { target: { value: longUrl } });
    fireEvent.click(getByText('SAVE'));
    await waitFor(() => {
      expect(getAlert()?.textContent ?? '').toMatch(/512/);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SAVE posts { avatarUrl: value } and writes optimistic cache', async () => {
    const qc = makeQueryClient(MAGIC_USER);
    fetchMock.mockResolvedValueOnce({
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
    clickSetForAvatarUrl(getAllByText);
    fireEvent.change(getByLabelText('NEW AVATAR URL'), {
      target: { value: 'https://example.com/a.png' },
    });
    fireEvent.click(getByText('SAVE'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body).toEqual({ avatarUrl: 'https://example.com/a.png' });

    await waitFor(() => {
      const cached = qc.getQueryData(USER_QUERY_KEY) as AuthedUser | undefined;
      expect(cached?.avatarUrl).toBe('https://example.com/a.png');
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

    // Open BOTH edit forms.
    clickSetForDisplayName(getAllByText);
    clickSetForAvatarUrl(getAllByText);

    // Submit display first.
    fireEvent.change(getByLabelText('NEW DISPLAY NAME'), {
      target: { value: 'Joshua' },
    });
    const saves1 = getAllByText(/SAVE/i);
    fireEvent.click(saves1[0]); // display-name SAVE

    // Now submit avatar BEFORE display resolves.
    fireEvent.change(getByLabelText('NEW AVATAR URL'), {
      target: { value: 'https://example.com/a.png' },
    });
    const saves2 = getAllByText(/SAVE/i);
    fireEvent.click(saves2[saves2.length - 1]); // avatar SAVE

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

    // Critical assertion: NO leftover SAVING… anywhere. Both forms
    // either closed (success) or back to SAVE (re-editable). The
    // codex MAJOR regression would manifest as a stuck SAVING…
    // button on the display field.
    await waitFor(() => {
      const savingButtons = Array.from(
        document.querySelectorAll('button'),
      ).filter((b) => /SAVING/.test(b.textContent ?? ''));
      expect(savingButtons.length).toBe(0);
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
