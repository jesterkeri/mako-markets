'use client';

// ----------------------------------------------------------------------------
// src/app/m/[slug]/_components/PmCommentsPanel.tsx  (#182 Slice B)
//
// Client wrapper that mounts the shared CommentsSection for a PM market and,
// for the market's CREATOR, a compact ON/OFF toggle. It owns the
// `commentsEnabled` state (seeded from the server-rendered row) so flipping
// the toggle immediately hides/shows the composer without a page refresh.
//
// The PATCH is authorized server-side (creator-scoped UPDATE); `viewerIsCreator`
// only decides whether to RENDER the toggle — a non-creator never sees it, and
// couldn't use it if they forged the request. Brand tokens only → both themes.
// ----------------------------------------------------------------------------

import { useState } from 'react';

import { CommentsSection } from '@/components/CommentsSection';

export function PmCommentsPanel({
  slug,
  dbId,
  viewerIsCreator,
  initialCommentsEnabled,
}: {
  slug: string;
  dbId: string;
  viewerIsCreator: boolean;
  initialCommentsEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialCommentsEnabled);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function setComments(next: boolean) {
    if (pending || next === enabled) return;
    setPending(true);
    setErr(null);
    try {
      const res = await fetch(`/api/pm/markets/${dbId}/comments-toggle`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commentsEnabled: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setEnabled(next);
    } catch {
      setErr('Could not update comments. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="w-full">
      {viewerIsCreator && (
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <span className="mako-label text-[11px] text-muted">CREATOR · COMMENTS</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setComments(true)}
              disabled={pending}
              className={`mako-label text-[10px] px-3 py-1.5 rounded-full border-2 border-ink transition-all disabled:opacity-40 ${
                enabled ? 'bg-ink text-paper' : 'bg-paper hover:-translate-y-[1px]'
              }`}
            >
              ON
            </button>
            <button
              type="button"
              onClick={() => setComments(false)}
              disabled={pending}
              className={`mako-label text-[10px] px-3 py-1.5 rounded-full border-2 border-ink transition-all disabled:opacity-40 ${
                !enabled ? 'bg-mako-red text-paper' : 'bg-paper hover:-translate-y-[1px]'
              }`}
            >
              OFF
            </button>
          </div>
          {err && <span className="mako-mono text-[10px] text-mako-red">{err}</span>}
        </div>
      )}

      <CommentsSection scope="pm" slug={slug} writable={enabled} />
    </div>
  );
}
