'use client';

import { useEffect } from 'react';

type WarningModalProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel: string;
};

export function WarningModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
}: WarningModalProps) {
  useEffect(() => {
    if (!open) return;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.body.style.overflow = priorOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="warning-modal-title"
      className="fixed inset-0 z-[100] bg-[var(--color-background)]/80 flex items-center justify-center p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mako-card w-full max-w-md flex flex-col p-0 overflow-hidden text-ink"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b-2 border-ink bg-surface-elevated">
          <h2 id="warning-modal-title" className="mako-display text-2xl text-mako-red">
            {title}
          </h2>
        </div>
        <div className="p-6">
          <p className="mako-body text-base mb-8 whitespace-pre-wrap">
            {message}
          </p>
          <div className="flex flex-col sm:flex-row gap-4">
            <button
              type="button"
              onClick={onClose}
              className="mako-button mako-button--ghost flex-1 border-2 border-ink"
            >
              CANCEL
            </button>
            <button
              type="button"
              onClick={() => {
                onConfirm();
                onClose();
              }}
              className="mako-button mako-button--no flex-1 border-2 border-ink"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
