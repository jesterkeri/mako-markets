// MatcherSettler, PHASE A STUB. It sends nothing: no transaction is built, signed or sent from this package yet.
// Every request is refused with 503 `settler_not_built`, except one read-only question the market objects ask at
// intake: whether an account is on the daily refusal list (plan 6.2: N = 1 / N = 3). The table's shape is built
// now; Phase B's settler is what writes it.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

export const REFUSED_SCHEMA = `CREATE TABLE IF NOT EXISTS refused_accounts (
  maker TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (maker, utc_day)
)`;

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isRefused(sql: SqlStorage, maker: string, nowMs: number): boolean {
  return sql.exec(`SELECT 1 FROM refused_accounts WHERE maker = ? AND utc_day = ?`, maker.toLowerCase(), utcDay(nowMs)).toArray().length > 0;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class MatcherSettler extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(REFUSED_SCHEMA);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/refused\/(0x[0-9a-fA-F]{40})$/.exec(url.pathname);
    if (req.method === 'GET' && m) return json(200, { refused: isRefused(this.ctx.storage.sql, m[1], Date.now()) });
    return json(503, { ok: false, accepted: false, error: 'settler_not_built' });
  }
}
