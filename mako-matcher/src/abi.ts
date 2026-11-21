// The exchange ABI is the vendored copy of the compiled artifact's `abi` field (data/, scripts/vendor.mjs), never
// retyped. These are thin wrappers so call sites read as plain functions.
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, type Abi, type Hex } from 'viem';
import exchangeAbiJson from '../data/MakoOutcomeExchangeV1.abi.json';

export const EXCHANGE_ABI = exchangeAbiJson as unknown as Abi;

export function encodeCall(functionName: string, args: readonly unknown[] = []): Hex {
  return encodeFunctionData({ abi: EXCHANGE_ABI, functionName, args });
}

export function decodeResult(functionName: string, data: Hex): unknown {
  return decodeFunctionResult({ abi: EXCHANGE_ABI, functionName, data });
}

/// The wire shape of the contract's `Order` tuple.
export interface OrderTuple {
  salt: bigint;
  maker: Hex;
  marketId: bigint;
  option: number;
  isBuy: boolean;
  price: number;
  size: bigint;
  expiration: bigint;
  nonce: bigint;
}

export interface MarketView {
  nOptions: number;
  status: number;
  tradingClose: bigint;
  positionCap: bigint;
}

/// `marketOf` returns a struct; viem decodes a single tuple output to an object with named fields.
export function decodeMarketOf(data: Hex): MarketView | null {
  try {
    const m = decodeResult('marketOf', data) as { nOptions: number; status: number; tradingClose: bigint; positionCap: bigint };
    return { nOptions: Number(m.nOptions), status: Number(m.status), tradingClose: BigInt(m.tradingClose), positionCap: BigInt(m.positionCap) };
  } catch {
    return null;
  }
}

export const MARKET_STATUS_OPEN = 1;

export type ExchangeLog =
  | { kind: 'cancelled'; orderHash: Hex; maker: Hex; block: bigint }
  | { kind: 'nonce'; account: Hex; nonce: bigint; block: bigint };

/// Decodes the two events the Worker reads (`Cancelled`, `NonceIncremented`). Anything else, or anything that
/// does not decode, is null: the caller stops and retries rather than guessing.
export function decodeExchangeLog(log: { topics: Hex[]; data: Hex; blockNumber: Hex }): ExchangeLog | null {
  try {
    const ev = decodeEventLog({ abi: EXCHANGE_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    const block = BigInt(log.blockNumber);
    if (ev.eventName === 'Cancelled') {
      const a = ev.args as unknown as { orderHash: Hex; maker: Hex };
      return { kind: 'cancelled', orderHash: a.orderHash.toLowerCase() as Hex, maker: a.maker.toLowerCase() as Hex, block };
    }
    if (ev.eventName === 'NonceIncremented') {
      const a = ev.args as unknown as { account: Hex; nonce: bigint };
      return { kind: 'nonce', account: a.account.toLowerCase() as Hex, nonce: BigInt(a.nonce), block };
    }
    return null;
  } catch {
    return null;
  }
}
