// A scripted Upstash Redis REST endpoint: one shared in-memory store (so several "instances" of the app, i.e. several
// module copies, share one counter, as Vercel instances share Upstash), with EXPIRE honoured against a test clock.
// Understands exactly the commands the app sends: EVAL (the sliding-window reserve script), GET, SET … EX n.
export type FakeUpstash = {
  url: string;
  token: string;
  now: () => number;
  store: Map<string, { value: string; expiresAt: number | null }>;
  zsets: Map<string, { score: number; member: string }[]>;
  calls: string[][];
  /// Return a Response to answer a request instead of the model (an outage, an error body, junk).
  override: ((cmd: string[]) => Response | null) | null;
};

export function fakeUpstash(now: () => number = () => Date.now()): FakeUpstash {
  return { url: 'https://fake-upstash.test', token: 'test-token-not-a-secret', now, store: new Map(), zsets: new Map(), calls: [], override: null };
}

function live(f: FakeUpstash, key: string) {
  const e = f.store.get(key);
  if (e && e.expiresAt !== null && f.now() >= e.expiresAt) {
    f.store.delete(key);
    return undefined;
  }
  return e;
}

export async function answerUpstash(f: FakeUpstash, init?: RequestInit): Promise<Response> {
  const auth = new Headers(init?.headers).get('authorization');
  if (auth !== `Bearer ${f.token}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const cmd = JSON.parse(String(init?.body ?? '[]')) as string[];
  f.calls.push(cmd);
  const forced = f.override?.(cmd);
  if (forced) return forced;
  const [name, ...args] = cmd;
  if (name === 'EVAL') {
    // The reserve script, scored on the STORE's clock (Redis TIME), as the real script is. KEYS: global log, consumer
    // log. ARGV: window ms, global cap, consumer cap, member.
    const [, , globalKey, consumerKey, winS, globalCapS, capS, member] = args;
    const now = f.now();
    const win = Number(winS);
    const g = (f.zsets.get(globalKey) ?? []).filter((x) => x.score > now - win);
    const c = (f.zsets.get(consumerKey) ?? []).filter((x) => x.score > now - win);
    f.zsets.set(globalKey, g);
    f.zsets.set(consumerKey, c);
    // A cap that is not a number makes the real script error (tonumber gives nil), so the fake errors too.
    if (!Number.isFinite(Number(globalCapS)) || !Number.isFinite(Number(capS))) return Response.json({ error: 'ERR attempt to compare nil with number' });
    if (g.length >= Number(globalCapS) || c.length >= Number(capS)) return Response.json({ result: 0 });
    g.push({ score: now, member });
    c.push({ score: now, member });
    return Response.json({ result: c.length });
  }
  if (name === 'GET') return Response.json({ result: live(f, args[0])?.value ?? null });
  if (name === 'SET') {
    const [key, value, ex, secs] = args;
    f.store.set(key, { value, expiresAt: ex === 'EX' ? f.now() + Number(secs) * 1000 : null });
    return Response.json({ result: 'OK' });
  }
  return Response.json({ error: `unscripted ${name}` });
}
