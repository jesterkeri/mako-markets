import { stringToHex, pad, type Hex } from 'viem';

/**
 * Encode a short string as bytes32 (UTF-8, right-padded with zeros).
 *
 * Used for the MakoMarkets `oracleRef` field. Examples:
 *   - `"BTC:gt:95000"` → `0x4254433a67743a393530303000...000`
 *   - `"514237:home_win:0"` → football match id + question type + param
 *
 * Throws if the UTF-8 encoding exceeds 32 bytes.
 */
export function toBytes32(s: string): Hex {
  const hex = stringToHex(s);
  const byteLength = (hex.length - 2) / 2;
  if (byteLength > 32) {
    throw new Error(`oracleRef "${s}" is ${byteLength} bytes, max is 32`);
  }
  return pad(hex, { size: 32, dir: 'right' });
}

/**
 * The canonical empty oracleRef for ADHOC markets (which don't resolve
 * via an external oracle — the creator/admin resolves manually).
 */
export const EMPTY_ORACLE_REF: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
