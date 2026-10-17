'use client';

import { useEffect, useState } from 'react';

import { displayNameKey } from '@/lib/display-name';

import { validateDisplayName } from './profile-rules';

export type NameCheck = 'idle' | 'checking' | 'available' | 'taken' | 'reserved';

/// Live availability of the name being typed on Me, 400 ms after the last keystroke. 'idle' while the draft is the
/// current name or not a valid name (the format message covers that). Advisory: the save route enforces it.
export function useNameCheck(draft: string, current: string | null, editing: boolean): NameCheck {
  const [state, setState] = useState<{ key: string; check: NameCheck }>({ key: '', check: 'idle' });
  const key = displayNameKey(draft);
  const skip = !editing || validateDisplayName(draft) !== null || (current !== null && key === displayNameKey(current));
  useEffect(() => {
    if (skip) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/user/profile/name-available?name=${encodeURIComponent(draft.trim())}`, { credentials: 'same-origin', signal: ctrl.signal });
        const body = (await res.json()) as { available?: boolean; reason?: string };
        const check: NameCheck = body.available ? 'available' : body.reason === 'reserved' ? 'reserved' : body.reason === 'taken' ? 'taken' : 'idle';
        setState({ key, check });
      } catch {
        // Aborted or offline: no verdict; the save route still decides.
      }
    }, 400);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [skip, key, draft]);
  if (skip) return 'idle';
  return state.key === key ? state.check : 'checking';
}
