// Outbound HTTP for one run, copied from watchdog/src/net.ts (feat/watchdog-slice1, reviewed through r12):
// every request is counted, bounded by a 10 s timeout and by the run deadline, and never retried here (the
// next run retries). Errors are reduced to a kind, so a URL or header can never reach a log line, an alert or
// the Durable Object.

const FETCH_TIMEOUT_MS = 10_000;

export type FailKind = 'timeout' | 'deadline' | 'budget' | 'network' | 'http' | 'rate_limited' | 'bad_response';

export type HttpResult =
  | { ok: true; status: number; headers: Headers; text: string }
  | { ok: false; kind: FailKind; status?: number; headers?: Headers; text?: string };

export interface Net {
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  deadlineAt: number;
  /// Hard ceiling on requests in this run (S6).
  maxRequests: number;
  requests: number;
}

export function makeNet(
  fetchFn: typeof fetch,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  deadlineAt: number,
  maxRequests: number,
): Net {
  return { fetch: fetchFn, now, sleep, deadlineAt, maxRequests, requests: 0 };
}

/// One HTTP request. Returns a kind instead of throwing.
export async function send(net: Net, url: string, init: RequestInit): Promise<HttpResult> {
  const remaining = net.deadlineAt - net.now();
  if (remaining <= 0) return { ok: false, kind: 'deadline' };
  if (net.requests >= net.maxRequests) return { ok: false, kind: 'budget' };
  net.requests++;
  const timeoutMs = Math.min(FETCH_TIMEOUT_MS, remaining);
  let res: Response;
  try {
    res = await net.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return { ok: false, kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ok: false, kind: 'timeout', status: res.status };
  }
  if (res.status === 429) return { ok: false, kind: 'rate_limited', status: 429, headers: res.headers, text };
  if (res.status < 200 || res.status >= 300) return { ok: false, kind: 'http', status: res.status, headers: res.headers, text };
  return { ok: true, status: res.status, headers: res.headers, text };
}

/// Runs tasks with at most `limit` in flight (F23: six connections per invocation).
export async function inGroups<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}
