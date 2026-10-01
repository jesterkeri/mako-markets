'use client';

// Presentation shared by the two-factor dialogs (TotpEnrollmentModal, TotpDisableModal, RegenerateRecoveryCodesModal)
// in the sign-in dialog's look (14a, its two-step step): a centred dialog on desktop, a bottom sheet on mobile, both
// themes through tokens (see `.mk-2fa*` in mako-shell.css). Nothing here holds state or makes a request: the dialogs
// keep all of their logic and pass it in.

export const CLOSE_ICON = 'M7 7l10 10M17 7L7 17';

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };

export function Icon({ d, size }: { d: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/// The lead paragraph under a title.
export const lead: React.CSSProperties = { margin: 0, fontSize: 15, lineHeight: 1.5, color: 'var(--dim)' };

/// A small mono label above a field (the desktop terminal look).
export const fieldLabel: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--dim)' };

/// An error or status line under a field.
export const alertLine: React.CSSProperties = { margin: 0, fontSize: 13, lineHeight: 1.45, color: 'var(--mako-red)' };

/// The full-width yellow action (the sign-in dialog's big button); grey and inert while it cannot be used.
export function primaryButton(enabled: boolean): React.CSSProperties {
  return {
    width: '100%',
    height: 56,
    border: 0,
    borderRadius: 9999,
    background: enabled ? 'var(--mako-signal)' : 'var(--raise2)',
    color: enabled ? '#000' : 'var(--dim)',
    boxShadow: enabled ? 'var(--edge)' : 'none',
    ...display,
    fontSize: 17,
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}

/// A secondary pill (copy, download, cancel).
export function secondaryButton(enabled = true): React.CSSProperties {
  return {
    height: 44,
    padding: '0 18px',
    border: 0,
    borderRadius: 9999,
    background: 'var(--raise2)',
    color: 'var(--mako-canvas-fg)',
    fontFamily: 'var(--mako-font-mono)',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.06em',
    opacity: enabled ? 1 : 0.5,
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}

/// A text field (a recovery code, the shown secret) in the sign-in dialog's input style.
export function textField(invalid: boolean): React.CSSProperties {
  return {
    width: '100%',
    height: 56,
    boxSizing: 'border-box',
    padding: '0 18px',
    border: 0,
    outline: 0,
    background: 'var(--raise)',
    boxShadow: `inset 0 0 0 1.5px ${invalid ? 'var(--mako-red)' : 'var(--line)'}`,
    color: 'var(--mako-canvas-fg)',
    fontFamily: 'var(--mako-font-mono)',
    fontSize: 17,
  };
}

/// The six boxes of a code over the real input, as in the sign-in dialog: the input (passed as children) stays the
/// element people type into, paste into and autofill; the boxes only draw what it holds.
export function CodeBoxes({ value, invalid, children }: { value: string; invalid: boolean; children: React.ReactNode }) {
  return (
    <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          aria-hidden="true"
          className="mk-2fa-box"
          style={{
            background: 'var(--raise)',
            boxShadow: `inset 0 0 0 1.5px ${invalid ? 'var(--mako-red)' : i === value.length ? 'var(--mako-canvas-fg)' : 'var(--line)'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            ...display,
            fontSize: 26,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value[i] ?? ''}
        </div>
      ))}
      {children}
    </div>
  );
}

/// The style the real input takes inside CodeBoxes: it covers the boxes, invisible, so a tap anywhere focuses it.
export const overlayInput: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, border: 0, padding: 0, fontSize: 16, cursor: 'text' };

/// "Locked": too many wrong codes, with the countdown the dialog keeps.
export function LockedNote({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" style={{ borderRadius: 14, padding: '14px 16px', background: 'color-mix(in srgb, var(--mako-red) 12%, transparent)', boxShadow: 'inset 0 0 0 1.5px var(--mako-red)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <p style={{ margin: 0, ...fieldLabel, color: 'var(--mako-red)' }}>LOCKED</p>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.45 }}>{children}</p>
    </div>
  );
}
