'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ICON } from '@/components/shell/icons';
import { CHECK_ICON, CLOSE_ICON, SheetFrame, sheetButton, Spinner, Svg, tileBody, tileTitle, WARN_ICON } from '@/components/ConfirmSheet';
import { FEEDBACK_MAX_CHARS, messageLength } from '@/lib/feedback';
import { closeFeedback, useFeedbackOpen } from '@/lib/feedback-store';
import { accountAddress, useUser } from '@/lib/use-user';
import { formatAddress } from '@/lib/user-display';

// Feedback (GTM plan §1). No screen in the design, so it is the confirm sheet's frame (19a) and parts: a dialog on
// desktop, a bottom sheet on mobile (yellow in dark mode). A message goes to POST /api/feedback, which forwards it to
// Telegram; the sheet says "Sent" only when the server says it was delivered, and says plainly when it was not.

const CHAT_ICON = ICON.feedback;

type Failure = { body: string; retry: boolean };
type Phase = { step: 'compose' } | { step: 'sending' } | { step: 'sent' } | { step: 'failed'; failure: Failure };

function failureFor(status: number | null, error: string | null): Failure {
  if (status === 503) return { body: 'Feedback is unavailable right now. Nothing was sent.', retry: false };
  if (status === 429) return { body: 'Too many messages. Try again later.', retry: false };
  if (status === 403) return { body: 'This page couldn’t prove the message came from Mako Market. Reload the page and try again.', retry: false };
  if (status === 400 || status === 413) {
    return { body: error === 'message_too_long' ? `Keep it to ${FEEDBACK_MAX_CHARS.toLocaleString('en-US')} characters, then send it again.` : 'That message couldn’t be sent as it is.', retry: true };
  }
  if (status === null) return { body: 'Couldn’t reach Mako Market. Check your connection and try again.', retry: true };
  return { body: 'The message wasn’t delivered. Try again in a moment.', retry: true };
}

export function FeedbackSheet() {
  return useFeedbackOpen() ? <FeedbackFlow /> : null;
}

function FeedbackFlow() {
  const { user } = useUser();
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>({ step: 'compose' });
  const desktopRef = useRef<HTMLTextAreaElement>(null);
  const mobileRef = useRef<HTMLTextAreaElement>(null);
  const sending = phase.step === 'sending';

  const close = useCallback(() => {
    if (!sending) closeFeedback();
  }, [sending]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);
  useEffect(() => {
    if (phase.step !== 'compose') return;
    (window.matchMedia('(min-width: 1024px)').matches ? desktopRef : mobileRef).current?.focus();
  }, [phase.step]);

  const n = messageLength(text);
  const ready = n > 0 && n <= FEEDBACK_MAX_CHARS;

  const send = async () => {
    if (!ready || sending) return;
    setPhase({ step: 'sending' });
    let res: Response;
    try {
      res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, path: window.location.pathname.slice(0, 200) || '/' }),
      });
    } catch {
      setPhase({ step: 'failed', failure: failureFor(null, null) });
      return;
    }
    let body: { ok?: unknown; error?: unknown } | null = null;
    try {
      body = (await res.json()) as { ok?: unknown; error?: unknown };
    } catch {
      body = null;
    }
    // "Sent" only on the route's own delivery answer: a 200 with { ok: true }. Any other 2xx (a 204, a captive
    // portal's HTML page) did not come from a delivery, so it reads as a failure.
    if (res.status === 200 && body?.ok === true) {
      setPhase({ step: 'sent' });
      return;
    }
    const error = typeof body?.error === 'string' ? body.error : null;
    setPhase({ step: 'failed', failure: failureFor(res.ok ? null : res.status, error) });
  };

  // One short line on what goes with the note (Joshua, 2026-10-07: the old copy was too much).
  const from = user
    ? `Sent with this page, your account (${formatAddress(accountAddress(user))}) and browser name. Never include codes.`
    : 'Sent with this page and your browser name. Never include codes.';
  return (
    <SheetFrame label="Send feedback" onScrim={sending ? undefined : close}>
      {(variant) => (
        <Body
          variant={variant}
          from={from}
          text={text}
          setText={setText}
          n={n}
          ready={ready}
          phase={phase}
          onSend={() => void send()}
          onEdit={() => setPhase({ step: 'compose' })}
          onClose={close}
          inputRef={variant === 'desktop' ? desktopRef : mobileRef}
        />
      )}
    </SheetFrame>
  );
}

type BodyProps = {
  variant: 'desktop' | 'mobile';
  from: string;
  text: string;
  setText: (s: string) => void;
  n: number;
  ready: boolean;
  phase: Phase;
  onSend: () => void;
  onEdit: () => void;
  onClose: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
};

function Body({ variant, from, text, setText, n, ready, phase, onSend, onEdit, onClose, inputRef }: BodyProps) {
  const sending = phase.step === 'sending';
  const over = n > FEEDBACK_MAX_CHARS;
  const disabled: React.CSSProperties = { background: 'var(--raise2)', color: 'var(--dim)', boxShadow: 'none', cursor: 'not-allowed' };
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        {!sending && (
          <button onClick={onClose} aria-label="Close" className="m3-press" style={{ width: 40, height: 40, borderRadius: 9999, background: variant === 'desktop' ? 'var(--raise)' : 'var(--raise2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Svg d={CLOSE_ICON} size={16} />
          </button>
        )}
      </div>

      {(phase.step === 'compose' || phase.step === 'sending') && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ flex: 'none', width: 56, height: 56, borderRadius: 9999, background: sending ? 'var(--raise2)' : 'var(--mako-signal)', color: sending ? 'var(--mako-canvas-fg)' : '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {sending ? <Spinner size={28} /> : <span className="mk-onsig" style={{ display: 'flex' }}><Svg d={CHAT_ICON} size={26} /></span>}
            </span>
            <div style={{ minWidth: 0 }}>
              {sending && (
                <div className="wl-eyebrow" style={{ fontSize: 14, fontWeight: 700, color: 'var(--dim)' }}>
                  Don’t close this
                </div>
              )}
              <div role={sending ? 'status' : undefined} style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: variant === 'desktop' ? 32 : 30, lineHeight: 1.05, letterSpacing: '-0.02em' }}>
                {sending ? 'Sending' : 'Send feedback'}
              </div>
            </div>
          </div>
          <div>
            <textarea
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              readOnly={sending}
              rows={5}
              aria-label="Your feedback"
              aria-invalid={over || undefined}
              placeholder="What happened, and what did you expect?"
              style={{
                display: 'block',
                width: '100%',
                boxSizing: 'border-box',
                minHeight: 132,
                resize: 'none',
                padding: '14px 16px',
                border: 0,
                outline: 0,
                borderRadius: variant === 'desktop' ? 14 : 20,
                background: 'var(--raise)',
                boxShadow: `inset 0 0 0 1.5px ${over ? 'var(--mako-red)' : n > 0 ? 'var(--mako-canvas-fg)' : 'var(--line)'}`,
                color: 'var(--mako-canvas-fg)',
                fontFamily: 'var(--mako-font-sans)',
                fontSize: 16,
                lineHeight: 1.45,
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 8, fontSize: 13, color: over ? 'var(--mako-red)' : 'var(--dim)' }}>
              <span role={over ? 'alert' : undefined}>{over ? `That’s over ${FEEDBACK_MAX_CHARS.toLocaleString('en-US')} characters.` : from}</span>
              <span style={{ flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
                {n.toLocaleString('en-US')} / {FEEDBACK_MAX_CHARS.toLocaleString('en-US')}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} disabled={sending} className="m3-press" style={{ ...sheetButton(false), flex: 'none', width: 112 }}>
              Cancel
            </button>
            <button onClick={onSend} disabled={!ready || sending} className="m3-press mk-onsig" style={{ ...sheetButton(true), ...(ready && !sending ? null : disabled) }}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </>
      )}

      {phase.step === 'sent' && (
        <>
          <div className="wl-tile" style={{ borderRadius: 28, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: '18px 18px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={{ width: 52, height: 52, borderRadius: 9999, background: 'var(--m3-inv-fg)', color: 'var(--m3-inv)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Svg d={CHECK_ICON} size={26} />
            </span>
            <div role="status">
              <div style={tileTitle}>Sent</div>
              <div style={tileBody}>Thanks. Mako Market has your message.</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} className="m3-press mk-onsig" style={sheetButton(true)}>
              Done
            </button>
          </div>
        </>
      )}

      {phase.step === 'failed' && (
        <>
          <div role="alert" className="wl-tile" style={{ borderRadius: 28, background: 'var(--mako-red)', color: '#000', boxShadow: 'inset 0 0 0 2px #000', padding: '18px 18px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={{ width: 52, height: 52, borderRadius: 9999, background: '#000', color: 'var(--mako-red)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Svg d={WARN_ICON} size={24} />
            </span>
            <div>
              <div style={tileTitle}>Not sent</div>
              <div style={tileBody}>{phase.failure.body}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {phase.failure.retry ? (
              <>
                <button onClick={onClose} className="m3-press" style={sheetButton(false)}>
                  Close
                </button>
                <button onClick={onEdit} className="m3-press mk-onsig" style={sheetButton(true)}>
                  Try again
                </button>
              </>
            ) : (
              <button onClick={onClose} className="m3-press mk-onsig" style={sheetButton(true)}>
                Close
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
