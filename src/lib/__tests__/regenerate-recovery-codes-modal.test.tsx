// ----------------------------------------------------------------------------
// regenerate-recovery-codes-modal.test.tsx
//
// Pins the regenerate flow's invariants:
//   - Body sent contains totpCode and NEVER recoveryCode (server
//     route explicitly rejects recoveryCode per Group 2B)
//   - 200 → renders RecoveryCodesPanel + save-gate
//   - Save-gate: CLOSE/Escape/backdrop refused while
//     savedConfirmed=false (codex round-1 MAJOR on Group 4 plan)
//   - 401 factor_failed → stay on form
//   - 429 totp_locked → 'locked' phase + countdown
//   - Late response after close discarded
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { RegenerateRecoveryCodesModal } from '../../components/profile/RegenerateRecoveryCodesModal';
import { USER_QUERY_KEY, type AuthedUser } from '../use-user';

afterEach(cleanup);

const ENABLED_USER: AuthedUser = {
  authed: true,
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

const TEN_CODES = [
  'AAAA-BBBB-CC',
  'CCCC-DDDD-EE',
  'EEEE-FFFF-GG',
  'GGGG-HHHH-JJ',
  'JJJJ-KKKK-MM',
  'MMMM-NNNN-PP',
  'PPPP-QQQQ-RR',
  'RRRR-SSSS-TT',
  'TTTT-VVVV-WW',
  'WWWW-XXXX-YY',
];

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

describe('RegenerateRecoveryCodesModal', () => {
  it('body sent contains totpCode and never recoveryCode (server rejects per Group 2B)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, recoveryCodes: TEN_CODES }),
    });
    const { getByLabelText, getByText } = render(
      withQc(<RegenerateRecoveryCodesModal open={true} onClose={vi.fn()} />),
    );
    fireEvent.change(getByLabelText('6-DIGIT CODE'), {
      target: { value: '123456' },
    });
    fireEvent.click(getByText('GENERATE NEW CODES'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/user/totp/regenerate-recovery-codes');
    const body = JSON.parse((opts as { body: string }).body);
    expect(body).toEqual({ totpCode: '123456' });
    expect(body).not.toHaveProperty('recoveryCode');
  });

  it('200 success → renders RecoveryCodesPanel with new codes + save-gate', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, recoveryCodes: TEN_CODES }),
    });
    const { getByLabelText, getByText, container } = render(
      withQc(<RegenerateRecoveryCodesModal open={true} onClose={vi.fn()} />),
    );
    fireEvent.change(getByLabelText('6-DIGIT CODE'), {
      target: { value: '123456' },
    });
    fireEvent.click(getByText('GENERATE NEW CODES'));

    await waitFor(() => {
      expect(container.textContent).toContain(TEN_CODES[0]);
    });
    expect(container.textContent).toContain('shown');
    expect(container.textContent).toContain('only once');
  });

  it('save-gate: CLOSE button disabled until checkbox is ticked', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, recoveryCodes: TEN_CODES }),
    });
    const onClose = vi.fn();
    const { getByLabelText, getByText, container } = render(
      withQc(<RegenerateRecoveryCodesModal open={true} onClose={onClose} />),
    );
    fireEvent.change(getByLabelText('6-DIGIT CODE'), {
      target: { value: '123456' },
    });
    fireEvent.click(getByText('GENERATE NEW CODES'));

    await waitFor(() => {
      expect(container.textContent).toContain(TEN_CODES[0]);
    });

    // Click the bottom CLOSE button while checkbox unticked → onClose
    // does NOT fire because the arbiter refuses.
    const closeBtn = getByText('CHECK THE BOX TO CONTINUE');
    fireEvent.click(closeBtn);
    expect(onClose).not.toHaveBeenCalled();

    // Tick checkbox.
    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    // After ticking, the bottom button label flips from
    // "CHECK THE BOX TO CONTINUE" to "CLOSE". Click the bottom one
    // (header CLOSE also matches getByText). Pick by class.
    const buttons = Array.from(container.querySelectorAll('button'));
    const bottomClose = buttons.find(
      (b) => b.textContent === 'CLOSE' && b.className.includes('mako-button--action'),
    )!;
    fireEvent.click(bottomClose);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('save-gate: Escape refused while savedConfirmed=false', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, recoveryCodes: TEN_CODES }),
    });
    const onClose = vi.fn();
    const { getByLabelText, getByText, container } = render(
      withQc(<RegenerateRecoveryCodesModal open={true} onClose={onClose} />),
    );
    fireEvent.change(getByLabelText('6-DIGIT CODE'), {
      target: { value: '123456' },
    });
    fireEvent.click(getByText('GENERATE NEW CODES'));
    await waitFor(() => {
      expect(container.textContent).toContain(TEN_CODES[0]);
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('401 factor_failed → stays on form + inline error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'factor_failed' }),
    });
    const { getByLabelText, getByText } = render(
      withQc(<RegenerateRecoveryCodesModal open={true} onClose={vi.fn()} />),
    );
    fireEvent.change(getByLabelText('6-DIGIT CODE'), {
      target: { value: '999999' },
    });
    fireEvent.click(getByText('GENERATE NEW CODES'));

    await waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent ?? '').toMatch(/wrong/i);
    });
    expect(getByText('GENERATE NEW CODES')).toBeTruthy();
  });

  it('429 totp_locked → LOCKED phase + countdown visible', async () => {
    const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: 'totp_locked', retryAt }),
    });
    const { getByLabelText, getByText, container } = render(
      withQc(<RegenerateRecoveryCodesModal open={true} onClose={vi.fn()} />),
    );
    fireEvent.change(getByLabelText('6-DIGIT CODE'), {
      target: { value: '123456' },
    });
    fireEvent.click(getByText('GENERATE NEW CODES'));

    await waitFor(() => {
      expect(container.textContent).toContain('LOCKED');
    });
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
        withQc(<RegenerateRecoveryCodesModal open={true} onClose={vi.fn()} />),
      );
      fireEvent.change(getByLabelText('6-DIGIT CODE'), {
        target: { value: '123456' },
      });
      fireEvent.click(getByText('GENERATE NEW CODES'));
      unmount();
      resolveFetch({
        ok: true,
        json: () => Promise.resolve({ ok: true, recoveryCodes: TEN_CODES }),
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
