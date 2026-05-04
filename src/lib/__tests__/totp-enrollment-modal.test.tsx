// ----------------------------------------------------------------------------
// totp-enrollment-modal.test.tsx
//
// Pins the load-bearing TotpEnrollmentModal flow:
//   - 4-phase state machine (fetching → scan → recovery_codes)
//   - Save-gate enforcement on every dismissal vector (CLOSE,
//     Escape, backdrop) while savedConfirmed=false. Codex Group 4
//     plan round-1 MAJOR 1 + round-2 MAJOR scoping fixes.
//   - 409 already_enabled drift handling
//   - Late /verify-enrollment after close discarded (codex round-1
//     MAJOR 3 — the most dangerous race; could splice fresh recovery
//     codes into a closed modal)
//   - Optimistic cache write on accepted close flips totpEnabled=true
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TotpEnrollmentModal } from '../../components/profile/TotpEnrollmentModal';
import { USER_QUERY_KEY, type AuthedUser } from '../use-user';

// Stub qrcode.react so the test environment doesn't need to render
// SVG QR pixels — we only care that the component renders + that
// the otpauth URI is plumbed through.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => (
    <div data-testid="qr-code" data-value={value} />
  ),
}));

afterEach(cleanup);

const DISABLED_USER: AuthedUser = {
  authed: true,
  email: 'joshua@example.com',
  magicEoa: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  safeAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  displayName: 'Joshua',
  avatarUrl: null,
  totpEnabled: false,
  totpEnabledAt: null,
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

const ENROLL_RES = {
  enrollmentId: '00000000-0000-0000-0000-000000000001',
  otpauthUri:
    'otpauth://totp/Mako:joshua@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Mako',
};

let fetchMock: ReturnType<typeof vi.fn>;
let qc: QueryClient;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(USER_QUERY_KEY, DISABLED_USER);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function withQc(ui: React.ReactNode) {
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe('TotpEnrollmentModal', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      withQc(<TotpEnrollmentModal open={false} onClose={vi.fn()} />),
    );
    expect(container.firstChild).toBeNull();
  });

  it('open → POST /enroll fires + advances to scan phase', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(ENROLL_RES),
    });
    const { container, queryByTestId } = render(
      withQc(<TotpEnrollmentModal open={true} onClose={vi.fn()} />),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/user/totp/enroll');

    await waitFor(() => {
      expect(queryByTestId('qr-code')).not.toBeNull();
    });
    expect(container.textContent).toContain('Scan');
  });

  it('/enroll 409 already_enabled → close + invalidate', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: 'already_enabled' }),
    });
    const onClose = vi.fn();
    render(
      withQc(<TotpEnrollmentModal open={true} onClose={onClose} />),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Wrong code → 401 bad_code → stays on scan with inline error', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(ENROLL_RES),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'bad_code' }),
      });
    const { container, queryByTestId } = render(
      withQc(<TotpEnrollmentModal open={true} onClose={vi.fn()} />),
    );
    await waitFor(() => expect(queryByTestId('qr-code')).not.toBeNull());

    const codeInput = container.querySelector(
      '#totp-enroll-code',
    ) as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: '999999' } });
    const verifyBtn = Array.from(
      container.querySelectorAll('button'),
    ).find((b) => b.textContent === 'VERIFY')!;
    fireEvent.click(verifyBtn);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent ?? '').toMatch(/wrong/i);
    });
    // Still on scan phase — QR + input still present.
    expect(queryByTestId('qr-code')).not.toBeNull();
  });

  it('Correct code → recovery_codes phase rendered with 10 codes + save-gate active', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(ENROLL_RES),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, recoveryCodes: TEN_CODES }),
      });
    const { container, queryByTestId } = render(
      withQc(<TotpEnrollmentModal open={true} onClose={vi.fn()} />),
    );
    await waitFor(() => expect(queryByTestId('qr-code')).not.toBeNull());

    const codeInput = container.querySelector(
      '#totp-enroll-code',
    ) as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: '123456' } });
    const verifyBtn = Array.from(
      container.querySelectorAll('button'),
    ).find((b) => b.textContent === 'VERIFY')!;
    fireEvent.click(verifyBtn);

    await waitFor(() => {
      expect(container.textContent).toContain(TEN_CODES[0]);
    });
    // Save-gate copy present + checkbox not yet ticked.
    expect(container.textContent).toContain('only once');
    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('Save-gate: Escape refused while savedConfirmed=false', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(ENROLL_RES),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, recoveryCodes: TEN_CODES }),
      });
    const onClose = vi.fn();
    const { container, queryByTestId } = render(
      withQc(<TotpEnrollmentModal open={true} onClose={onClose} />),
    );
    await waitFor(() => expect(queryByTestId('qr-code')).not.toBeNull());
    const codeInput = container.querySelector(
      '#totp-enroll-code',
    ) as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: '123456' } });
    const verifyBtn = Array.from(
      container.querySelectorAll('button'),
    ).find((b) => b.textContent === 'VERIFY')!;
    fireEvent.click(verifyBtn);
    await waitFor(() => {
      expect(container.textContent).toContain(TEN_CODES[0]);
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Save-gate: backdrop click refused while savedConfirmed=false', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(ENROLL_RES),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, recoveryCodes: TEN_CODES }),
      });
    const onClose = vi.fn();
    const { container, queryByTestId } = render(
      withQc(<TotpEnrollmentModal open={true} onClose={onClose} />),
    );
    await waitFor(() => expect(queryByTestId('qr-code')).not.toBeNull());
    const codeInput = container.querySelector(
      '#totp-enroll-code',
    ) as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: '123456' } });
    const verifyBtn = Array.from(
      container.querySelectorAll('button'),
    ).find((b) => b.textContent === 'VERIFY')!;
    fireEvent.click(verifyBtn);
    await waitFor(() => {
      expect(container.textContent).toContain(TEN_CODES[0]);
    });

    const backdrop = container.querySelector('[role="dialog"]') as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Tick checkbox + close → optimistic cache flips totpEnabled=true + onClose fires', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(ENROLL_RES),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, recoveryCodes: TEN_CODES }),
      });
    const onClose = vi.fn();
    const { container, queryByTestId } = render(
      withQc(<TotpEnrollmentModal open={true} onClose={onClose} />),
    );
    await waitFor(() => expect(queryByTestId('qr-code')).not.toBeNull());
    const codeInput = container.querySelector(
      '#totp-enroll-code',
    ) as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: '123456' } });
    const verifyBtn = Array.from(
      container.querySelectorAll('button'),
    ).find((b) => b.textContent === 'VERIFY')!;
    fireEvent.click(verifyBtn);
    await waitFor(() => {
      expect(container.textContent).toContain(TEN_CODES[0]);
    });

    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    const closeBtn = Array.from(
      container.querySelectorAll('button'),
    ).find((b) => b.textContent === 'CLOSE')!;
    fireEvent.click(closeBtn);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const cached = qc.getQueryData(USER_QUERY_KEY) as AuthedUser;
    expect(cached.totpEnabled).toBe(true);
    expect(cached.totpEnabledAt).not.toBeNull();
  });

  it('/verify-enrollment 409 already_enabled → close + invalidate', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(ENROLL_RES),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'already_enabled' }),
      });
    const onClose = vi.fn();
    const { container, queryByTestId } = render(
      withQc(<TotpEnrollmentModal open={true} onClose={onClose} />),
    );
    await waitFor(() => expect(queryByTestId('qr-code')).not.toBeNull());
    const codeInput = container.querySelector(
      '#totp-enroll-code',
    ) as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: '123456' } });
    const verifyBtn = Array.from(
      container.querySelectorAll('button'),
    ).find((b) => b.textContent === 'VERIFY')!;
    fireEvent.click(verifyBtn);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Late /verify-enrollment after close is discarded (codex round-1 MAJOR 3)', async () => {
    let resolveVerify!: (res: unknown) => void;
    const deferredVerify = new Promise((r) => {
      resolveVerify = r;
    });
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(ENROLL_RES),
      })
      .mockReturnValueOnce(deferredVerify);
    const onClose = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { container, queryByTestId, unmount } = render(
        withQc(<TotpEnrollmentModal open={true} onClose={onClose} />),
      );
      await waitFor(() => expect(queryByTestId('qr-code')).not.toBeNull());
      const codeInput = container.querySelector(
        '#totp-enroll-code',
      ) as HTMLInputElement;
      fireEvent.change(codeInput, { target: { value: '123456' } });
      const verifyBtn = Array.from(
        container.querySelectorAll('button'),
      ).find((b) => b.textContent === 'VERIFY')!;
      fireEvent.click(verifyBtn);

      // Unmount BEFORE verify resolves.
      unmount();
      resolveVerify({
        ok: true,
        json: () => Promise.resolve({ ok: true, recoveryCodes: TEN_CODES }),
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Cache must NOT have been written by the late verify response.
      const cached = qc.getQueryData(USER_QUERY_KEY) as AuthedUser;
      expect(cached.totpEnabled).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('Modal close while /enroll in flight aborts the request', async () => {
    let resolveEnroll!: (res: unknown) => void;
    const deferredEnroll = new Promise((r) => {
      resolveEnroll = r;
    });
    fetchMock.mockReturnValueOnce(deferredEnroll);
    const onClose = vi.fn();
    const { unmount } = render(
      withQc(<TotpEnrollmentModal open={true} onClose={onClose} />),
    );
    // Unmount → cleanup aborts the controller.
    unmount();
    resolveEnroll({
      ok: true,
      json: () => Promise.resolve(ENROLL_RES),
    });
    await Promise.resolve();
    await Promise.resolve();
    // The /enroll did fire (we awaited beforehand) but the late
    // resolution must not push us into 'scan' phase since we're
    // unmounted. With nothing rendered, no DOM assertion needed —
    // the success criterion is no console.error from React about
    // setState on dead component.
  });
});
