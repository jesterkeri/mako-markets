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
// What's NOT covered (deferred):
//   - End-to-end fetch wiring inside SignupPage's handleSubmitTotp.
//     That handler reads/writes router.replace, queryClient,
//     wagmi.disconnect — exercised by manual smoke. Pin in a
//     follow-up if a contract regression slips through smoke.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

import {
  TotpStep,
  formatLockoutRemaining,
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
