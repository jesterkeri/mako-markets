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
