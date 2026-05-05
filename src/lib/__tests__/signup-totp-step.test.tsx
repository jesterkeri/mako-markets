// ----------------------------------------------------------------------------
// signup-totp-step.test.tsx
//
// Pins the contract for the /signup TOTP step UI. Targets TotpStep
// directly (re-exported from src/app/signup/page.tsx) so tests
// don't need to mock Magic SDK / wagmi / next/navigation just to
// reach the second-factor branch.
//
// What's covered (Group 5B critical paths):
//   - input phase fires onSubmit with the typed code, in both modes
//   - inline error renders when state.error is non-null
//   - onToggleMode is invoked by the toggle button
//   - lockedUntil renders LOCKED + countdown text instead of the input
//   - terminal=challenge_invalid / eoa_drift hides input + shows
//     restart UI; clicking restart calls onRestart
//   - formatLockoutRemaining math: 0:00 floor, MM:SS pad
//
//   - mapTotpResponse: pure response→next-state mapping that
//     SignupPage.handleSubmitTotp delegates to. Covers every branch
//     of the route's response shape — totp_locked / challenge_invalid
//     / eoa_drift / totp_failed / generic-failure / 2xx-success — so
//     a route-side discriminator rename can't slip past type-checking
//     into manual smoke.
//
// What's still NOT covered:
//   - The success-side effects (wagmi.disconnect, addRecentEmail,
//     queryClient.setQueryData, router.replace) called by
//     SignupPage.handleSubmitTotp on a 2xx outcome. Those are wagmi
//     /next.js boundaries and are exercised by manual smoke. The
//     mapping test below pins the *decision* to fire them; the
//     wiring itself is a separate boundary.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

import {
  TotpStep,
  formatLockoutRemaining,
  mapTotpResponse,
  type TotpRequiredState,
} from '../../components/signup/TotpStep';

const BASE_STATE: TotpRequiredState = {
  kind: 'totp_required',
  challengeId: '00000000-0000-0000-0000-000000000001',
  mode: 'totp',
  submitting: false,
  error: null,
  lockedUntil: null,
  terminal: null,
};

describe('formatLockoutRemaining', () => {
  it('renders MM:SS with zero-padded seconds', () => {
    const now = 0;
    expect(formatLockoutRemaining(0, now)).toBe('0:00');
    expect(formatLockoutRemaining(5_000, now)).toBe('0:05');
    expect(formatLockoutRemaining(65_000, now)).toBe('1:05');
    expect(formatLockoutRemaining(15 * 60 * 1000, now)).toBe('15:00');
  });

  it('caps at 0:00 when lockedUntil already elapsed', () => {
    expect(formatLockoutRemaining(1_000, 5_000)).toBe('0:00');
    expect(formatLockoutRemaining(0, Date.now())).toBe('0:00');
  });
});

describe('TotpStep — input mode', () => {
  it('renders the 6-digit input + verify button when mode is totp', () => {
    const { container, getByText } = render(
      <TotpStep
        state={BASE_STATE}
        onSubmit={() => {}}
        onToggleMode={() => {}}
        onRestart={() => {}}
      />,
    );
    expect(container.querySelector('#totp-signin-code')).not.toBeNull();
    expect(getByText('VERIFY CODE')).toBeTruthy();
  });

  it('renders the recovery input + button when mode is recovery', () => {
    const recoveryState: TotpRequiredState = { ...BASE_STATE, mode: 'recovery' };
    const { container, getByText } = render(
      <TotpStep
        state={recoveryState}
        onSubmit={() => {}}
        onToggleMode={() => {}}
        onRestart={() => {}}
      />,
    );
    expect(container.querySelector('#totp-signin-recovery')).not.toBeNull();
    expect(getByText('USE RECOVERY CODE')).toBeTruthy();
    // 6-digit input must be unmounted in recovery mode so a stale
    // numeric value doesn't get sent on toggle.
    expect(container.querySelector('#totp-signin-code')).toBeNull();
  });

  it('VERIFY CODE click invokes onSubmit with the typed value', () => {
    const onSubmit = vi.fn();
    const { container, getByText } = render(
      <TotpStep
        state={BASE_STATE}
        onSubmit={onSubmit}
        onToggleMode={() => {}}
        onRestart={() => {}}
      />,
    );
    const input = container.querySelector(
      '#totp-signin-code',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(getByText('VERIFY CODE'));
    expect(onSubmit).toHaveBeenCalledWith('123456');
  });

  it('Enter key on the input invokes onSubmit', () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <TotpStep
        state={BASE_STATE}
        onSubmit={onSubmit}
        onToggleMode={() => {}}
        onRestart={() => {}}
      />,
    );
    const input = container.querySelector(
      '#totp-signin-code',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '654321' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('654321');
  });

  it('inline error renders when state.error is set', () => {
    const errored: TotpRequiredState = {
      ...BASE_STATE,
      error: 'That code is wrong. Try a fresh one from your authenticator.',
    };
    const { getByRole } = render(
      <TotpStep
        state={errored}
        onSubmit={() => {}}
        onToggleMode={() => {}}
        onRestart={() => {}}
      />,
    );
    expect(getByRole('alert').textContent).toContain('That code is wrong');
  });

  it('toggle button invokes onToggleMode', () => {
    const onToggleMode = vi.fn();
    const { getByText } = render(
      <TotpStep
        state={BASE_STATE}
        onSubmit={() => {}}
        onToggleMode={onToggleMode}
        onRestart={() => {}}
      />,
    );
    fireEvent.click(getByText(/recovery code/i));
    expect(onToggleMode).toHaveBeenCalledTimes(1);
  });

  it('disables submit + input + toggle while submitting=true', () => {
    const submitting: TotpRequiredState = { ...BASE_STATE, submitting: true };
    const { container, getByText } = render(
      <TotpStep
        state={submitting}
        onSubmit={() => {}}
        onToggleMode={() => {}}
        onRestart={() => {}}
      />,
    );
    const input = container.querySelector(
      '#totp-signin-code',
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    const verifyBtn = getByText('VERIFYING…') as HTMLButtonElement;
    expect(verifyBtn.disabled).toBe(true);
  });
});

describe('TotpStep — locked', () => {
  it('hides the input and renders LOCKED + countdown when lockedUntil is set', () => {
    const locked: TotpRequiredState = {
      ...BASE_STATE,
      lockedUntil: Date.now() + 14 * 60 * 1000 + 30 * 1000,
    };
    const { container, getByRole } = render(
      <TotpStep
        state={locked}
        onSubmit={() => {}}
        onToggleMode={() => {}}
        onRestart={() => {}}
      />,
    );
    expect(container.querySelector('#totp-signin-code')).toBeNull();
    expect(container.querySelector('#totp-signin-recovery')).toBeNull();
    const status = getByRole('status');
    expect(status.textContent).toContain('LOCKED');
    expect(status.textContent).toMatch(/1[34]:\d\d/);
  });
});

describe('TotpStep — terminal', () => {
  it('renders RESTART SIGN-IN when terminal=challenge_invalid', () => {
    const dead: TotpRequiredState = {
      ...BASE_STATE,
      terminal: 'challenge_invalid',
    };
    const onRestart = vi.fn();
    const { container, getByText, getByRole } = render(
      <TotpStep
        state={dead}
        onSubmit={() => {}}
        onToggleMode={() => {}}
        onRestart={onRestart}
      />,
    );
    expect(container.querySelector('#totp-signin-code')).toBeNull();
    expect(getByRole('alert').textContent).toContain('expired');
    fireEvent.click(getByText('RESTART SIGN-IN'));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('renders eoa-drift copy when terminal=eoa_drift', () => {
    const dead: TotpRequiredState = {
      ...BASE_STATE,
      terminal: 'eoa_drift',
    };
    const { getByRole } = render(
      <TotpStep
        state={dead}
        onSubmit={() => {}}
        onToggleMode={() => {}}
        onRestart={() => {}}
      />,
    );
    expect(getByRole('alert').textContent).toContain('Account state changed');
  });
});

describe('mapTotpResponse — handler-level response mapping', () => {
  const baseTotp: TotpRequiredState = {
    kind: 'totp_required',
    challengeId: '00000000-0000-0000-0000-000000000001',
    mode: 'totp',
    submitting: true,
    error: null,
    lockedUntil: null,
    terminal: null,
  };
  const baseRecovery: TotpRequiredState = { ...baseTotp, mode: 'recovery' };

  it('200 with authed body → success outcome', () => {
    expect(mapTotpResponse(baseTotp, 200, { authed: true } as never)).toEqual({
      kind: 'success',
    });
  });

  // The mapper itself treats any 2xx as success, but the call site in
  // SignupPage.handleSubmitTotp parses res.json() BEFORE invoking the
  // mapper. A 204 (no body) would short-circuit at JSON parse and
  // surface "Unexpected response" instead of reaching the mapper, so
  // the route is effectively pinned to 200 with a body in production.
  // We deliberately do NOT pin a "204 → success" expectation here —
  // see comment.

  it('429 totp_locked + retryAt ISO → lockedUntil set, error cleared', () => {
    const retryAt = '2026-05-05T12:34:56.000Z';
    const out = mapTotpResponse(baseTotp, 429, {
      error: 'totp_locked',
      retryAt,
    });
    expect(out.kind).toBe('state');
    if (out.kind !== 'state') return;
    expect(out.next.lockedUntil).toBe(Date.parse(retryAt));
    expect(out.next.submitting).toBe(false);
    expect(out.next.error).toBeNull();
    expect(out.next.terminal).toBeNull();
  });

  it('429 totp_locked with unparseable retryAt → lockedUntil null (not NaN)', () => {
    const out = mapTotpResponse(baseTotp, 429, {
      error: 'totp_locked',
      retryAt: 'not-a-date',
    });
    expect(out.kind).toBe('state');
    if (out.kind !== 'state') return;
    expect(out.next.lockedUntil).toBeNull();
  });

  it('429 totp_locked with no retryAt → falls through to generic failure', () => {
    const out = mapTotpResponse(baseTotp, 429, { error: 'totp_locked' });
    expect(out.kind).toBe('state');
    if (out.kind !== 'state') return;
    expect(out.next.error).toBe('Sign-in failed. Please retry.');
    expect(out.next.lockedUntil).toBeNull();
  });

  it('401 challenge_invalid → terminal=challenge_invalid', () => {
    const out = mapTotpResponse(baseTotp, 401, { error: 'challenge_invalid' });
    expect(out.kind).toBe('state');
    if (out.kind !== 'state') return;
    expect(out.next.terminal).toBe('challenge_invalid');
    expect(out.next.submitting).toBe(false);
    expect(out.next.error).toBeNull();
  });

  it('401 eoa_drift → terminal=eoa_drift', () => {
    const out = mapTotpResponse(baseTotp, 401, { error: 'eoa_drift' });
    expect(out.kind).toBe('state');
    if (out.kind !== 'state') return;
    expect(out.next.terminal).toBe('eoa_drift');
  });

  it('401 totp_failed in TOTP mode → authenticator-specific copy', () => {
    const out = mapTotpResponse(baseTotp, 401, { error: 'totp_failed' });
    expect(out.kind).toBe('state');
    if (out.kind !== 'state') return;
    expect(out.next.error).toContain('authenticator');
    expect(out.next.terminal).toBeNull();
    expect(out.next.lockedUntil).toBeNull();
  });

  it('401 totp_failed in recovery mode → recovery-code-specific copy', () => {
    const out = mapTotpResponse(baseRecovery, 401, { error: 'totp_failed' });
    expect(out.kind).toBe('state');
    if (out.kind !== 'state') return;
    expect(out.next.error).toContain('recovery');
  });

  it('401 with unknown error → generic failure', () => {
    const out = mapTotpResponse(baseTotp, 401, { error: 'something_else' });
    expect(out.kind).toBe('state');
    if (out.kind !== 'state') return;
    expect(out.next.error).toBe('Sign-in failed. Please retry.');
  });

  it('500 with no body → generic failure', () => {
    const out = mapTotpResponse(baseTotp, 500, null);
    expect(out.kind).toBe('state');
    if (out.kind !== 'state') return;
    expect(out.next.error).toBe('Sign-in failed. Please retry.');
  });

  it('all error branches set submitting=false (caller can re-enable input)', () => {
    const cases: Array<[number, { error: string; retryAt?: string } | null]> = [
      [429, { error: 'totp_locked', retryAt: '2026-05-05T00:00:00Z' }],
      [401, { error: 'challenge_invalid' }],
      [401, { error: 'eoa_drift' }],
      [401, { error: 'totp_failed' }],
      [401, { error: 'unknown' }],
      [500, null],
    ];
    for (const [status, body] of cases) {
      const out = mapTotpResponse(baseTotp, status, body);
      expect(out.kind).toBe('state');
      if (out.kind !== 'state') continue;
      expect(out.next.submitting).toBe(false);
    }
  });
});
