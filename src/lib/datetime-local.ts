// Converting between Unix seconds and an <input type="datetime-local"> value, which is in the browser's own timezone,
// and describing a time unambiguously (the admin market form, Joshua 2026-10-08).

/// Unix seconds as a `datetime-local` value in this browser's timezone ("2026-10-09T14:30").
export function toLocalInput(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/// A `datetime-local` value (this browser's timezone) as Unix seconds, or null for an empty or invalid one.
export function fromLocalInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/// "2026-10-09 13:30 UTC · in 1 d 6 h" (or "in the past"), so the timezone is never in doubt.
export function describeTime(sec: number, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const utc = new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const ahead = sec - nowSec;
  if (ahead <= 0) return `${utc} UTC · in the past`;
  const d = Math.floor(ahead / 86400);
  const h = Math.floor((ahead % 86400) / 3600);
  const m = Math.floor((ahead % 3600) / 60);
  return `${utc} UTC · in ${d ? `${d} d ` : ''}${h ? `${h} h ` : ''}${m} min`;
}
