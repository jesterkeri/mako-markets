'use client';

import { openFeedback } from '@/lib/feedback-store';

import { ICON, StrokeIcon } from './icons';

/// Desktop only: a small "Feedback" pill fixed in the bottom-right corner, in the desktop's pill-control style (mono
/// label, hairline). The shell leaves room under the status strip so it never sits on the page's last line. Mobile has
/// no floating button (it would cover the tab bar); Me and the menu carry a Feedback row instead.
export function FeedbackButton() {
  return (
    <button
      type="button"
      onClick={openFeedback}
      className="mk-press97"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 40,
        height: 34,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 14px 0 12px',
        borderRadius: 9999,
        background: 'var(--mako-canvas)',
        color: 'var(--mako-canvas-fg)',
        boxShadow: 'var(--edge), inset 0 0 0 1px var(--line), 0 8px 24px rgba(0,0,0,0.25)',
        fontFamily: 'var(--mako-font-mono)',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.08em',
      }}
    >
      <StrokeIcon d={ICON.feedback} size={14} />
      FEEDBACK
    </button>
  );
}
