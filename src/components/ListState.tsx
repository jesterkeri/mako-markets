'use client';

import Link from 'next/link';

import { Mascot } from '@/components/Mascot';
import { listStateCopy, type ListAction, type ListKind } from '@/lib/list-states';

type Props = {
  kind: ListKind;
  state: 'loading' | 'empty' | 'error' | 'not_open';
  /// Called by "Try again" on an error.
  onRetry?: () => void;
  /// The account's explorer page, offered on Me's error.
  explorerHref?: string;
};

const bar = 'color-mix(in srgb, var(--mako-canvas-fg) 16%, transparent)';

function ActionButton({ action, onRetry, style, className }: { action: ListAction; onRetry?: () => void; style: React.CSSProperties; className: string }) {
  if ('comingSoon' in action) {
    return (
      <button disabled aria-disabled="true" className={className} style={{ ...style, opacity: 0.55, cursor: 'not-allowed' }}>
        {action.label} · coming soon
      </button>
    );
  }
  if ('retry' in action) {
    return (
      <button onClick={onRetry} className={className} style={style}>
        {action.label}
      </button>
    );
  }
  return action.external ? (
    <a href={action.href} target="_blank" rel="noopener noreferrer" className={className} style={{ ...style, textDecoration: 'none' }}>
      {action.label}
    </a>
  ) : (
    <Link href={action.href} className={className} style={{ ...style, textDecoration: 'none' }}>
      {action.label}
    </Link>
  );
}

/// Empty, loading and error for a list, desktop (16a): skeletons shaped like the real rows, never a bare spinner.
export function ListStateDesktop({ kind, state, onRetry, explorerHref }: Props) {
  if (state === 'loading') {
    return (
      <div aria-busy="true" aria-label="Loading">
        <div style={{ fontFamily: 'var(--mako-font-mono)', fontSize: 11, color: 'var(--dim)', padding: '0 4px 8px' }}>LOADING…</div>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px minmax(0,1fr) 180px 220px 90px', gap: 20, alignItems: 'center', padding: '18px 4px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
            <div style={{ width: 60, height: 18, borderRadius: 8, background: bar }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ width: '70%', height: 16, borderRadius: 8, background: bar }} />
              <div style={{ width: '40%', height: 11, borderRadius: 8, background: bar }} />
            </div>
            <div style={{ width: 110, height: 24, borderRadius: 999, background: bar }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ width: '100%', height: 12, borderRadius: 8, background: bar }} />
              <div style={{ width: '100%', height: 4, borderRadius: 999, background: bar }} />
            </div>
            <div style={{ width: 40, height: 16, borderRadius: 8, background: bar }} />
          </div>
        ))}
      </div>
    );
  }
  const c = listStateCopy(kind, state, explorerHref);
  const button: React.CSSProperties = { height: 52, display: 'inline-flex', alignItems: 'center', padding: '0 24px', borderRadius: 9999, fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 16 };
  return (
    <div role={state === 'error' ? 'alert' : undefined} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '64px 4px 72px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <Mascot pose={c.pose} motion={c.motion} alt="" style={{ height: 190, width: 'auto', marginTop: -24 }} />
      <div style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 36, letterSpacing: '-0.02em', marginTop: 22 }}>{c.title}</div>
      <div style={{ fontSize: 16, lineHeight: 1.55, color: 'var(--dim)', marginTop: 10, maxWidth: 520 }}>{c.body}</div>
      <div style={{ display: 'flex', gap: 10, marginTop: 26 }}>
        <ActionButton action={c.primary} onRetry={onRetry} className="mk-press97" style={{ ...button, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)' }} />
        <ActionButton action={c.secondary} onRetry={onRetry} className="mk-press97" style={{ ...button, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)' }} />
      </div>
      {c.footer && <div style={{ fontFamily: 'var(--mako-font-mono)', fontSize: 12, color: 'var(--dim)', marginTop: 18 }}>{c.footer}</div>}
    </div>
  );
}

/// Empty, loading and error for a list, mobile (16a): an inverse hero card, or card-shaped skeletons.
export function ListStateMobile({ kind, state, onRetry, explorerHref }: Props) {
  if (state === 'loading') {
    return (
      <div aria-busy="true" aria-label="Loading" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '18px 12px 0' }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ borderRadius: 30, background: 'var(--raise)', padding: 18 }}>
            <div style={{ width: '40%', height: 14, borderRadius: 999, background: bar }} />
            <div style={{ height: 12 }} />
            <div style={{ width: '85%', height: 20, borderRadius: 8, background: bar }} />
            <div style={{ height: 8 }} />
            <div style={{ width: '60%', height: 20, borderRadius: 8, background: bar }} />
            <div style={{ height: 16 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ width: '50%', height: 52, borderRadius: 20, background: bar }} />
              <div style={{ width: '50%', height: 52, borderRadius: 20, background: bar }} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  const c = listStateCopy(kind, state, explorerHref);
  const full: React.CSSProperties = { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9999, fontWeight: 800 };
  return (
    <div style={{ padding: '18px 12px 0' }}>
      <div role={state === 'error' ? 'alert' : undefined} style={{ borderRadius: 32, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: '22px 20px 18px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '10px 4px 4px' }}>
          <Mascot pose={c.pose} motion={c.motion} alt="" style={{ height: 160, width: 'auto' }} />
          <div style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 26, lineHeight: 1.1, letterSpacing: '-0.02em', marginTop: 18 }}>{c.title}</div>
          <div style={{ fontSize: 15, lineHeight: 1.5, opacity: 0.72, marginTop: 8 }}>{c.body}</div>
          <ActionButton action={c.primary} onRetry={onRetry} className="m3-press" style={{ ...full, height: 54, marginTop: 18, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', fontSize: 16 }} />
          <ActionButton action={c.secondary} onRetry={onRetry} className="m3-press" style={{ ...full, height: 50, marginTop: 8, background: 'var(--m3-inv-2)', color: 'var(--m3-inv-fg)', fontSize: 15 }} />
          {c.footer && <div style={{ fontSize: 13, opacity: 0.6, marginTop: 12 }}>{c.footer}</div>}
        </div>
      </div>
    </div>
  );
}
