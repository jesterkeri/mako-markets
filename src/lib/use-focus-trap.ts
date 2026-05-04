'use client';

import { useEffect, useRef, type RefObject } from 'react';

// ----------------------------------------------------------------------------
// useFocusTrap
//
// Keeps Tab / Shift+Tab focus inside the dialog while it's open, and
// restores focus to the opener element on close. WarningModal didn't
// implement this; Group 4 builds it (codex round-3 MINOR 1) for the
// three TOTP modals.
//
// Behaviour:
//   - On open: capture document.activeElement as the opener; focus
//     `initialFocusRef` if provided, else the first focusable
//     descendant of the container.
//   - While open: Tab cycles within focusable descendants; Shift+Tab
//     cycles backward.
//   - On close: focus is .focus()'d on the captured opener if it's
//     still in the DOM and focusable.
//
// "Focusable" set: enabled elements matching standard tab-stop
// selectors. We don't try to compute true tab order with positive
// tabindex values — those are extremely rare in this codebase and
// arguably bad UX.
// ----------------------------------------------------------------------------

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(container: HTMLElement): HTMLElement[] {
  const all = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  return Array.from(all).filter((el) => {
    // Skip hidden / display:none elements.
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  });
}

type Args = {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  /// Optional element to focus on open. If absent, the first focusable
  /// descendant of `containerRef.current` gets focus.
  initialFocusRef?: RefObject<HTMLElement | null>;
};

export function useFocusTrap({
  open,
  containerRef,
  initialFocusRef,
}: Args): void {
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    // Capture the opener so we can restore focus on close.
    openerRef.current = (document.activeElement as HTMLElement | null) ?? null;

    // Focus the requested element (or the first focusable descendant)
    // on the next microtask so the dialog has rendered.
    const initial = initialFocusRef?.current ?? getFocusable(container)[0];
    if (initial) {
      // Defer to allow autofocus / form mounts to settle first.
      queueMicrotask(() => {
        try {
          initial.focus();
        } catch {
          // .focus() can throw if the element was removed between
          // schedule and execution — ignore.
        }
      });
    }

    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable(container!);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // If focus has escaped the dialog (e.g., a child element was
      // removed mid-render), treat the next Tab as a wrap. Without
      // this branch a forward Tab from outside the container would
      // fall through to the rest of the page. Codex round-1 MINOR.
      const escaped = !container!.contains(active);
      if (e.shiftKey) {
        if (escaped || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (escaped || active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKey);

    const opener = openerRef.current;
    return () => {
      document.removeEventListener('keydown', onKey);
      // Restore focus to the opener if it's still focusable.
      if (opener && document.body.contains(opener)) {
        try {
          opener.focus();
        } catch {
          // Opener may no longer be focusable; not fatal.
        }
      }
    };
    // We intentionally do NOT include `containerRef` / `initialFocusRef`
    // in the dependency array — they're stable refs whose .current
    // value is read inside the effect. Including them would cause the
    // trap to re-subscribe on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
