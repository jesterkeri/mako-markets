'use client';

import { useEffect, type RefObject } from 'react';

/// Closes a pop-up on a click outside `ref` or on Escape. Escape returns focus to `returnFocus`, the control
/// that opened it, so a keyboard user is not left on nothing.
export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  returnFocus?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
      returnFocus?.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, onClose, returnFocus]);
}
