// The book's storage: one SQLite table in the market Durable Object. An order and its signature are ONE row
// (plan 6.2 step 4: "stored as one record and never separately"); the signature column is NOT NULL and has a
// length check, so a row without one cannot exist.
import type { Hex } from 'viem';
import type { OrderTuple } from './abi';

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     hash TEXT NOT NULL UNIQUE,
     maker TEXT NOT NULL,
     salt TEXT NOT NULL,
     market_id TEXT NOT NULL,
     option INTEGER NOT NULL,
     is_buy INTEGER NOT NULL,
     price INTEGER NOT NULL,
     size TEXT NOT NULL,
     expiration INTEGER NOT NULL,
     nonce TEXT NOT NULL,
     signature TEXT NOT NULL CHECK (length(signature) >= 4),
     fee TEXT NOT NULL,
     filled TEXT NOT NULL DEFAULT '0',
     created_at INTEGER NOT NULL,
     in_flight INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS orders_maker ON orders (maker)`,
  `CREATE TABLE IF NOT EXISTS outcomes_seen (id TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, code TEXT NOT NULL, detail TEXT NOT NULL)`,
];

export function migrate(sql: SqlStorage): void {
  for (const s of SCHEMA) sql.exec(s);
}

/// A booked order: the signed fields, the signature that goes with them, and what is left of it.
export interface BookOrder extends OrderTuple {
  seq: number;
  hash: Hex;
  signature: Hex;
  /// feeOf(size, price) read at intake, for a buy; 0 for a sell.
  fee: bigint;
  filled: bigint;
  remaining: bigint;
  createdAt: number;
  /// In a proposal the settler accepted and has not yet reported on (survives a restart).
  inFlight: boolean;
}

type Row = {
  seq: number;
  hash: string;
  maker: string;
  salt: string;
  market_id: string;
  option: number;
  is_buy: number;
  price: number;
  size: string;
  expiration: number;
  nonce: string;
  signature: string;
  fee: string;
  filled: string;
  created_at: number;
  in_flight: number;
};

function fromRow(r: Row): BookOrder {
  const size = BigInt(r.size);
  const filled = BigInt(r.filled);
  return {
    seq: r.seq,
    hash: r.hash as Hex,
    maker: r.maker as Hex,
    salt: BigInt(r.salt),
    marketId: BigInt(r.market_id),
    option: r.option,
    isBuy: r.is_buy === 1,
    price: r.price,
    size,
    expiration: BigInt(r.expiration),
    nonce: BigInt(r.nonce),
    signature: r.signature as Hex,
    fee: BigInt(r.fee),
    filled,
    remaining: size - filled,
    createdAt: r.created_at,
    inFlight: r.in_flight !== 0,
  };
}

export function allOrders(sql: SqlStorage): BookOrder[] {
  return sql.exec<Row>(`SELECT * FROM orders ORDER BY seq ASC`).toArray().map(fromRow);
}

export function getOrder(sql: SqlStorage, hash: Hex): BookOrder | null {
  const r = sql.exec<Row>(`SELECT * FROM orders WHERE hash = ?`, hash).toArray()[0];
  return r ? fromRow(r) : null;
}

export function countOrders(sql: SqlStorage): number {
  return Number(sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM orders`).one().n);
}

export function openCount(sql: SqlStorage, maker: Hex): number {
  return Number(sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE maker = ?`, maker).one().n);
}

export function insertOrder(sql: SqlStorage, o: OrderTuple, hash: Hex, signature: Hex, fee: bigint, filled: bigint, now: number): void {
  sql.exec(
    `INSERT INTO orders (hash, maker, salt, market_id, option, is_buy, price, size, expiration, nonce, signature, fee, filled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    hash,
    o.maker,
    o.salt.toString(),
    o.marketId.toString(),
    o.option,
    o.isBuy ? 1 : 0,
    o.price,
    o.size.toString(),
    Number(o.expiration),
    o.nonce.toString(),
    signature,
    fee.toString(),
    filled.toString(),
    now,
  );
}

export function deleteByHash(sql: SqlStorage, hash: Hex): boolean {
  const c = sql.exec(`DELETE FROM orders WHERE hash = ?`, hash);
  return c.rowsWritten > 0;
}

/// Plan 6.2 "Cancels made on chain": a nonce bump drops every order of that maker below the new nonce.
export function deleteBelowNonce(sql: SqlStorage, maker: Hex, newNonce: bigint): number {
  let n = 0;
  for (const r of sql.exec<{ hash: string; nonce: string }>(`SELECT hash, nonce FROM orders WHERE maker = ?`, maker).toArray()) {
    if (BigInt(r.nonce) < newNonce) {
      sql.exec(`DELETE FROM orders WHERE hash = ?`, r.hash);
      n++;
    }
  }
  return n;
}

export function deleteExpired(sql: SqlStorage, nowSeconds: number): number {
  const c = sql.exec(`DELETE FROM orders WHERE expiration <= ?`, nowSeconds);
  return c.rowsWritten;
}

/// What this market's resting orders of `maker` have reserved (plan 6.2 step 3, the scope as written: per market
/// Durable Object; cash is shared by all markets, so it is NOT reserved across them).
export function reservations(orders: BookOrder[], maker: Hex, option: number): { cash: bigint; shares: bigint } {
  let cash = 0n;
  let shares = 0n;
  for (const o of orders) {
    if (o.maker !== maker) continue;
    if (o.isBuy) cash += buyCost(o.remaining, o.price, o.fee, o.size);
    else if (o.option === option) shares += o.remaining;
  }
  return { cash, shares };
}

/// Cash a buy of `qty` base units at `price` cents needs: qty x price / 100 (exact, since qty is a multiple of
/// 10^4), plus the fee scaled to the quantity, rounded up.
export function buyCost(qty: bigint, price: number, feeForSize: bigint, size: bigint): bigint {
  const fee = size === 0n ? 0n : (feeForSize * qty + size - 1n) / size;
  return (qty * BigInt(price)) / 100n + fee;
}

export function getMeta(sql: SqlStorage, k: string): string | null {
  const r = sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
  return r ? r.v : null;
}

export function setMeta(sql: SqlStorage, k: string, v: string): void {
  sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
}

export function delMeta(sql: SqlStorage, k: string): void {
  sql.exec(`DELETE FROM meta WHERE k = ?`, k);
}

/// The mark holds the time it was set (ms), so a mark the settler never heard of can be found and released.
export function markInFlight(sql: SqlStorage, hashes: Hex[], nowMs: number): void {
  for (const h of hashes) sql.exec(`UPDATE orders SET in_flight = ? WHERE hash = ?`, Math.max(1, nowMs), h);
}

export function marksOlderThan(sql: SqlStorage, beforeMs: number): Hex[] {
  return sql.exec<{ hash: Hex }>(`SELECT hash FROM orders WHERE in_flight > 0 AND in_flight < ?`, beforeMs).toArray().map((r) => r.hash);
}

export function releaseInFlight(sql: SqlStorage, hashes: Hex[]): void {
  for (const h of hashes) sql.exec(`UPDATE orders SET in_flight = 0 WHERE hash = ?`, h);
}

/// A settled fill. What is left stays booked and matchable, however small: it is dropped only when it is filled,
/// expires, is cancelled or is refused (never for its size; intake's 10-share rule is for NEW orders only).
export function applyFill(sql: SqlStorage, hash: Hex, fill: bigint): void {
  const o = getOrder(sql, hash);
  if (!o) return;
  const filled = o.filled + fill;
  if (filled >= o.size) sql.exec(`DELETE FROM orders WHERE hash = ?`, hash);
  else sql.exec(`UPDATE orders SET filled = ? WHERE hash = ?`, filled.toString(), hash);
}

export function deleteByMaker(sql: SqlStorage, maker: Hex): number {
  return sql.exec(`DELETE FROM orders WHERE maker = ?`, maker).rowsWritten;
}

/// Plan 6.2: an account refused for the UTC day has its booked orders dropped as refused, in every market (Codex MATCHER
/// R6 F1: only the market whose settlement failed got the outcome that drops them). Orders in flight stay until their
/// outcome or release; a later call drops them. Returns how many were dropped.
export function dropRefused(sql: SqlStorage, refused: Set<Hex>): number {
  let n = 0;
  for (const { maker } of sql.exec<{ maker: string }>(`SELECT DISTINCT maker FROM orders`).toArray()) {
    if (refused.has(maker.toLowerCase() as Hex)) n += sql.exec(`DELETE FROM orders WHERE maker = ? AND in_flight = 0`, maker).rowsWritten;
  }
  return n;
}

export function deleteAll(sql: SqlStorage): number {
  return sql.exec(`DELETE FROM orders`).rowsWritten;
}
