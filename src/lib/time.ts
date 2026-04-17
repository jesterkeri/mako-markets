/**
 * Time/duration helpers shared across pages.
 *
 * Kept pure-arithmetic and locale-agnostic on purpose — these run in both
 * RSC and client-interactive paths, and any locale/tz dependency here
 * would risk hydration drift.
 */

/**
 * Turn a delta in seconds into a human phrase.
 *
 *   humanizeUntil(3600)   → "1h 0m from now"
 *   humanizeUntil(-3600)  → "1h 0m ago"
 *   humanizeUntil(0)      → "now"
 *
 * Callers pass `targetSec - nowSec`; the sign picks the suffix. One helper,
 * no callsite arithmetic gymnastics.
 */
export function humanizeUntil(secondsDelta: number): string {
  if (!Number.isFinite(secondsDelta) || secondsDelta === 0) return 'now';
  const past = secondsDelta < 0;
  const sec = Math.abs(secondsDelta);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const label = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return past ? `${label} ago` : `${label} from now`;
}

/**
 * Compact HH/MM/SS display used on the market detail countdown.
 * Returns 'CLOSED' once the countdown is at or below zero.
 */
export function formatTime(seconds: number): string {
  if (seconds <= 0) return 'CLOSED';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = Math.floor(seconds % 60);
  if (h > 0) return `${h}H ${m}M`;
  if (m > 0) return `${m}M ${sec}S`;
  return `${sec}S`;
}
