'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';

// ----------------------------------------------------------------------------
// useModalCloseArbitrator
//
// Single dismissal arbiter for the Group 4 TOTP modals. Every dismissal
// path consults the same `allowed()` predicate — close button, Escape
// key, backdrop click, beforeunload (hard refresh / tab close /
// non-app navigation). When `allowed()` returns false, the dismissal
// is refused with no side effect.
//
// What's deliberately NOT covered (codex round-2/4 plan scoping):
//   - In-app `<Link>` clicks and `router.push` — App Router's
//     `next/navigation` exposes no before-navigate hook.
//   - Browser Back/Forward when the previous history entry is another
//     App Router page on the same origin — `beforeunload` does NOT
//     fire for same-document history navigation.
// Mitigated at the modal layer by full-viewport backdrop + focus
// trap + explicit warning copy. Lifting the gate to a page-level
// guard is deferred (see plan).
//
// React unmount is handled separately (caller's cleanup); the
// arbitrator does NOT try to block it. Async cleanup (AbortController
// abort) belongs to each modal's fetch helpers.
//
// Modern beforeunload shape (codex round-3 MINOR 1):
//   event.preventDefault();
//   event.returnValue = '';
// Returning a string is the legacy form; modern browsers honour the
// preventDefault + returnValue assignment.
// ----------------------------------------------------------------------------

type Args = {
  /// Whether the modal is rendered. Listeners are only registered while
  /// open === true.
  open: boolean;
  /// Predicate that returns true when dismissal is allowed. Re-evaluated
  /// on every dismissal attempt; stash whatever state the predicate
  /// reads behind a ref or live state in the calling component.
  allowed: () => boolean;
  /// Called when a dismissal attempt is allowed. The caller is
  /// responsible for actually changing parent state to close the modal
  /// (e.g., setOpen(false)).
  onClose: () => void;
  /// Ref to the dialog content node (not the backdrop). Used to detect
  /// whether a click landed on the backdrop (close) vs inside the
  /// dialog content (no-op).
  dialogRef: RefObject<HTMLElement | null>;
};

export function useModalCloseArbitrator({
  open,
  allowed,
  onClose,
  dialogRef,
}: Args): {
  /// Call from the visible CLOSE button's onClick.
  requestClose: () => void;
  /// Call from the overlay div's onClick. Backdrop-click discrimination
  /// (ignore clicks bubbling up from dialog content) lives here.
  onBackdropClick: (e: React.MouseEvent) => void;
} {
  // Keep the latest predicate / handler in refs so the effect doesn't
  // need to re-subscribe on every render of the calling component.
  // Refs are updated in a useLayoutEffect (synchronous post-commit,
  // pre-paint) rather than during render — React 19's lint rule
  // forbids the latter, and useLayoutEffect closes the same staleness
  // window that the during-render assignment was fixing.
  const allowedRef = useRef(allowed);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    allowedRef.current = allowed;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // Always swallow Escape — codex round-2 MINOR 1. Whether
      // allowed or refused, the modal is the topmost dismissal owner
      // for this keystroke and must not let it propagate to global
      // handlers / parent modal stacks. The only thing that differs
      // between allowed and refused is whether onClose fires.
      e.stopPropagation();
      e.preventDefault();
      if (!allowedRef.current()) return;
      onCloseRef.current();
    }

    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (allowedRef.current()) return;
      e.preventDefault();
      e.returnValue = '';
    }

    // Capture phase so a child input/component can't stopPropagation
    // before the arbitrator sees Escape. Codex round-1 MINOR 2.
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [open]);

  function requestClose() {
    if (!allowedRef.current()) return;
    onCloseRef.current();
  }

  function onBackdropClick(e: React.MouseEvent) {
    // Only treat as backdrop click if the click target is the overlay
    // itself, not a child of the dialog content. Capture the
    // currentTarget reference and compare; React synthetic events stay
    // valid through a single handler.
    if (e.target !== e.currentTarget) return;
    // Ignore clicks that started inside the dialog content (e.g., a
    // drag finishing on the backdrop).
    if (dialogRef.current && dialogRef.current.contains(e.target as Node)) {
      return;
    }
    if (!allowedRef.current()) return;
    onCloseRef.current();
  }

  return { requestClose, onBackdropClick };
}
