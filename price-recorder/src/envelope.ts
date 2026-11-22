// ----------------------------------------------------------------------------
// price-recorder/src/envelope.ts
//
// A Data Streams `fullReport` is an ABI envelope (bytes32[3] reportContext, bytes reportBlob, bytes32[] rs,
// bytes32[] ss, bytes32 rawVs). The signed report is field 1, the same split the probe used
// (mako-design/scripts/datastreams-probe3.mjs:70-74). The recorder does not verify every report on chain (plan 3.1);
// the blob goes to the resolver's own decodeVerified, and a parity test shows the blob equals the bytes
// VerifierProxy.verify returns for the same report.
// ----------------------------------------------------------------------------

import { decodeAbiParameters, type Hex } from 'viem';

const ENVELOPE = [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }] as const;

/// The report blob inside `fullReport`, lower case, or null if the value is not a well-formed envelope.
export function reportBlob(fullReport: unknown): Hex | null {
  if (typeof fullReport !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(fullReport)) return null;
  try {
    return (decodeAbiParameters(ENVELOPE, fullReport as Hex)[1] as Hex).toLowerCase() as Hex;
  } catch {
    return null;
  }
}
