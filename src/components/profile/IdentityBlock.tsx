'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { AvatarCircle } from '@/components/AvatarCircle';
import {
  EmailUpdateNotSupported,
  updateEmailWithMagic,
} from '@/lib/magic-browser';
import { USER_QUERY_KEY, type AuthedUser } from '@/lib/use-user';

// ----------------------------------------------------------------------------
// IdentityBlock
//
// The /profile identity surface for both Magic-authed and wallet-only
// sessions. Magic users see:
//   - Hero row: AvatarCircle + display name (or email fallback)
//   - SIGNED IN AS: email + EDIT (subject to 365-day cooldown)
//   - DISPLAY NAME: edit / clear, validated client-side mirroring
//     /api/user/profile/update server regex
//   - AVATAR: image upload (PNG/JPG/WEBP, ≤4 MB) → server resizes to
//     256×256 webp and stores in Vercel Blob. REMOVE clears the field.
//   - LAST SIGN-IN line + recovery copy
//
// Wallet-only users see a stripped-down version: address + format,
// no edit affordances. Mirrors /profile's existing isMagicUser
// branching.
//
// Async safety (Group 4 plan invariant): every fetch uses a mounted
// ref guard + AbortController so a late response after route
// navigation / component unmount cannot setState on a dead
// component. The COPIED!-style transient flags also clear on
// unmount.
//
// Display name validation: `/^[A-Za-z0-9 ._-]{1,32}$/` after trim.
// Avatar upload: client-side reject for size > 4 MB or non-allow-listed
// MIME (PNG / JPG / WEBP); server re-validates with sharp.metadata().
// ----------------------------------------------------------------------------

type IdentityBlockProps = {
  user: AuthedUser | null;
  connectedWallet: `0x${string}` | undefined;
};

type EmailEditPhase = 'closed' | 'open' | 'updating' | 'unsupported';
type FieldPhase = 'idle' | 'editing' | 'submitting';

const DISPLAY_NAME_RE = /^[A-Za-z0-9 ._-]{1,32}$/;
const AVATAR_MAX_BYTES = 4 * 1024 * 1024;
const AVATAR_MIME_ALLOW = new Set(['image/png', 'image/jpeg', 'image/webp']);

function formatAddress(address: string | undefined): string {
  if (!address) return '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function validateDisplayName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Display name cannot be empty.';
  if (!DISPLAY_NAME_RE.test(trimmed)) {
    return 'Use letters, numbers, space, dot, underscore, or dash. Max 32.';
  }
  return null;
}

export function IdentityBlock({ user, connectedWallet }: IdentityBlockProps) {
  const queryClient = useQueryClient();
  const isMagicUser = !!user;

  // Mount + cancellation discipline. Per-field controllers so that
  // submitting one field doesn't abort an in-flight submit of another
  // (codex round-1 MAJOR: a shared controller would leave the
  // first field stuck in 'submitting' when its catch suppresses the
  // AbortError early-return).
  const mountedRef = useRef(true);
  const displayCtrlRef = useRef<AbortController | null>(null);
  const avatarCtrlRef = useRef<AbortController | null>(null);
  const emailCtrlRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      displayCtrlRef.current?.abort();
      avatarCtrlRef.current?.abort();
      emailCtrlRef.current?.abort();
    };
  }, []);

  // ── Email change state ─────────────────────────────────────────────────
  const [emailEdit, setEmailEdit] = useState<EmailEditPhase>('closed');
  const [newEmailInput, setNewEmailInput] = useState('');
  const [emailEditError, setEmailEditError] = useState('');

  // /api/user/me only returns nextEmailChangeAvailableAt when a
  // cooldown is currently active (it computes Date.now() < cooldownEnd
  // server-side and returns null otherwise). Trusting that contract
  // here keeps render pure — no client-side clock comparison needed.
  // If the cooldown elapses while the page is open, the next /me
  // refetch flips this back to null and the EDIT button re-enables.
  const emailChangeAvailableAt = user?.nextEmailChangeAvailableAt ?? null;
  const emailChangeLocked = !!emailChangeAvailableAt;
  const emailChangeAvailableLabel = emailChangeAvailableAt
    ? new Date(emailChangeAvailableAt).toLocaleDateString()
    : '';

  function handleStartEditEmail() {
    setEmailEditError('');
    setNewEmailInput('');
    setEmailEdit('open');
  }

  function handleCancelEditEmail() {
    setEmailEdit('closed');
    setNewEmailInput('');
    setEmailEditError('');
  }

  async function handleSubmitEditEmail() {
    setEmailEditError('');
    const trimmed = newEmailInput.trim();
    if (!trimmed || !trimmed.includes('@')) {
      setEmailEditError('Enter a valid email address.');
      return;
    }
    if (user && trimmed.toLowerCase() === user.email.toLowerCase()) {
      setEmailEditError('That is already your email.');
      return;
    }

    setEmailEdit('updating');
    emailCtrlRef.current?.abort();
    const ctrl = new AbortController();
    emailCtrlRef.current = ctrl;
    try {
      const { didToken } = await updateEmailWithMagic({ newEmail: trimmed });
      if (!mountedRef.current) return;

      const res = await fetch('/api/user/email/update', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ didToken }),
        signal: ctrl.signal,
      });
      if (!mountedRef.current) return;

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          availableAt?: string;
        };
        if (!mountedRef.current) return;
        if (body.error === 'email_taken') {
          setEmailEditError('That email is already in use by another account.');
        } else if (body.error === 'not_allowlisted') {
          setEmailEditError(
            'That email is not on the beta allowlist. Pick a different address or contact support.',
          );
        } else if (body.error === 'eoa_mismatch') {
          setEmailEditError(
            "Magic returned a different wallet than expected. We didn't update anything. Please refresh and try again.",
          );
        } else if (body.error === 'cooldown_active') {
          const when = body.availableAt
            ? new Date(body.availableAt).toLocaleDateString()
            : 'later';
          setEmailEditError(
            `You can only change your email once per year. Try again on ${when}.`,
          );
        } else {
          setEmailEditError(
            'Email update failed. Please refresh and try again.',
          );
        }
        setEmailEdit('open');
        return;
      }

      await queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
      if (!mountedRef.current) return;
      handleCancelEditEmail();
    } catch (e) {
      if (!mountedRef.current) return;
      if (e instanceof EmailUpdateNotSupported) {
        setEmailEdit('unsupported');
        return;
      }
      console.error('Email change failed', e);
      setEmailEditError(
        'Magic could not complete the change. If you closed the modal, try again.',
      );
      setEmailEdit('open');
    }
  }

  // ── Display name state ─────────────────────────────────────────────────
  const [displayPhase, setDisplayPhase] = useState<FieldPhase>('idle');
  const [displayInput, setDisplayInput] = useState('');
  const [displayError, setDisplayError] = useState('');

  function handleStartEditDisplay() {
    setDisplayInput(user?.displayName ?? '');
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
      // Functional cache update (codex round-1 MINOR 2): merge into
      // the latest ['user'] snapshot, not the user prop captured in
      // closure. Concurrent updates from another tab / refetch /
      // sibling field write would otherwise be clobbered.
      queryClient.setQueryData<AuthedUser>(USER_QUERY_KEY, (old) =>
        old && old.authed
          ? { ...old, displayName: body.displayName ?? null }
          : old,
      );
      await queryClient.invalidateQueries({ queryKey: USER_QUERY_KEY });
      if (!mountedRef.current) return;
      handleCancelEditDisplay();
    } catch (e) {
      // AbortError from a sibling submit shouldn't leave this field
      // stuck in 'submitting' — if WE were the aborter, the new
      // controller would still be ours; if a sibling aborted us
      // (shouldn't happen now that controllers are per-field, but
      // defense-in-depth), drop back to 'editing' so the user can
      // retry.
      if ((e as Error).name === 'AbortError') {
        if (mountedRef.current && displayCtrlRef.current === ctrl) {
          setDisplayPhase('editing');
        }
        return;
      }
      if (!mountedRef.current) return;
      console.error('[identity-block] display name update failed', e);
      setDisplayError('Network error. Please retry.');
      setDisplayPhase('editing');
    }
  }

  // ── Avatar state ──────────────────────────────────────────────────────
  // Two distinct in-flight states: `uploading` for POST /avatar/upload
  // (multipart), `removing` for POST /profile/update with avatarUrl: null.
  // They could share a single 'busy' phase, but the button labels differ
  // and a clearer state machine is cheaper than mapping a generic flag
  // back to copy at render time.
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
    // Reset so picking the same file twice in a row still fires change.
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
      console.error('[identity-block] avatar upload failed', err);
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
      console.error('[identity-block] avatar clear failed', err);
      setAvatarError('Network error. Please retry.');
      setAvatarPhase('idle');
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  // Wallet-only branch: short-circuit to the existing copy. Magic
  // identity edit affordances stay hidden because the backend routes
  // require a Magic session (getUserSession returns 401 otherwise).
  if (!isMagicUser) {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="mako-label text-muted">SIGNED IN AS</h2>
        <p className="mako-title text-xl break-all leading-tight">
          {formatAddress(connectedWallet)}
        </p>
        <p className="mako-body text-[11px] text-muted leading-snug mt-1">
          You are signed in with an external wallet. Identity controls are
          available for email-authenticated accounts.
        </p>
      </div>
    );
  }

  // Magic branch.
  const hero = user!;
  const displayLabel =
    hero.displayName && hero.displayName.trim().length > 0
      ? hero.displayName
      : hero.email;

  return (
    <div className="flex flex-col gap-6">
      {/* Hero row */}
      <div className="flex items-center gap-4">
        <AvatarCircle
          displayName={hero.displayName}
          email={hero.email}
          magicEoa={hero.magicEoa}
          avatarUrl={hero.avatarUrl}
          size={64}
        />
        <div className="flex-1 min-w-0">
          <p className="mako-title text-2xl leading-tight truncate">
            {displayLabel}
          </p>
          <p className="mako-mono text-xs text-muted truncate">
            {hero.email}
          </p>
        </div>
      </div>

      {/* SIGNED IN AS / email row */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center">
          <h3 className="mako-label text-muted">SIGNED IN AS</h3>
          {emailEdit === 'closed' && !emailChangeLocked && (
            <button
              type="button"
              onClick={handleStartEditEmail}
              className="mako-label text-[10px] text-ink opacity-60 hover:opacity-100 hover:underline transition-opacity"
            >
              EDIT
            </button>
          )}
          {emailEdit === 'closed' && emailChangeLocked && (
            <span
              className="mako-label text-[10px] text-muted"
              title={`Next change available ${emailChangeAvailableLabel}`}
            >
              LOCKED
            </span>
          )}
        </div>
        <p className="mako-body text-base break-all leading-tight">
          {hero.email}
        </p>

        {emailEdit === 'open' && (
          <div className="mt-3 flex flex-col gap-2 bg-paper p-3 rounded-xl border-2 border-ink">
            <label className="mako-label text-[10px] text-ink">NEW EMAIL</label>
            <input
              type="email"
              value={newEmailInput}
              onChange={(e) => setNewEmailInput(e.target.value)}
              placeholder="you@example.com"
              className="mako-input mako-mono text-sm bg-white"
              autoFocus
            />
            <div className="bg-mako-red/10 border-2 border-mako-red p-3 rounded-lg flex gap-2 items-start mt-1">
              <svg
                className="w-5 h-5 text-mako-red shrink-0 mt-0.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
              <p className="mako-label text-[10px] text-ink leading-snug">
                YOU CAN ONLY CHANGE YOUR EMAIL ONCE PER YEAR. AFTER UPDATING,
                THE NEXT CHANGE WILL BE LOCKED FOR 365 DAYS. MAKE SURE YOU
                CAN ACCESS THE NEW ADDRESS AND HAVE 2FA ENABLED ON IT.
              </p>
            </div>
            {emailEditError && (
              <p
                role="alert"
                className="mako-body text-xs font-medium text-mako-red"
              >
                {emailEditError}
              </p>
            )}
            <div className="flex gap-2 mt-1">
              <button
                type="button"
                onClick={handleSubmitEditEmail}
                className="mako-button mako-label text-[10px] flex-1 sm:flex-initial"
              >
                UPDATE EMAIL
              </button>
              <button
                type="button"
                onClick={handleCancelEditEmail}
                className="mako-button mako-button--ghost mako-label text-[10px] flex-1 sm:flex-initial"
              >
                CANCEL
              </button>
            </div>
            <p className="mako-body text-[10px] text-muted leading-snug mt-1">
              Magic will email a code to your new address to confirm. Your
              wallet address stays the same.
            </p>
          </div>
        )}

        {emailEdit === 'updating' && (
          <div className="mt-3 flex flex-col gap-2 bg-paper p-3 rounded-xl border-2 border-ink">
            <p className="mako-body text-sm text-ink">
              Updating email through Magic. Check the new address for an OTP.
            </p>
          </div>
        )}

        {emailEdit === 'unsupported' && (
          <div className="mt-3 flex flex-col gap-2 bg-paper p-3 rounded-xl border-2 border-mako-red">
            <p className="mako-body text-sm text-ink">
              Email change is not available in this app. To use a different
              address, contact support and we will help you migrate your funds.
            </p>
            <button
              type="button"
              onClick={() => setEmailEdit('closed')}
              className="mako-button mako-button--ghost mako-label text-[10px] self-start"
            >
              DISMISS
            </button>
          </div>
        )}

        {emailEdit === 'closed' && (
          <div className="flex flex-col gap-1 mt-1">
            <p className="mako-label text-[9px] text-muted">
              LAST SIGN-IN:{' '}
              {hero.lastSignInAt
                ? new Date(hero.lastSignInAt).toLocaleString()
                : 'First sign-in'}
            </p>
            {emailChangeLocked && (
              <p className="mako-label text-[9px] text-mako-red">
                NEXT EMAIL CHANGE: {emailChangeAvailableLabel}
              </p>
            )}
            <p className="mako-body text-[11px] text-muted leading-snug mt-1 max-w-md">
              If you lose access to this email, account recovery is managed
              through{' '}
              <a
                href="https://magic.link"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-ink"
              >
                Magic
              </a>
              . Mako Market cannot recover your funds.
            </p>
          </div>
        )}
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
              {hero.displayName ? 'EDIT' : 'SET'}
            </button>
          )}
        </div>
        {displayPhase === 'idle' && (
          <p className="mako-body text-base break-all leading-tight">
            {hero.displayName ?? (
              <span className="text-muted italic">Not set</span>
            )}
          </p>
        )}
        {displayPhase !== 'idle' && (
          <div className="mt-1 flex flex-col gap-2 bg-paper p-3 rounded-xl border-2 border-ink">
            <label className="mako-label text-[10px] text-ink" htmlFor="display-name-input">
              NEW DISPLAY NAME
            </label>
            <input
              id="display-name-input"
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
              {hero.displayName && (
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

      {/* AVATAR row — file upload */}
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
              : hero.avatarUrl
                ? 'REPLACE IMAGE'
                : 'UPLOAD IMAGE'}
          </button>
          {hero.avatarUrl && (
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
