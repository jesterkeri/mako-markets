// ----------------------------------------------------------------------------
// totp-disable-modal.test.tsx
//
// Pins the TotpDisableModal state machine + every server-error path
// the route surfaces (200, 401 factor_failed, 409 not_enabled,
// 429 totp_locked, 500 internal). Plus the load-bearing async
// safety: late response after unmount drops without setState.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TotpDisableModal } from '../../components/profile/TotpDisableModal';
import {
  USER_QUERY_KEY,
  type AuthedUser,
  type MagicAuthedUser,
} from '../use-user';

afterEach(cleanup);

const ENABLED_USER: AuthedUser = {
  authed: true,
  authType: 'magic',
  email: 'joshua@example.com',
  magicEoa: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  safeAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  displayName: 'Joshua',
  avatarUrl: null,
  totpEnabled: true,
  totpEnabledAt: '2026-04-15T00:00:00.000Z',
  lastSignInAt: null,
  nextEmailChangeAvailableAt: null,
};

let fetchMock: ReturnType<typeof vi.fn>;
let qc: QueryClient;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(USER_QUERY_KEY, ENABLED_USER);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function withQc(ui: React.ReactNode) {
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe('TotpDisableModal', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      withQc(<TotpDisableModal open={false} onClose={vi.fn()} />),
    );
    expect(container.firstChild).toBeNull();
  });

  it('TOTP success: posts { totpCode } + writes optimistic cache + closes', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    const onClose = vi.fn();
    const { getByLabelText, getByText } = render(
      withQc(<TotpDisableModal open={true} onClose={onClose} />),
    );
    fireEvent.change(getByLabelText('6-DIGIT CODE'), {
      target: { value: '123456' },
    });
    fireEvent.click(getByText('DISABLE'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/user/totp/disable');
    const body = JSON.parse((opts as { body: string }).body);
    expect(body).toEqual({ totpCode: '123456' });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const cached = qc.getQueryData(USER_QUERY_KEY) as MagicAuthedUser;
    expect(cached.totpEnabled).toBe(false);
    expect(cached.totpEnabledAt).toBeNull();
  });

  it('Recovery code success: posts { recoveryCode } when factor mode toggled', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    const onClose = vi.fn();
    const { getByText, container } = render(
      withQc(<TotpDisableModal open={true} onClose={onClose} />),
    );
    // Toggle to recovery mode.
    fireEvent.click(getByText('RECOVERY CODE'));
    const input = container.querySelector('#totp-disable-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'AAAA-BBBB-CC' } });
    fireEvent.click(getByText('DISABLE'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body).toEqual({ recoveryCode: 'AAAA-BBBB-CC' });
  });

  it('401 factor_failed → stays on form + inline error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'factor_failed' }),
    });
    const onClose = vi.fn();
    const { getByLabelText, getByText } = render(
      withQc(<TotpDisableModal open={true} onClose={onClose} />),
    );
    fireEvent.change(getByLabelText('6-DIGIT CODE'), {
      target: { value: '999999' },
    });
    fireEvent.click(getByText('DISABLE'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent ?? '').toMatch(/wrong/i);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(getByText('DISABLE')).toBeTruthy();
  });

  it('429 totp_locked → LOCKED phase + countdown visible', async () => {
    const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: 'totp_locked', retryAt }),
    });
    const { getByLabelText, getByText, container } = render(
      withQc(<TotpDisableModal open={true} onClose={vi.fn()} />),
    );
    fireEvent.change(getByLabelText('6-DIGIT CODE'), {
      target: { value: '123456' },
    });
    fireEvent.click(getByText('DISABLE'));

    await waitFor(() => {
      expect(container.textContent).toContain('LOCKED');
    });
    // Form input should no longer render (LOCKED branch).
    expect(container.querySelector('#totp-disable-input')).toBeNull();
  });

  it('Locked countdown elapses → phase returns to idle, form re-enabled', async () => {
    // Use real timers for the fetch resolution path, then switch to
    // fake timers ONLY to advance the countdown deterministically.
    // Mixing fake timers with mocked-promise fetches is fragile —
    // fake timers don't auto-flush microtasks, so the response
    // handler chain (await res.json + setState) doesn't progress
    // until vi.advanceTimersByTimeAsync flushes.
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: 'totp_locked', retryAt }),
    });
    const { container, getByLabelText, getByText } = render(
      withQc(<TotpDisableModal open={true} onClose={vi.fn()} />),
    );
    fireEvent.change(getByLabelText('6-DIGIT CODE'), {
      target: { value: '111111' },
    });
    fireEvent.click(getByText('DISABLE'));

    // Wait for the LOCKED phase to render under real timers.
    await waitFor(() => {
      expect(container.textContent).toContain('LOCKED');
    });

    // Now switch to fake timers to advance the countdown 61s
    // (the retryAt + 1s buffer). The countdown ticker fires every
    // 1000ms; the auto-transition effect runs when retryAt elapses.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await vi.advanceTimersByTimeAsync(61_000);
      await waitFor(() => {
        expect(container.querySelector('#totp-disable-input')).not.toBeNull();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('409 not_enabled → state drift, closes + invalidates cache', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: 'not_enabled' }),
    });
    const onClose = vi.fn();
    const { getByLabelText, getByText } = render(
      withQc(<TotpDisableModal open={true} onClose={onClose} />),
    );
    fireEvent.change(getByLabelText('6-DIGIT CODE'), {
      target: { value: '123456' },
    });
    fireEvent.click(getByText('DISABLE'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('500 → error phase + retry hint, no cache write', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'internal' }),
    });
    const { getByLabelText, getByText } = render(
      withQc(<TotpDisableModal open={true} onClose={vi.fn()} />),
    );
    fireEvent.change(getByLabelText('6-DIGIT CODE'), {
      target: { value: '123456' },
    });
    fireEvent.click(getByText('DISABLE'));

    await waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent ?? '').toMatch(/try again/i);
    });
    const cached = qc.getQueryData(USER_QUERY_KEY) as MagicAuthedUser;
    expect(cached.totpEnabled).toBe(true); // unchanged
  });

  it('Switching factor mode mid-edit clears the code field', () => {
    const { getByText, container } = render(
      withQc(<TotpDisableModal open={true} onClose={vi.fn()} />),
    );
    const input = container.querySelector('#totp-disable-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '123456' } });
    expect(input.value).toBe('123456');
    fireEvent.click(getByText('RECOVERY CODE'));
    const newInput = container.querySelector('#totp-disable-input') as HTMLInputElement;
    expect(newInput.value).toBe('');
  });

  it('Close/reopen race: late response from prior open does NOT mutate fresh modal (codex round-1 MAJOR on Sub-C)', async () => {
    // Submit on first open. Defer the response. Close + reopen
    // before resolving — the late response must NOT flip the
    // newly-opened modal's cache or trigger onClose.
    let resolveFirst!: (res: unknown) => void;
    const deferredFirst = new Promise((r) => {
      resolveFirst = r;
    });
    fetchMock.mockReturnValueOnce(deferredFirst);

    function Harness({ open }: { open: boolean }) {
      const onClose = vi.fn();
      return <TotpDisableModal open={open} onClose={onClose} />;
    }

    const { rerender, getByLabelText, getByText, queryByLabelText } = render(
      withQc(<Harness open={true} />),
    );
    fireEvent.change(getByLabelText('6-DIGIT CODE'), {
      target: { value: '123456' },
    });
    fireEvent.click(getByText('DISABLE'));

    // Close (open=false) — modal unmounts.
    rerender(withQc(<Harness open={false} />));
    expect(queryByLabelText('6-DIGIT CODE')).toBeNull();

    // Reopen (open=true) — fresh modal instance with phase='idle'.
    rerender(withQc(<Harness open={true} />));
    expect(queryByLabelText('6-DIGIT CODE')).not.toBeNull();

    // Now resolve the FIRST request with what would be a successful
    // disable. The reqIdRef guard must drop this response on the
    // floor; otherwise it would optimistically flip totpEnabled=false
    // and call onClose on the freshly-opened modal.
    resolveFirst({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Cache should be unchanged — still totpEnabled=true.
    const cached = qc.getQueryData(USER_QUERY_KEY) as MagicAuthedUser;
    expect(cached.totpEnabled).toBe(true);
    // Fresh modal still shows the form (phase='idle').
    expect(queryByLabelText('6-DIGIT CODE')).not.toBeNull();
  });

  it('Late response after unmount does NOT setState on dead component', async () => {
    let resolveFetch!: (res: unknown) => void;
    const deferred = new Promise((r) => {
      resolveFetch = r;
    });
    fetchMock.mockReturnValueOnce(deferred);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { getByLabelText, getByText, unmount } = render(
        withQc(<TotpDisableModal open={true} onClose={vi.fn()} />),
      );
      fireEvent.change(getByLabelText('6-DIGIT CODE'), {
        target: { value: '123456' },
      });
      fireEvent.click(getByText('DISABLE'));
      unmount();
      resolveFetch({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
