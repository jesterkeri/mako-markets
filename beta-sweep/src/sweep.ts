// The one request this worker ever makes (owner decision Q-L, 2026-10-19): the exact beta host and sweep path, the
// Vercel bypass secret in a header (never the query string), redirects never followed, and nothing secret in what it
// returns or logs. The bypass secret opens every protected deployment of the project if it leaks, so it is treated as
// a high-impact access secret: this worker's own token, never the one Vercel exposes to deployments, used for nothing
// else, rotated when this worker changes or is retired (README.md).

export const BETA_SWEEP_URL = 'https://beta.makomarket.xyz/api/cron/avatar-sweep';

export type Env = { BETA_CRON_SECRET?: string; VERCEL_PROTECTION_BYPASS?: string };
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export type Outcome =
  | { ok: true; summary: { checked: number; deleted: number; failed: number; complete: boolean } }
  | { ok: false; reason: 'secrets_missing' | 'fetch_failed' | 'http' | 'bad_body'; status?: number };

/// Fire beta's avatar sweep once. Only statuses and counts come back, never a header, URL or secret.
export async function pingBetaSweep(env: Env, doFetch: Fetch): Promise<Outcome> {
  const cron = env.BETA_CRON_SECRET?.trim();
  const bypass = env.VERCEL_PROTECTION_BYPASS?.trim();
  if (!cron || !bypass) return { ok: false, reason: 'secrets_missing' };
  let res: Response;
  try {
    res = await doFetch(BETA_SWEEP_URL, {
      method: 'GET',
      redirect: 'manual',
      headers: { authorization: `Bearer ${cron}`, 'x-vercel-protection-bypass': bypass },
    });
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  }
  // A redirect (Vercel's login wall) or anything but 200 is a failure: never followed, never retried here.
  if (res.status !== 200) return { ok: false, reason: 'http', status: res.status };
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const n = (k: string) => (typeof body?.[k] === 'number' ? (body[k] as number) : NaN);
  const summary = { checked: n('checked'), deleted: n('deleted'), failed: n('failed'), complete: body?.complete === true };
  if (body?.ok !== true || [summary.checked, summary.deleted, summary.failed].some(Number.isNaN)) {
    return { ok: false, reason: 'bad_body', status: res.status };
  }
  return { ok: true, summary };
}
