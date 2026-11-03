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

/// Shared links always point at production, never at the preview or local host the sharer happens to be on.
export const SHARE_ORIGIN = 'https://makomarket.xyz';

// Referral tags: `r-` plus the first 30 hex characters of the referrer's account address (the Safe for an email
// account, the wallet for a wallet account), lower-cased. Exactly 32 characters, so the rule above and the DB CHECK
// accept it unchanged, and it is computed from the public address, so no code table is needed.
const REFERRAL = /^r-[0-9a-f]{30}$/;

/// The referral code for an account address.
export function referralCode(address: string): string {
  return `r-${address.toLowerCase().slice(2, 32)}`;
}

/// True for a referral tag, false for a campaign tag or anything else.
export function isReferralTag(tag: string | null): boolean {
  return tag !== null && REFERRAL.test(tag);
}

/// The invite link: `?ref=` only, because `refFromSearch` prefers `utm_campaign`.
export function referralLink(address: string): string {
  return `${SHARE_ORIGIN}/?ref=${referralCode(address)}`;
}
