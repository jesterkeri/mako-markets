'use client';

import { useEffect, useState } from 'react';

import { displayNameKey } from '@/lib/display-name';

import { validateDisplayName } from './profile-rules';

export type NameCheck = 'idle' | 'checking' | 'available' | 'taken' | 'reserved';

// Me mounts the desktop and phone editors together (CSS shows one), so both ask at the same pause: one request per
// name, shared while in flight and for 2 s after (the two editors' timers need not fire together). null = no verdict (offline, signed out, bad reply): the check stays 'checking'
// rather than showing "Looks good", and the save route still decides.
const inflight = new Map<string, Promise<NameCheck | null>>();
function ask(name: string, key: string): Promise<NameCheck | null> {
  let p = inflight.get(key);
  if (!p) {
    p = fetch(`/api/user/profile/name-available?name=${encodeURIComponent(name)}`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await res.json()) as { available?: boolean; reason?: string };
        return body.available ? 'available' : body.reason === 'reserved' ? 'reserved' : body.reason === 'taken' ? 'taken' : null;
      })
      .catch(() => null)
      .finally(() => setTimeout(() => inflight.delete(key), 2000));
    inflight.set(key, p);
  }
  return p;
}

/// Live availability of the name being typed on Me, 400 ms after the last keystroke. 'idle' while the draft is the
/// current name unchanged or not a valid name (the format message covers that). A case or spacing change is asked
/// about: the keeper of a shared name may make it, an account that shared it before migration 0017 may not.
/// Advisory: the save route enforces it.
export function useNameCheck(draft: string, current: string | null, editing: boolean): NameCheck {
  const [state, setState] = useState<{ key: string; check: NameCheck }>({ key: '', check: 'idle' });
  const key = displayNameKey(draft);
  const skip = !editing || validateDisplayName(draft) !== null || (current !== null && draft.trim() === current.trim());
  useEffect(() => {
    if (skip) return;
    let live = true;
    const t = setTimeout(() => {
      void ask(draft.trim(), key).then((check) => {
        if (live && check) setState({ key, check });
      });
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [skip, key, draft]);
  if (skip) return 'idle';
  return state.key === key ? state.check : 'checking';
}
