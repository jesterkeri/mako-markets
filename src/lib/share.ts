/**
 * Build public share URLs for market pages.
 *
 * Priority:
 * 1. `NEXT_PUBLIC_APP_URL` when configured for a deployed host
 * 2. browser origin at runtime
 * 3. empty string when neither is available
 */

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

export function getAppOrigin(): string {
  const envOrigin = process.env.NEXT_PUBLIC_APP_URL;
  if (envOrigin) return trimTrailingSlash(envOrigin);

  if (typeof window !== 'undefined' && window.location.origin) {
    return trimTrailingSlash(window.location.origin);
  }

  return '';
}

export function getMarketShareUrl(id: bigint | string): string {
  const origin = getAppOrigin();
  const marketId = typeof id === 'bigint' ? id.toString() : id;
  return origin ? `${origin}/pools/${marketId}` : `/pools/${marketId}`;
}
