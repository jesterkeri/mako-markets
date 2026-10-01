'use client';

import { useEffect, type RefObject } from 'react';

import { getFocusable, trapTab } from '@/lib/use-focus-trap';
import { useIsDesktop } from '@/lib/use-is-desktop';

type Variant = {
  containerRef: RefObject<HTMLElement | null>;
  /// What takes focus when this variant becomes the visible one (else its first focusable control).
  initialFocusRef?: RefObject<HTMLElement | null>;
};

/// The focus trap for a dialog that renders a desktop and a mobile variant, CSS showing one (the redesign's sheets).
/// Tab stays inside the variant on screen now; when the window crosses the breakpoint, focus moves into the newly
/// visible one and the trap goes with it. The opener is captured once, when the dialog opens, and gets focus back
/// only when it closes, never on a breakpoint change (Codex S1 r2).
export function useResponsiveFocusTrap({ open, desktop, mobile }: { open: boolean; desktop: Variant; mobile: Variant }): void {
  const isDesktop = useIsDesktop();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    return () => {
      if (opener && document.body.contains(opener)) {
        try {
          opener.focus();
        } catch {
          // No longer focusable: not fatal.
        }
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const v = isDesktop ? desktop : mobile;
    const container = v.containerRef.current;
    if (!container) return;
    const initial = v.initialFocusRef?.current ?? getFocusable(container)[0];
    if (initial) {
      queueMicrotask(() => {
        try {
          initial.focus();
        } catch {
          // Removed before the microtask ran: ignore.
        }
      });
    }
    const onKey = (e: KeyboardEvent) => trapTab(e, container);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // The refs are stable; only opening and the visible variant re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isDesktop]);
}
