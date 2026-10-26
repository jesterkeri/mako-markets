'use client';

import { useEffect, useState } from 'react';

import { displayNameKey } from '@/lib/display-name';

import { validateDisplayName } from './profile-rules';

export type NameCheck = 'idle' | 'checking' | 'available' | 'taken' | 'reserved';

// Me mounts the desktop and phone editors together (CSS shows one), so both ask at the same pause: one request per
// name, shared only within that pause (the answer is dropped SHARE_MS after it lands, well inside the 400 ms debounce,
// so a name that changes hands is asked about afresh at the next pause). Not "the next timer turn": the two editors'
// timers are set in one commit but other components' effects run between them, so they can land a few ms apart
// (the Me invite card did exactly that). A request gives up after 10 s. null = no verdict (offline, signed out, bad reply): the check stays 'checking'
// rather than showing "Looks good", and the save route still decides.
const inflight = new Map<string, Promise<NameCheck | null>>();
const SHARE_MS = 100;
function ask(name: string, key: string): Promise<NameCheck | null> {
  let p = inflight.get(key);
  if (!p) {
    p = fetch(`/api/user/profile/name-available?name=${encodeURIComponent(name)}`, { credentials: 'same-origin', signal: AbortSignal.timeout(10_000) })
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await res.json()) as { available?: boolean; reason?: string };
        return body.available ? 'available' : body.reason === 'reserved' ? 'reserved' : body.reason === 'taken' ? 'taken' : null;
      })
      .catch(() => null)
      .finally(() => setTimeout(() => inflight.delete(key), SHARE_MS));
    inflight.set(key, p);
  }
  return p;
}

/// Live availability of the name being typed on Me, 400 ms after the last keystroke. 'idle' while the draft is the
/// current name unchanged or not a valid name (the format message covers that). A case or spacing change is asked
/// about: the keeper of a shared name may make it, an account that shared it before migration 0017 may not.
/// Advisory: the save route enforces it.
export function useNameCheck(draft: string, current: string | null, editing: boolean, account: string | null = null): NameCheck {
  const [state, setState] = useState<{ key: string; check: NameCheck }>({ key: '', check: 'idle' });
  // The answer depends on the account (its own name counts as available), so a verdict belongs to the typed name, the
  // account and its current name: a sign-in as another account in another tab asks again instead of keeping the old
  // one, even when both accounts show the same name (shared before migration 0017).
  const key = `${account ?? ''}\n${current ?? ''}\n${displayNameKey(draft)}`;
  const skip = !editing || validateDisplayName(draft) !== null || (current !== null && draft.trim() === current.trim());
  useEffect(() => {
    if (skip) return;
    let live = true;
    const t = setTimeout(() => {
      // A new check drops this name's earlier answer: the name may have changed hands since, and a check that never
      // answers must read 'checking', not the old "Looks good".
      setState((s) => (s.key === key ? { key: '', check: 'idle' } : s));
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
