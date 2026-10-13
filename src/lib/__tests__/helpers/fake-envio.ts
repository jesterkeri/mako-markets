// A scripted Envio (Hasura) GraphQL endpoint for the five queries GET /api/me/rounds sends
// (src/lib/me-rounds-indexer.ts), answering from in-memory entities shaped like indexer/schema.graphql: rows are
// filtered by the query's `where`, ordered by id, cut at `id > after` and `limit`, as Hasura does. `rowCap` stands
// in for a hosted row cap below the requested limit. Nothing here touches a network.

import { ACTIVE_QUERY, CREATED_QUERY, ENTRIES_QUERY, HEAD_QUERY, HEAD_ROUND_QUERY } from '@/lib/me-rounds-indexer';

/// openTime and startTime are Hasura `numeric` (BigInt) columns: a decimal string, as the hosted Envio answers them.
/// Left out, the fake answers the defaults below (the same as FAKE_OPEN / FAKE_START).
export type FakeRound = { id: string; creator: string; status: 'Active' | 'Up' | 'Down' | 'Refunded'; openTime?: string | number; startTime?: string | number };
export const FAKE_OPEN = '1760000000';
export const FAKE_START = '1760000900';
export type FakeEntry = { id: string; round_id: string; wallet_id: string };

export type FakeEnvio = {
  /// GlobalStats.rounds; null = no GlobalStats row yet.
  globalRounds: number | null;
  rounds: FakeRound[];
  entries: FakeEntry[];
  rowCap: number;
  /// Every request, in order: the operation and its variables.
  log: { op: string; variables: Record<string, unknown> }[];
  /// Return a Response to answer a request instead of the model (an outage, a GraphQL error, a malformed page).
  override: ((op: string, variables: Record<string, unknown>) => Response | null) | null;
  /// Runs before each answer, so a test can change the model between pages.
  beforeAnswer: ((op: string, variables: Record<string, unknown>) => void) | null;
};

export function fakeEnvio(): FakeEnvio {
  return { globalRounds: 0, rounds: [], entries: [], rowCap: Infinity, log: [], override: null, beforeAnswer: null };
}

const OPS: [string, string][] = [
  [HEAD_QUERY, 'head'],
  [HEAD_ROUND_QUERY, 'headRound'],
  [ACTIVE_QUERY, 'active'],
  [ENTRIES_QUERY, 'entries'],
  [CREATED_QUERY, 'created'],
];

function page<T extends { id: string }>(rows: T[], variables: Record<string, unknown>, cap: number): T[] {
  const after = String(variables.after);
  const limit = Number(variables.limit);
  return rows
    .filter((r) => r.id > after)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.min(limit, cap));
}

export function answerEnvio(env: FakeEnvio, body: string): Response {
  const { query, variables = {} } = JSON.parse(body) as { query: string; variables?: Record<string, unknown> };
  const op = OPS.find(([q]) => q === query)?.[1];
  if (!op) return Response.json({ errors: [{ message: 'unscripted query' }] });
  env.log.push({ op, variables });
  env.beforeAnswer?.(op, variables);
  const forced = env.override?.(op, variables);
  if (forced) return forced;
  if (op === 'head') return Response.json({ data: { GlobalStats: env.globalRounds === null ? [] : [{ rounds: env.globalRounds }] } });
  if (op === 'headRound') {
    const r = env.rounds.filter((x) => x.id === variables.id);
    return Response.json({
      data: { Round: r.map((x) => ({ id: x.id, openTime: x.openTime ?? FAKE_OPEN, startTime: x.startTime ?? FAKE_START, creator: x.creator })) },
    });
  }
  if (op === 'active') {
    return Response.json({ data: { Round: page(env.rounds.filter((r) => r.status === 'Active'), variables, env.rowCap).map((r) => ({ id: r.id })) } });
  }
  if (op === 'created') {
    const mine = env.rounds.filter((r) => r.creator === variables.creator);
    return Response.json({ data: { Round: page(mine, variables, env.rowCap).map((r) => ({ id: r.id })) } });
  }
  const mine = env.entries.filter((e) => e.wallet_id === variables.wallet);
  return Response.json({ data: { RoundEntry: page(mine, variables, env.rowCap).map((e) => ({ id: e.id, round_id: e.round_id })) } });
}

/// A `fetch` that answers the indexer URL from `env`; any other URL fails the test.
export function envioFetch(env: FakeEnvio, url: string) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (target !== url) throw new Error(`unscripted fetch ${target}`);
    return answerEnvio(env, String(init?.body ?? ''));
  };
}
