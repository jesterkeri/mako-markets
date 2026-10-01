'use client';

import { useEffect, useRef, useState } from 'react';

import {
  formatRecoveryCodesForCopy,
  formatRecoveryCodesForDownload,
} from '@/lib/recovery-codes-export';

// ----------------------------------------------------------------------------
// RecoveryCodesPanel
//
// Pure display + COPY ALL + DOWNLOAD .txt for a 10-code batch. Used by
// TotpEnrollmentModal (final phase) and RegenerateRecoveryCodesModal
// (post-regenerate). The panel is unaware of the required-save
// checkbox — the parent modal owns that gate so it can refuse all
// dismissal paths uniformly (codex round-1 MAJOR 1).
//
// COPY / DOWNLOAD content is built in src/lib/recovery-codes-export.ts
// (pure, unit-testable). The DOM plumbing — clipboard.writeText, Blob
// + anchor click, COPIED!-flash timer cleanup — is covered by
// recovery-codes-panel.test.tsx under happy-dom.
// ----------------------------------------------------------------------------

type RecoveryCodesPanelProps = {
  codes: string[];
};

export function RecoveryCodesPanel({ codes }: RecoveryCodesPanelProps) {
  const [copied, setCopied] = useState(false);
  // Track the COPIED! timeout so we can clear it on unmount. Without
  // this, a realistic flow (COPY ALL → tick saved → close modal
  // before 2s) leaves the timeout pending and fires setCopied on a
  // dismounted component (codex round-2 MINOR 2).
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard against the async continuation after `await
  // navigator.clipboard.writeText(...)` racing the unmount: if the
  // user clicks COPY ALL then closes the modal before writeText
  // resolves, the post-await `setCopied` would otherwise fire on a
  // dead component (codex round-3 MINOR).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(formatRecoveryCodesForCopy(codes));
      // Drop late writeText resolutions if the modal closed during
      // the await — same async-cancellation discipline the modals
      // use for their fetches (Group 4 plan: "every async path
      // bounded by mounted-ref + cancellation").
      if (!mountedRef.current) return;
      setCopied(true);
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = setTimeout(() => {
        setCopied(false);
        copiedTimerRef.current = null;
      }, 2000);
    } catch (err) {
      console.warn('[recovery-codes] clipboard copy failed', err);
    }
  }

  function handleDownload() {
    const { content, filename } = formatRecoveryCodesForDownload(
      codes,
      new Date(),
    );
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      // Free the blob URL soon after the click is processed.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, fontFamily: 'var(--mako-font-mono)', fontSize: 14 }}>
        {codes.map((code, i) => (
          <li
            key={`${i}-${code}`}
            className="mk-2fa-field"
            style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 12px', background: 'var(--raise)', boxShadow: 'inset 0 0 0 1px var(--line)', minWidth: 0 }}
          >
            <span style={{ flex: 'none', width: 18, fontSize: 11, color: 'var(--dim)' }}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <code style={{ color: 'var(--mako-canvas-fg)', fontFamily: 'inherit', fontWeight: 700, overflowWrap: 'anywhere' }}>{code}</code>
          </li>
        ))}
      </ol>

      <div style={{ display: 'flex', gap: 10 }}>
        <button
          type="button"
          onClick={handleCopy}
          className="m3-press m3-scale96"
          style={{ flex: 1, height: 44, border: 0, borderRadius: 9999, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', fontFamily: 'var(--mako-font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em' }}
        >
          {copied ? 'COPIED!' : 'COPY ALL'}
        </button>
        <button
          type="button"
          onClick={handleDownload}
          className="m3-press m3-scale96"
          style={{ flex: 1, height: 44, border: 0, borderRadius: 9999, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', fontFamily: 'var(--mako-font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em' }}
        >
          DOWNLOAD .TXT
        </button>
      </div>
    </div>
  );
}
