'use client';

import { useState } from 'react';

/// What fills a leaderboard avatar circle: the player's letter, with their profile photo over it when they have one
/// (only a photo this app uploaded for them reaches the board; lib/leaderboard/identity.ts). If the photo fails to
/// load, the letter shows. The circle itself (size, colour, ring) stays its caller's; it must be position:relative.
export function AvatarFill({ initial, avatarUrl }: { initial: string; avatarUrl: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <>
      {initial}
      {avatarUrl && failedUrl !== avatarUrl && (
        // A plain <img>, as on Me: avatars are single-origin Vercel Blob URLs, and next/image buys nothing here.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(avatarUrl)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} />
      )}
    </>
  );
}
