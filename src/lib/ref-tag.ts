// Ref tags: which X post brought an account. A post links to `makomarket.xyz/?utm_source=x&utm_campaign=<post>`
// (Vercel Analytics counts visits per `utm_campaign` on its own); `?ref=<post>` is accepted too. The tag is kept in
// a first-party cookie and copied onto the account when it is created, at its first sign-in, and never after.
//
// One rule everywhere, and the same as the database CHECK `users_ref_format_chk` (migration 0011): lower-case
// letters, digits and hyphens, 1 to 32 characters. Anything else is ignored, never stored.

export const REF_COOKIE = 'mako_ref';
export const REF_MAX_AGE_SEC = 30 * 24 * 60 * 60;

const PATTERN = /^[a-z0-9-]{1,32}$/;

/// A valid tag, lower-cased and trimmed, or null.
export function parseRefTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tag = raw.trim().toLowerCase();
  return PATTERN.test(tag) ? tag : null;
}

/// The tag in a page's query string: `utm_campaign` first, then `ref`.
export function refFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  return parseRefTag(params.get('utm_campaign')) ?? parseRefTag(params.get('ref'));
}

/// The tag in a request's `Cookie` header, or null.
export function refFromCookieHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== REF_COOKIE) continue;
    try {
      return parseRefTag(decodeURIComponent(part.slice(eq + 1).trim()));
    } catch {
      return null;
    }
  }
  return null;
}
