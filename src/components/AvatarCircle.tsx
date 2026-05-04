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
// - `referrerPolicy="no-referrer"` (camelCase JSX) prevents leaking the
//   user's session to whatever host the avatar URL points at. Server-side
//   validation (see /api/user/profile/update) already enforces https,
//   no userinfo, no fragments, ≤512 chars; this component does NOT
//   re-validate. Garbage in = broken-image fallback, not XSS.
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
  email: string;
  magicEoa: string;
  avatarUrl: string | null;
  size?: number;
  className?: string;
};

export function AvatarCircle({
  displayName,
  email,
  magicEoa,
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

  const initial = deriveInitial(displayName, email);
  const palette = STATIC_PALETTE[derivePaletteIndex(magicEoa)];

  const dim = `${size}px`;
  const fontSize = `${Math.round(size * 0.45)}px`;

  if (showImage) {
    return (
      // We deliberately use a plain <img> instead of next/image: the
      // user-pasted URL is arbitrary cross-origin, and next/image's
      // optimization proxy would require remote-pattern config + load
      // an unbounded set of upstream hosts. For 32-48px avatars the
      // optimization payoff is negligible; the security boundary
      // (referrerPolicy="no-referrer") is what matters here.
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
