'use client';

import { useState } from 'react';

import {
  STATIC_PALETTE,
  deriveInitial,
  derivePaletteIndex,
} from '@/lib/avatar-glyph';

// ----------------------------------------------------------------------------
// AvatarCircle
//
// Renders the user's identity glyph: an <img> if `avatarUrl` is set and
// loadable, otherwise a colored circle with a single initial. Reused by
// /profile (Group 4 IdentityBlock) and Group 5 (sidebar / MobileMenu /
// AuthMenu / signup TOTP step).
//
// Pure logic (initials + palette index) lives in src/lib/avatar-glyph.ts
// and is unit-tested under the Node vitest environment. The DOM-level
// behaviour (img onError fallback, prop-change reset, deterministic
// palette across renders) is covered by avatar-circle.test.tsx under
// happy-dom.
//
// Security:
// - `referrerPolicy="no-referrer"` (camelCase JSX) is defense-in-depth
//   against leaking session info to the avatar host. Avatars are now
//   exclusively Vercel Blob URLs produced by /api/user/avatar/upload —
//   /api/user/profile/update refuses non-null avatarUrl writes, so
//   arbitrary cross-origin URLs cannot enter the column. The component
//   does NOT re-validate; garbage in = broken-image fallback, not XSS.
// - On `<img>` onError we swap to the initials path. The fallback does
//   not contain another <img>, so the error path cannot loop.
//
// Color derivation (codex round-1 NIT 2): Tailwind's content scanner
// only sees CLASS LITERALS — `bg-${name}` constructed at runtime would
// be purged. The shared `STATIC_PALETTE` keeps every class string
// literal in source.
// ----------------------------------------------------------------------------

type AvatarCircleProps = {
  displayName: string | null;
  /** First-letter initial source. Magic: email; wallet: formatted address. */
  initialSource: string;
  /** Color seed. Magic: magicEoa; wallet: walletAddress. */
  seedKey: string;
  avatarUrl: string | null;
  size?: number;
  className?: string;
};

export function AvatarCircle({
  displayName,
  initialSource,
  seedKey,
  avatarUrl,
  size = 48,
  className = '',
}: AvatarCircleProps) {
  // Reset img-failed when the URL changes — React's recommended
  // "derived state from props" pattern. The setState calls inside
  // the render bail out and re-render with the new state before
  // committing, so by the time `showImage` is computed below the
  // imgFailed value matches the new URL.
  const [imgFailed, setImgFailed] = useState(false);
  const [lastUrl, setLastUrl] = useState(avatarUrl);
  const urlChanged = lastUrl !== avatarUrl;
  if (urlChanged) {
    setLastUrl(avatarUrl);
    setImgFailed(false);
  }
  // Treat URL changes as a fresh attempt for THIS render too, so a
  // user pasting a new URL after a prior failure doesn't see the
  // initials path flash for one render.
  const showImage = avatarUrl !== null && (!imgFailed || urlChanged);

  const initial = deriveInitial(displayName, initialSource);
  const palette = STATIC_PALETTE[derivePaletteIndex(seedKey)];

  const dim = `${size}px`;
  const fontSize = `${Math.round(size * 0.45)}px`;

  if (showImage) {
    return (
      // We deliberately use a plain <img> instead of next/image. Even
      // though avatars are now exclusively Vercel Blob URLs (single
      // origin, single subdomain pattern under
      // *.public.blob.vercel-storage.com — see /api/user/avatar/upload
      // for the lockdown), next/image would still require a
      // remote-pattern entry per deployment's blob host AND its
      // optimization payoff at 32-48px is negligible. The plain <img>
      // keeps the component framework-free; referrerPolicy="no-referrer"
      // is defense-in-depth.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl!}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
        style={{ width: dim, height: dim }}
        className={`rounded-full border-2 border-ink object-cover ${className}`}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      style={{ width: dim, height: dim, fontSize }}
      className={`rounded-full border-2 border-ink flex items-center justify-center font-display font-black ${palette.bg} ${palette.fg} ${className}`}
    >
      {initial}
    </div>
  );
}
