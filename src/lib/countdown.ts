/// Time left, as the redesign writes it (DESIGN_RULES): over 24 hours in days and hours ("2D 1H"), under 24
/// hours in hours and minutes ("6H 11M"), under an hour as a clock ("45:02"). Past or invalid is "00:00".
export function formatCountdown(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (s >= 86_400) return `${Math.floor(s / 86_400)}D ${Math.floor((s % 86_400) / 3_600)}H`;
  if (s >= 3_600) return `${Math.floor(s / 3_600)}H ${Math.floor((s % 3_600) / 60)}M`;
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
