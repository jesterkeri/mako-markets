// Converting between Unix seconds and an <input type="datetime-local"> value, which is in the browser's own timezone,
// and describing a time unambiguously (the admin market form, Joshua 2026-10-08).

/// Unix seconds as a `datetime-local` value in this browser's timezone ("2026-10-09T14:30").
export function toLocalInput(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/// A `datetime-local` value (this browser's timezone) as Unix seconds, or null when it is malformed or names a local
/// time that does not exist. `new Date("…T02:30")` silently moves a time inside a spring-forward gap to the next hour
/// (Codex RELEASE_R5 F2), so the fields are rebuilt and must read back unchanged. A repeated fall-back hour exists
/// twice and resolves to its first occurrence.
export function fromLocalInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const dt = new Date(y, mo - 1, d, h, mi);
  const same =
    dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d && dt.getHours() === h && dt.getMinutes() === mi;
  return same ? Math.floor(dt.getTime() / 1000) : null;
}

/// What to tell someone whose typed value fromLocalInput refused.
export function localInputProblem(value: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
    ? 'That time does not exist in your timezone (the clocks jump forward then). Pick another time.'
    : 'Pick a date and time.';
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
