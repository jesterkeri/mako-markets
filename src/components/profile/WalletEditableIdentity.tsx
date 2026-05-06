'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { USER_QUERY_KEY, type AuthedUser, type WalletAuthedUser } from '@/lib/use-user';

// ----------------------------------------------------------------------------
// WalletEditableIdentity
//
// /profile identity surface for wallet-authed sessions. Three rows:
//   1. WALLET ADDRESS (read-only) — formatted address + COPY.
//   2. DISPLAY NAME — same edit / clear UX as the Magic flow,
//      validated client-side mirroring /api/user/profile/update's
//      server regex.
//   3. AVATAR — same upload / remove UX (PNG/JPG/WEBP, ≤4 MB).
//
// Wallet sessions have no email row, no TOTP, and a different recovery
// blurb (seed phrase, not Magic email). The display-name + avatar
// routes already return the discriminated wire shape — same fetch path
// as the Magic-user implementation; only the response narrows differ.
//
// Async safety mirrors IdentityBlock: per-field AbortController + a
// mounted ref so a late response after route navigation cannot
// setState on a dead component.
// ----------------------------------------------------------------------------

const DISPLAY_NAME_RE = /^[A-Za-z0-9 ._-]{1,32}$/;
const AVATAR_MAX_BYTES = 4 * 1024 * 1024;
const AVATAR_MIME_ALLOW = new Set(['image/png', 'image/jpeg', 'image/webp']);

type FieldPhase = 'idle' | 'editing' | 'submitting';

function formatAddress(addr: string | undefined): string {
  if (!addr) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function validateDisplayName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Display name cannot be empty.';
  if (!DISPLAY_NAME_RE.test(trimmed)) {
    return 'Use letters, numbers, space, dot, underscore, or dash. Max 32.';
  }
  return null;
}

export function WalletEditableIdentity({ user }: { user: WalletAuthedUser }) {
  const queryClient = useQueryClient();

  // Mount + cancellation discipline. Per-field controllers so a
  // submitting display-name update doesn't abort an in-flight avatar
  // upload (and vice versa).
  const mountedRef = useRef(true);
  const displayCtrlRef = useRef<AbortController | null>(null);
  const avatarCtrlRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      displayCtrlRef.current?.abort();
      avatarCtrlRef.current?.abort();
    };
  }, []);

  // ── COPY transient ─────────────────────────────────────────────────────
  // Codex round-12 MINOR fix: only flip to COPIED! AFTER the clipboard
  // promise resolves. The earlier shape set `copied = true` regardless
  // of whether `writeText` rejected (e.g. denied permissions in
  // restricted contexts), so a user could see COPIED! and paste a
  // STALE clipboard value into a faucet/exchange. False success on an
  // address-copy affordance is worse than silent failure — surface
  // either COPY FAILED (so the user knows to try the manual selection
  // path) or stay on COPY (so they retry).
  type CopyState = 'idle' | 'copied' | 'failed';
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);
  async function handleCopyAddress() {
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    try {
      await navigator.clipboard.writeText(user.walletAddress);
      if (!mountedRef.current) return;
      setCopyState('copied');
    } catch {
      if (!mountedRef.current) return;
      setCopyState('failed');
    }
    copyTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) setCopyState('idle');
    }, 2000);
  }

  // ── Display name state ────────────────────────────────────────────────
  const [displayPhase, setDisplayPhase] = useState<FieldPhase>('idle');
  const [displayInput, setDisplayInput] = useState('');
  const [displayError, setDisplayError] = useState('');

  function handleStartEditDisplay() {
    setDisplayInput(user.displayName ?? '');
    setDisplayError('');
    setDisplayPhase('editing');
  }

  function handleCancelEditDisplay() {
    setDisplayPhase('idle');
    setDisplayInput('');
    setDisplayError('');
  }

  async function handleSubmitDisplay(value: string | null) {
    setDisplayError('');
    if (value !== null) {
      const err = validateDisplayName(value);
      if (err) {
        setDisplayError(err);
        return;
      }
    }
    setDisplayPhase('submitting');
    displayCtrlRef.current?.abort();
    const ctrl = new AbortController();
    displayCtrlRef.current = ctrl;

    try {
      const res = await fetch('/api/user/profile/update', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: value === null ? null : value.trim(),
        }),
        signal: ctrl.signal,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setDisplayError(
          res.status === 400
            ? 'Display name was rejected. Try a shorter / simpler value.'
            : 'Update failed. Please retry.',
        );
        setDisplayPhase('editing');
        return;
      }
      const body = (await res.json()) as Partial<AuthedUser>;
      if (!mountedRef.current) return;
      // Functional cache update: merge into the latest ['user'] snapshot
      // so a concurrent refetch / sibling write doesn't get clobbered.
      queryClient.setQueryData<AuthedUser>(USER_QUERY_KEY, (old) =>
        old && old.authed
          ? { ...old, displayName: body.displayName ?? null }
          : old,
      );
      await queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
      if (!mountedRef.current) return;
      handleCancelEditDisplay();
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (mountedRef.current && displayCtrlRef.current === ctrl) {
          setDisplayPhase('editing');
        }
        return;
      }
      if (!mountedRef.current) return;
      console.error('[wallet-identity] display name update failed', e);
      setDisplayError('Network error. Please retry.');
      setDisplayPhase('editing');
    }
  }

  // ── Avatar state ──────────────────────────────────────────────────────
  type AvatarPhase = 'idle' | 'uploading' | 'removing';
  const [avatarPhase, setAvatarPhase] = useState<AvatarPhase>('idle');
  const [avatarError, setAvatarError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handlePickFile() {
    setAvatarError('');
    fileInputRef.current?.click();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.size === 0) {
      setAvatarError('Image is empty.');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError('Image too large. Max 4 MB.');
      return;
    }
    if (!AVATAR_MIME_ALLOW.has(file.type)) {
      setAvatarError('Use PNG, JPG, or WEBP.');
      return;
    }

    setAvatarPhase('uploading');
    avatarCtrlRef.current?.abort();
    const ctrl = new AbortController();
    avatarCtrlRef.current = ctrl;

    const fd = new FormData();
    fd.append('avatar', file);

    try {
      const res = await fetch('/api/user/avatar/upload', {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
        signal: ctrl.signal,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setAvatarError(
          res.status === 400 ? 'Image rejected. Try a different file.'
          : res.status === 401 ? 'Sign-in expired. Please refresh.'
          : res.status === 502 ? 'Upload service unavailable. Retry shortly.'
          : 'Upload failed. Please retry.',
        );
        setAvatarPhase('idle');
        return;
      }
      const body = (await res.json()) as Partial<AuthedUser>;
      if (!mountedRef.current) return;
      queryClient.setQueryData<AuthedUser>(USER_QUERY_KEY, (old) =>
        old && old.authed
          ? { ...old, avatarUrl: body.avatarUrl ?? null }
          : old,
      );
      await queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
      if (!mountedRef.current) return;
      setAvatarPhase('idle');
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (mountedRef.current && avatarCtrlRef.current === ctrl) {
          setAvatarPhase('idle');
        }
        return;
      }
      if (!mountedRef.current) return;
      console.error('[wallet-identity] avatar upload failed', err);
      setAvatarError('Network error. Please retry.');
      setAvatarPhase('idle');
    }
  }

  async function handleClearAvatar() {
    setAvatarError('');
    setAvatarPhase('removing');
    avatarCtrlRef.current?.abort();
    const ctrl = new AbortController();
    avatarCtrlRef.current = ctrl;

    try {
      const res = await fetch('/api/user/profile/update', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ avatarUrl: null }),
        signal: ctrl.signal,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setAvatarError('Clear failed. Please retry.');
        setAvatarPhase('idle');
        return;
      }
      queryClient.setQueryData<AuthedUser>(USER_QUERY_KEY, (old) =>
        old && old.authed ? { ...old, avatarUrl: null } : old,
      );
      await queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
      if (!mountedRef.current) return;
      setAvatarPhase('idle');
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (mountedRef.current && avatarCtrlRef.current === ctrl) {
          setAvatarPhase('idle');
        }
        return;
      }
      if (!mountedRef.current) return;
      console.error('[wallet-identity] avatar clear failed', err);
      setAvatarError('Network error. Please retry.');
      setAvatarPhase('idle');
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">
      {/* WALLET ADDRESS row (read-only) */}
      <div className="flex flex-col gap-1">
        <h3 className="mako-label text-muted">WALLET ADDRESS</h3>
        <div className="flex gap-2 mt-1">
          <code className="mako-mono text-sm bg-surface-elevated border-2 border-ink px-3 py-3 flex-1 flex items-center justify-center shadow-inner">
            {formatAddress(user.walletAddress)}
          </code>
          <button
            type="button"
            onClick={handleCopyAddress}
            className="mako-button mako-label px-4! shrink-0"
          >
            {copyState === 'copied'
              ? 'COPIED!'
              : copyState === 'failed'
                ? 'COPY FAILED'
                : 'COPY'}
          </button>
        </div>
        <p className="mako-label text-[9px] text-muted mt-1">
          LAST SIGN-IN:{' '}
          {user.lastSignInAt
            ? new Date(user.lastSignInAt).toLocaleString()
            : 'First sign-in'}
        </p>
        <p className="mako-body text-[11px] text-muted leading-snug mt-1 max-w-md">
          If you lose access to this wallet, Mako Market cannot recover
          your funds. Treat your seed phrase as your master password.
        </p>
      </div>

      {/* DISPLAY NAME row */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center">
          <h3 className="mako-label text-muted">DISPLAY NAME</h3>
          {displayPhase === 'idle' && (
            <button
              type="button"
              onClick={handleStartEditDisplay}
              className="mako-label text-[10px] text-ink opacity-60 hover:opacity-100 hover:underline transition-opacity"
            >
              {user.displayName ? 'EDIT' : 'SET'}
            </button>
          )}
        </div>
        {displayPhase === 'idle' && (
          <p className="mako-body text-base break-all leading-tight">
            {user.displayName ?? (
              <span className="text-muted italic">Not set</span>
            )}
          </p>
        )}
        {displayPhase !== 'idle' && (
          <div className="mt-1 flex flex-col gap-2 bg-paper p-3 rounded-xl border-2 border-ink">
            <label
              className="mako-label text-[10px] text-ink"
              htmlFor="wallet-display-name-input"
            >
              NEW DISPLAY NAME
            </label>
            <input
              id="wallet-display-name-input"
              type="text"
              value={displayInput}
              onChange={(e) => setDisplayInput(e.target.value)}
              placeholder="Your name"
              className="mako-input mako-mono text-sm bg-white"
              maxLength={32}
              disabled={displayPhase === 'submitting'}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleSubmitDisplay(displayInput);
                }
              }}
            />
            {displayError && (
              <p
                role="alert"
                className="mako-body text-xs font-medium text-mako-red"
              >
                {displayError}
              </p>
            )}
            <div className="flex gap-2 mt-1 flex-wrap">
              <button
                type="button"
                onClick={() => void handleSubmitDisplay(displayInput)}
                disabled={displayPhase === 'submitting'}
                className="mako-button mako-label text-[10px] flex-1 sm:flex-initial"
              >
                {displayPhase === 'submitting' ? 'SAVING…' : 'SAVE'}
              </button>
              <button
                type="button"
                onClick={handleCancelEditDisplay}
                disabled={displayPhase === 'submitting'}
                className="mako-button mako-button--ghost mako-label text-[10px] flex-1 sm:flex-initial"
              >
                CANCEL
              </button>
              {user.displayName && (
                <button
                  type="button"
                  onClick={() => void handleSubmitDisplay(null)}
                  disabled={displayPhase === 'submitting'}
                  className="mako-button mako-button--ghost mako-label text-[10px] text-mako-red"
                >
                  CLEAR
                </button>
              )}
            </div>
            <p className="mako-body text-[10px] text-muted leading-snug mt-1">
              Letters, numbers, space, dot, underscore, dash. Up to 32
              characters.
            </p>
          </div>
        )}
      </div>

      {/* AVATAR row */}
      <div className="flex flex-col gap-2">
        <h3 className="mako-label text-muted">AVATAR</h3>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => void handleFileChange(e)}
          className="hidden"
          disabled={avatarPhase !== 'idle'}
          aria-label="Upload avatar image"
        />
        <div className="flex flex-wrap gap-2 items-center">
          <button
            type="button"
            onClick={handlePickFile}
            disabled={avatarPhase !== 'idle'}
            className="mako-button mako-label text-[10px]"
          >
            {avatarPhase === 'uploading'
              ? 'UPLOADING…'
              : user.avatarUrl
                ? 'REPLACE IMAGE'
                : 'UPLOAD IMAGE'}
          </button>
          {user.avatarUrl && (
            <button
              type="button"
              onClick={() => void handleClearAvatar()}
              disabled={avatarPhase !== 'idle'}
              className="mako-button mako-button--ghost mako-label text-[10px] text-mako-red"
            >
              {avatarPhase === 'removing' ? 'REMOVING…' : 'REMOVE'}
            </button>
          )}
        </div>
        {avatarError && (
          <p
            role="alert"
            className="mako-body text-xs font-medium text-mako-red"
          >
            {avatarError}
          </p>
        )}
        <p className="mako-body text-[10px] text-muted leading-snug">
          PNG, JPG, or WEBP up to 4 MB. Server resizes to 256×256.
        </p>
      </div>
    </div>
  );
}
