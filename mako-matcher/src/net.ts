// One outbound JSON-RPC request. Errors are reduced to a kind, so a URL that carries a key can never reach a log
// line, an alert or the Durable Object.
import { FETCH_TIMEOUT_MS } from './config';

export type FailKind = 'timeout' | 'deadline' | 'network' | 'http' | 'rate_limited' | 'bad_response';

export interface Net {
  fetch: typeof fetch;
  now(): number;
  deadlineAt: number;
}

export type HttpResult = { ok: true; text: string } | { ok: false; kind: FailKind; status?: number };

export async function send(net: Net, url: string, init: RequestInit): Promise<HttpResult> {
  const remaining = net.deadlineAt - net.now();
  if (remaining <= 0) return { ok: false, kind: 'deadline' };
  let res: Response;
  try {
    res = await net.fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remaining)) });
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
  if (res.status === 429) return { ok: false, kind: 'rate_limited', status: 429 };
  if (res.status < 200 || res.status >= 300) return { ok: false, kind: 'http', status: res.status };
  return { ok: true, text };
}
