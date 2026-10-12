# Mako Market brand

The brand reference for visual and motion work: videos, images, posts.
Read by the `video-director` skill.

## Colour

- **Paper:** `#EBE5D9` (base), `#E1DBCB` (raised), `#D6CFBE` (sunk). Use paper for backgrounds, not black.
- **Ink:** `#000`. **Signal:** `#FACC15`.
- **Status:**

  | Status | Colour |
  |---|---|
  | live | `#D946EF` |
  | closed | `#F59E0B` |
  | settling | `#8B5CF6` |
  | won | `#14B8A6` |
  | refunded | `#06B6D4` |

- **Red rule:** only DOWN, NO and loss get red. Fill `#D94A3D`; text on paper `#B3362B`. Nothing else is red.

## Type

- Bricolage Grotesque 800 for display.
- Inter for body.
- JetBrains Mono for numbers and labels.

## Assets

- **Logo:** `public/logos/mako-logo.svg`
- **Mascot (29 poses):** `public/designsystem/mako/*.webp`
- **Design system:** `public/designsystem/index.html` (live at https://makomarket.xyz/designsystem)
- **Product screens:** the live site at https://makomarket.xyz. Use real screens only.

## Voice

- Brand name is "Mako Market" (singular). Speak as "Mako Market ...". Never "we", "our", "us" or "team".
- No em dashes in on-screen text or scripts. Use commas, periods or colons.
- Plain words and short sentences. No hype.
- Lead with the viewer's reason to care before the mechanics.

## Live-site screenshots in cloud sessions

- Trust the proxy CA in Chromium's NSS store.
- Reload until React hydrates. A chunk sometimes 502s.
- Stub `/api/feedback` so nothing is sent.
- Use `:visible` locators, because desktop and mobile variants both render.
