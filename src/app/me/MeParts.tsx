'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { chartGeometry, type MePosition, type MeRange, type ProfitSeries } from '@/lib/me-stats';
import { STATE_PILL, type PoolState } from '@/lib/pool-list';
import type { AuthedUser } from '@/lib/use-user';

import type { Labels, MeChain } from './use-me-data';
import type { ProfileEdit } from './use-profile-edit';

// What Me's desktop and mobile layouts share: the view model, and the small pieces both draw.

export const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
export const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
export const BAR = 'color-mix(in srgb, var(--mako-canvas-fg) 16%, transparent)';

export type Loadable<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T };

export type MeTab = 'active' | 'settled';

/// One row of "Ready to claim": still claimable, or claimed from this page a moment ago.
export type ClaimItem = { p: MePosition; landed: boolean };

export type MeView = {
  user: AuthedUser;
  account: `0x${string}`;
  /// The display name, or null when none is set.
  name: string | null;
  /// How the account shows up to others: the name, or the short address.
  label: string;
  initial: string;
  emailAccount: boolean;
  balance: Loadable<bigint>;
  chain: MeChain;
  /// Ready to claim, from the positions still claimable (minus any claimed here since the last read).
  ready: Loadable<bigint>;
  claimItems: ClaimItem[];
  pendingClaims: number;
  /// Nothing left to claim but something was claimed before: "Everything claimed".
  allClaimed: boolean;
  series: ProfitSeries | null;
  now: number | null;
  labelsOf: (p: MePosition) => Labels;
  range: MeRange;
  setRange: (r: MeRange) => void;
  tab: MeTab;
  setTab: (t: MeTab) => void;
  openClaim: (p: MePosition) => void;
  retry: () => void;
  explorerHref: string;
  edit: ProfileEdit;
  editing: boolean;
  draft: string;
  setDraft: (s: string) => void;
  startEdit: () => void;
  cancelEdit: () => void;
  saveDraft: () => void;
  photoOpen: boolean;
  setPhotoOpen: (b: boolean) => void;
};

export const poolHref = (id: bigint) => `/pools/${id}`;
/// Until the redesigned create flow (10a) replaces it, creating a pool opens the current form.
export const CREATE_HREF = '/create';
/// Settings (21a) is not built; the existing profile page holds the account settings until it is.
export const SETTINGS_HREF = '/profile';

export const PENCIL = 'M4 16.5V20h3.5L18 9.5 14.5 6 4 16.5zM13 7.5l3.5 3.5';

export function Svg({ d, size, strokeWidth = 1.75 }: { d: string; size: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/// The avatar's face: the uploaded photo over the letter, the letter alone if the photo fails to load.
export function AvatarFace({ url, initial }: { url: string | null; initial: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <>
      {initial}
      {url && failedUrl !== url && (
        // A plain <img>, as elsewhere: avatars are single-origin Vercel Blob URLs, and next/image buys nothing here.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} />
      )}
    </>
  );
}

/// A Copy button for the account address: "Copied" once the clipboard took it.
export function CopyButton({ text, style, className, children }: { text: string; style: React.CSSProperties; className?: string; children?: (copied: boolean) => React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" onClick={copy} className={className} style={style}>
      {children ? children(copied) : copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/// The profit line (11a): evenly spaced settled pools, yellow above zero and red below, a dot on the latest.
export function ProfitChart({ points, height }: { points: readonly bigint[]; height: number }) {
  const gid = `mePnl${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const g = chartGeometry(points);
  return (
    <div style={{ position: 'relative', height }}>
      <svg viewBox="0 0 600 140" preserveAspectRatio="none" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
        <line x1="0" x2="600" y1={g.zeroY} y2={g.zeroY} strokeDasharray="4 5" vectorEffect="non-scaling-stroke" style={{ stroke: 'var(--line)' }} />
        <defs>
          <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="140">
            <stop offset={g.zeroOffset} style={{ stopColor: 'var(--mako-signal)' }} />
            <stop offset={g.zeroOffset} style={{ stopColor: 'var(--mako-red)' }} />
          </linearGradient>
        </defs>
        <path d={g.area} fill={`url(#${gid})`} fillOpacity={0.16} />
        <path d={g.line} fill="none" stroke={`url(#${gid})`} strokeWidth={2.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <span
        aria-hidden="true"
        style={{ position: 'absolute', left: '100%', top: `${g.endYPct}%`, width: 10, height: 10, margin: '-5px 0 0 -5px', borderRadius: '50%', background: g.endNegative ? 'var(--mako-red)' : 'var(--mako-signal)', boxShadow: '0 0 0 3px var(--mako-canvas)' }}
      />
    </div>
  );
}

/// "7 DAYS AGO", "30 DAYS AGO", or for All the first settled pool's close date ("FIRST CLOSE SEP 12").
export function rangeStart(range: MeRange, firstClose: number | null): string {
  if (range === '7d') return '7 DAYS AGO';
  if (range === '30d') return '30 DAYS AGO';
  if (firstClose === null) return 'ALL TIME';
  return `FIRST CLOSE ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(firstClose * 1000)).toUpperCase()}`;
}

/// The side pill for a position: the side held, or "Both".
export function sideOf(p: MePosition, labels: Labels): { text: string; bg: string; fg: string } {
  const yes = p.bet.yes > 0n;
  const no = p.bet.no > 0n;
  if (yes && no) return { text: 'Both', bg: 'var(--raise2)', fg: 'var(--mako-canvas-fg)' };
  return yes ? { text: labels.yes, bg: 'var(--mako-signal)', fg: '#000' } : { text: labels.no, bg: 'var(--mako-red)', fg: '#000' };
}

export function statePill(s: PoolState): { label: string; bg: string } {
  return s === 'open' ? { label: 'Open', bg: 'var(--mako-signal)' } : STATE_PILL[s];
}

/// Why a pool is in Ready to claim: "YES won" (or the house pool's own name), or a refund.
export function claimWhy(p: MePosition, labels: Labels): string {
  if (p.state === 'refunded') return 'Refund · pool refunded';
  return `${p.state === 'yes_won' ? labels.yes : labels.no} won`;
}

export function resultColour(p: MePosition): string {
  const k = p.settlement?.kind;
  return k === 'won' ? 'var(--up-text)' : k === 'lost' ? 'var(--mako-red)' : 'var(--mako-canvas-fg)';
}

/// A small modal on mobile (name, photo): closes on the scrim and on Escape.
export function MobileDialog({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div onClick={onClose} className="mk-scrim" style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.5)' }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="mk-pop"
        style={{ position: 'fixed', top: 120, left: 12, right: 12, zIndex: 61, borderRadius: 32, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge), 0 24px 60px rgba(0,0,0,0.5)', padding: 20 }}
      >
        {children}
      </div>
    </>
  );
}
