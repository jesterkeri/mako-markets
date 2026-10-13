import 'server-only';

import { MONAD_TESTNET_ID } from './chain';
import { reserveEnvioCall } from './envio-budget';
import { parseUint64, type MeRoundsDiscoveryWire, type MeRoundsHeadWire } from './me-rounds-discovery';
import { ROUNDS_RELEASE_RECORD } from './rounds-release-record';

// The rounds one account takes part in, from the Envio indexer (ENVIO_ROUNDS_GRAPHQL_URL, schema in indexer/schema.graphql),
// for GET /api/me/rounds. See me-rounds-discovery.ts for why the reads below, in this order, leave nothing out, and
// how the head round's fingerprint binds the answer to the Rounds contract on chain.
//
// Every list is read in pages with a seek cursor on the row id (ascending, `id > last`), never an offset, and a list
// ends only on an EMPTY page: a short page is not trusted as the end, so a server that returns fewer rows than asked
// (a row cap on the hosted service) still yields the whole list. A list longer than MAX_ROWS is an error, never a
// partial answer. Any failure throws; the route answers it as an error status, never as an empty list.
//
// ENVIO_ROUNDS_GRAPHQL_URL is Me's own setting, apart from /stats' ENVIO_GRAPHQL_URL, so Me can move to an indexer built
// with RoundsSource while /stats stays on the deployment it has (Joshua, 2026-10-13: /stats untouched through judging).
//
// Every query also asks for the indexer's RoundsSource row (indexer/schema.graphql: the address and chain its round
// events came from), and every answer, every page, is refused unless that row names exactly the reviewed Rounds
// deployment (rounds-release-record.ts) on Monad testnet (Codex ME_ROUNDS R3). One GraphQL request is answered from one
// database, so each page carries its own proof of source: a gateway that sends some queries to another deployment's
// indexer fails the check on those pages, and nothing it says is used.
//
// Every request, each page included, first reserves a slot in the shared Envio budget (envio-budget.ts); a request
// without a slot is never sent, and the route answers rounds unavailable (Codex ME_ROUNDS R5).

export const PAGE_SIZE = 1000;
/// Rows read per list before the answer is refused as too long.
export const MAX_ROWS = 10_000;
const TIMEOUT_MS = 10_000;

export class IndexerNotConfigured extends Error {
  override name = 'IndexerNotConfigured';
}
export class IndexerFailed extends Error {
  override name = 'IndexerFailed';
}
export class TooManyRows extends Error {
  override name = 'TooManyRows';
}
/// An answer whose RoundsSource row is missing, malformed or not the reviewed Rounds deployment.
export class WrongSource extends Error {
  override name = 'WrongSource';
}

/// Asked in every query, beside the rows it is about.
const SOURCE = `RoundsSource(where: { id: { _eq: "rounds" } }) { sourceChain address }`;

export const HEAD_QUERY = `query MeRoundsHead {
  GlobalStats(where: { id: { _eq: "global" } }) { rounds }
  ${SOURCE}
}`;
/// The indexer's newest round (id = GlobalStats.rounds): its fingerprint, which the browser checks against roundOf on
/// chain before it trusts anything else in the answer (me-rounds-discovery.ts).
export const HEAD_ROUND_QUERY = `query MeRoundsHeadRound($id: String!) {
  Round(where: { id: { _eq: $id } }) { id openTime startTime creator }
  ${SOURCE}
}`;
export const ACTIVE_QUERY = `query MeRoundsActive($after: String!, $limit: Int!) {
  Round(where: { status: { _eq: "Active" }, id: { _gt: $after } }, order_by: { id: asc }, limit: $limit) { id }
  ${SOURCE}
}`;
export const ENTRIES_QUERY = `query MeRoundsEntries($wallet: String!, $after: String!, $limit: Int!) {
  RoundEntry(where: { wallet_id: { _eq: $wallet }, id: { _gt: $after } }, order_by: { id: asc }, limit: $limit) { id round_id }
  ${SOURCE}
}`;
export const CREATED_QUERY = `query MeRoundsCreated($creator: String!, $after: String!, $limit: Int!) {
  Round(where: { creator: { _eq: $creator }, id: { _gt: $after } }, order_by: { id: asc }, limit: $limit) { id }
  ${SOURCE}
}`;

const ROUND_ID = /^[1-9][0-9]{0,77}$/;

/// One query. Its RoundsSource rows are checked unless `sourceMayBeAbsent` and there are none (the head query only: an
/// indexer that has seen no round yet has no source row, which discoverMeRounds accepts only when it also has 0 rounds).
async function gql(url: string, query: string, variables: Record<string, unknown>, sourceMayBeAbsent = false): Promise<Record<string, unknown>> {
  await reserveEnvioCall();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) throw new IndexerFailed(`indexer answered ${res.status}`);
  const body = (await res.json()) as { data?: unknown; errors?: unknown };
  if (body.errors !== undefined || !body.data || typeof body.data !== 'object') throw new IndexerFailed('indexer answer not usable');
  const data = body.data as Record<string, unknown>;
  if (!(sourceMayBeAbsent && Array.isArray(data.RoundsSource) && data.RoundsSource.length === 0)) assertSource(data.RoundsSource);
  return data;
}

/// The answer's RoundsSource rows: exactly one, on Monad testnet, naming the reviewed Rounds address. Anything else
/// (no row, two rows, another chain, another address, "conflict", or no reviewed deployment at all) throws.
export function assertSource(rows: unknown): void {
  const expected = ROUNDS_RELEASE_RECORD?.address.toLowerCase();
  if (!expected) throw new WrongSource('no reviewed Rounds deployment');
  if (!Array.isArray(rows) || rows.length !== 1) throw new WrongSource('source row missing');
  const r = rows[0] as Record<string, unknown> | null;
  if (!r || r.sourceChain !== MONAD_TESTNET_ID || r.address !== expected) throw new WrongSource('source is not the reviewed Rounds deployment');
}

/// Every row of one list, paged by id. `pick` turns a row into its round id, or null if the row is malformed.
async function readAll(
  url: string,
  query: string,
  field: string,
  variables: Record<string, unknown>,
  pick: (row: Record<string, unknown>) => string | null,
): Promise<string[]> {
  const out: string[] = [];
  let after = '';
  // Row ids seen so far: a page that repeats one is not moving forward (the order is the database's collation, which
  // need not be JavaScript's, so the cursor is never compared here, only checked for repeats).
  const seen = new Set<string>();
  for (;;) {
    const data = await gql(url, query, { ...variables, after, limit: PAGE_SIZE });
    const rows = data[field];
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new IndexerFailed(`${field} page not usable`);
    if (rows.length === 0) return out;
    if (seen.size + rows.length > MAX_ROWS) throw new TooManyRows(field);
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      if (typeof r.id !== 'string' || r.id.length === 0 || seen.has(r.id)) throw new IndexerFailed(`${field} page repeats a row`);
      seen.add(r.id);
      const id = pick(r);
      if (id === null) throw new IndexerFailed(`${field} row not usable`);
      out.push(id);
      after = r.id;
    }
  }
}

const roundIdOf = (v: unknown): string | null => (typeof v === 'string' && ROUND_ID.test(v) ? v : null);
const LOWER_ADDRESS = /^0x[0-9a-f]{40}$/;

/// A Hasura BigInt (`numeric`) column holding a uint64: a decimal string, or a JSON number for a small value (the
/// hosted service may answer either), as a canonical decimal string. Anything else is null.
function uint64Of(v: unknown): string | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  const n = parseUint64(v);
  return n === null ? null : n.toString();
}

/// Round `id`'s fingerprint, the indexer's head round: exactly one row, that id, uint64 times, a lower-case creator
/// (the handler stores it lower-case). A missing or malformed row throws: the answer is never sent without it.
async function readHeadRound(url: string, id: string): Promise<MeRoundsHeadWire> {
  const data = await gql(url, HEAD_ROUND_QUERY, { id });
  const rows = data.Round;
  if (!Array.isArray(rows) || rows.length !== 1) throw new IndexerFailed('head round not usable');
  const r = rows[0] as Record<string, unknown>;
  const openTime = uint64Of(r.openTime);
  const startTime = uint64Of(r.startTime);
  if (r.id !== id || openTime === null || startTime === null || typeof r.creator !== 'string' || !LOWER_ADDRESS.test(r.creator)) {
    throw new IndexerFailed('head round not usable');
  }
  return { id, openTime, startTime, creator: r.creator };
}

/// The round ids relevant to `account` (a lower-case 0x address), as the route answers them.
export async function discoverMeRounds(account: string): Promise<MeRoundsDiscoveryWire> {
  const url = process.env.ENVIO_ROUNDS_GRAPHQL_URL?.trim();
  if (!url) throw new IndexerNotConfigured();

  // 1. The last round the indexer has seen scheduled. Read FIRST: everything read after it is at least as current.
  const head = await gql(url, HEAD_QUERY, {}, true);
  const rows = head.GlobalStats;
  if (!Array.isArray(rows) || rows.length > 1) throw new IndexerFailed('GlobalStats not usable');
  const rounds = rows.length === 0 ? 0 : (rows[0] as Record<string, unknown>).rounds;
  if (typeof rounds !== 'number' || !Number.isSafeInteger(rounds) || rounds < 0) throw new IndexerFailed('GlobalStats.rounds not usable');
  // The indexer writes its RoundsSource row with its first round, so before then it has none. That is accepted only at
  // 0 rounds, and then nothing else is asked: the answer claims no rounds, and the browser reads every round on chain
  // (me-rounds-discovery.ts), so whichever indexer said it, nothing can be hidden. With any round, the row must be there.
  const noSource = Array.isArray(head.RoundsSource) && head.RoundsSource.length === 0;
  if (noSource && rounds > 0) throw new WrongSource('source row missing');
  if (noSource) return { roundIds: [], indexedThrough: '0', head: null };
  // 1b. That round's fingerprint, which the browser compares with roundOf on chain before trusting anything here
  //     (me-rounds-discovery.ts, step 0). It never changes once scheduled, so reading it after (1) is enough.
  const headRound = rounds === 0 ? null : await readHeadRound(url, String(rounds));

  // 2. The rounds the indexer still has as Active, read after (1).
  const active = await readAll(url, ACTIVE_QUERY, 'Round', {}, (r) => roundIdOf(r.id));
  // 3. The account's entries and the rounds it created, read after (2).
  const [entered, created] = await Promise.all([
    readAll(url, ENTRIES_QUERY, 'RoundEntry', { wallet: account }, (r) => roundIdOf(r.round_id)),
    readAll(url, CREATED_QUERY, 'Round', { creator: account }, (r) => roundIdOf(r.id)),
  ]);

  const ids = [...new Set([...active, ...entered, ...created])].map((s) => BigInt(s)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { roundIds: ids.map((id) => id.toString()), indexedThrough: String(rounds), head: headRound };
}
