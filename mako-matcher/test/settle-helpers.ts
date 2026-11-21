import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { Hex } from 'viem';
import type { Rec, WireProposal } from '../src/encode';
import type { Settler } from '../src/settle';
import { SETTLER_SCHEMA } from '../src/settle';
import { V } from './vectors';
import { resetSettlerStorage, rig, SettleWorld, type Rig } from './settle-world';

export function recOf(name: string, domain = 'testnet'): Rec {
  const f = V.orders[name].fields as Record<string, unknown>;
  const s = V.signed[domain][name];
  return {
    hash: s.orderHash,
    signature: (s.eoaSignature ?? s.safeSignature) as Hex,
    order: { salt: String(f.salt), maker: String(f.maker).toLowerCase() as Hex, marketId: String(f.marketId), option: Number(f.option), isBuy: Boolean(f.isBuy), price: Number(f.price), size: String(f.size), expiration: String(f.expiration), nonce: String(f.nonce) },
  };
}

export function prop(taker: string, makers: string[], fills?: string[], takerFill?: string, kind: WireProposal['kind'] = 'direct'): WireProposal {
  const f = fills ?? makers.map(() => '100000000');
  return { kind, marketId: '1', taker: recOf(taker), makers: makers.map((m) => recOf(m)), fills: f, takerFill: takerFill ?? f.reduce((a, b) => String(BigInt(a) + BigInt(b))) };
}

export const DIRECT = () => prop('directTakerBuy', ['directMakerSell']);
export const SAFE_MATCH = () => prop('safeTakerBuy', ['safeMakerSell']);

let n = 0;
/// Runs `fn` against a fresh settler storage (the real MatcherSettler Durable Object's SQLite).
export async function withSettler<T>(fn: (sql: SqlStorage, r: Rig, s: (sql: SqlStorage) => Settler) => Promise<T>, r: Rig = rig(new SettleWorld())): Promise<T> {
  const stub = env.SETTLER.get(env.SETTLER.idFromName(`settler-test-${n++}`));
  return runInDurableObject(stub, async (_i, state) => {
    resetSettlerStorage(state.storage.sql);
    return fn(state.storage.sql, r, (sql) => r.settler(sql));
  });
}

/// Submits a proposal and runs the settler until it has nothing left to do (bounded).
export async function drive(s: Settler, p: WireProposal | null, rounds = 3) {
  const sub = p ? await s.submit(p) : { accepted: false };
  for (let i = 0; i < rounds; i++) await s.run();
  return sub;
}

export const rows = <T = Record<string, unknown>>(sql: SqlStorage, q: string, ...a: unknown[]) => sql.exec(q, ...a).toArray() as T[];
void SETTLER_SCHEMA;
