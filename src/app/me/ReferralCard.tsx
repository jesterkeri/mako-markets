'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';

import { COMPETITION_COPY, referralProgress, type ReferrerError } from '@/lib/competition/config';
import { referralCode, referralLink } from '@/lib/ref-tag';

import { CopyButton, display, mono } from './MeParts';

const COPY = COMPETITION_COPY.card;
const KEY = ['user', 'referrals'] as const;

interface Referrals {
  joined: number;
  qualified: number;
  canAddInviter: boolean;
}

/// "Invite friends" (REFERRAL_COMPETITION_PLAN r1 + owner changes 2026-10-23): the invite link as the main button, the
/// code beneath it with its own Copy for a friend on another device, how many signed up with either and how many of
/// them bet, and, while the account may still take one, a field for the friend's code that invited this account.
export function ReferralCard({ account, variant }: { account: `0x${string}`; variant: 'desktop' | 'mobile' }) {
  const desk = variant === 'desktop';
  const code = referralCode(account);
  const { data } = useQuery<Referrals>({
    queryKey: KEY,
    queryFn: async () => {
      const res = await fetch('/api/user/referrals');
      if (!res.ok) throw new Error(`referrals ${res.status}`);
      return (await res.json()) as Referrals;
    },
    staleTime: 60_000,
  });
  const progress = data ? referralProgress(data.joined, data.qualified) : null;
  const pill: React.CSSProperties = { height: desk ? 48 : 44, borderRadius: 9999, ...display, fontSize: desk ? 15 : 14, display: 'flex', alignItems: 'center', justifyContent: 'center' };
  return (
    <div style={desk ? { padding: '16px 18px', borderRadius: 14, background: 'var(--raise)', boxShadow: 'var(--edge)' } : { margin: '10px 16px 0', padding: '14px 18px', borderRadius: 28, background: 'var(--raise)', boxShadow: 'var(--edge)' }}>
      <div style={{ ...display, fontSize: desk ? 20 : 16 }}>{COPY.title}</div>
      <div style={{ fontSize: 13, color: 'var(--dim)', marginTop: 4 }}>{COPY.body}</div>
      <CopyButton text={referralLink(account)} className="mk-press97" style={{ ...pill, width: '100%', marginTop: 12, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)' }}>
        {(copied) => (copied ? COPY.copied : COPY.copy)}
      </CopyButton>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <span style={{ ...mono, fontSize: 12, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{code}</span>
        <CopyButton text={code} style={{ flex: 'none', height: 32, padding: '0 12px', borderRadius: 9999, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', ...mono, fontSize: 11, fontWeight: 700 }}>
          {(copied) => (copied ? COPY.copied : COPY.copyCode)}
        </CopyButton>
      </div>
      <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 4 }}>{COPY.codeHint}</div>
      {progress && (
        <div style={{ fontSize: 13, marginTop: 10 }}>
          <div>{progress.joined}</div>
          <div>{progress.qualified}</div>
          <div style={{ fontWeight: 700, marginTop: 2 }}>{progress.entered ? COPY.entered : COPY.notEntered}</div>
        </div>
      )}
      <Link href="/leaderboard/competition" style={{ display: 'inline-block', marginTop: 10, ...mono, fontSize: 12, fontWeight: 700, color: 'inherit' }}>
        {COPY.rules}
      </Link>
      {data?.canAddInviter && <InviterField />}
    </div>
  );
}

/// The one-time field for the code of the friend who invited this account (POST /api/user/referrer).
function InviterField() {
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  // Desktop and mobile are both mounted (the shell switches them by width), so each field needs its own id.
  const id = useId();
  const save = useMutation({
    mutationFn: async (code: string) => {
      const res = await fetch('/api/user/referrer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      if (res.ok) return;
      const err = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
      throw new Error(err && err in COMPETITION_COPY.referrerErrors ? err : 'unavailable');
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
  const error = save.error ? COMPETITION_COPY.referrerErrors[save.error.message as ReferrerError] : null;
  // The card can sit in a capped scroll column (MeDesktop): bring each refusal into view, since focus stays on Add.
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (save.error) alertRef.current?.scrollIntoView({ block: 'nearest' });
  }, [save.error]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) save.mutate(value.trim());
      }}
      style={{ marginTop: 12, paddingTop: 12, boxShadow: 'inset 0 1px 0 var(--line)' }}
    >
      <label htmlFor={id} style={{ display: 'block', fontSize: 13, fontWeight: 700 }}>
        {COPY.enterLabel}
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <input
          id={id}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="r-…"
          style={{ flex: 1, minWidth: 0, height: 40, padding: '0 12px', borderRadius: 9999, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', ...mono, fontSize: 16 }}
        />
        <button type="submit" disabled={save.isPending || !value.trim()} style={{ flex: 'none', height: 40, padding: '0 16px', borderRadius: 9999, background: 'var(--mako-canvas-fg)', color: 'var(--mako-canvas)', ...display, fontSize: 14, opacity: save.isPending ? 0.6 : 1 }}>
          {COPY.enterSubmit}
        </button>
      </div>
      {error && (
        <div ref={alertRef} role="alert" style={{ fontSize: 13, color: 'var(--mako-red)', marginTop: 6 }}>
          {error}
        </div>
      )}
    </form>
  );
}
