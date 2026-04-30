// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-errors.test.ts
//
// Coverage for the sub-phase B additions to aa-errors.ts. The original
// `summarizeAaError` shape is now a thin wrapper over
// `summarizeAaErrorWithCause`; both must remain non-throwing across every
// possible input shape.
//
// Specifically validates:
//   - Pimlico URL + API key + raw JSON-RPC bodies are scrubbed from
//     `scrubbedDetail` (server log path).
//   - Classification still maps to the documented codes after scrubbing.
//   - Inputs that are not Error / string / object don't crash either path.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';

import {
  summarizeAaError,
  summarizeAaErrorWithCause,
} from '../aa-errors';

describe('summarizeAaErrorWithCause', () => {
  it('strips the Pimlico API key from scrubbedDetail', () => {
    const e = new Error(
      'fetch failed: https://api.pimlico.io/v2/10143/rpc?apikey=pim_secret_key_abc123',
    );
    const result = summarizeAaErrorWithCause(e);
    expect(result.scrubbedDetail).not.toContain('pim_secret_key_abc123');
    expect(result.scrubbedDetail).not.toContain('apikey=pim_');
    expect(result.scrubbedDetail).not.toContain('api.pimlico.io');
  });

  it('strips raw JSON-RPC bodies from scrubbedDetail', () => {
    const e = new Error(
      'request failed: {"jsonrpc":"2.0","method":"eth_sendUserOperation","params":[{"sender":"0xdeadbeef"}]}',
    );
    const result = summarizeAaErrorWithCause(e);
    expect(result.scrubbedDetail).not.toContain('"jsonrpc"');
    expect(result.scrubbedDetail).not.toContain('eth_sendUserOperation');
    expect(result.scrubbedDetail).toContain('[redacted]');
  });

  it('strips JSON-RPC body when followed by punctuation (not just whitespace)', () => {
    // Common log shape: `body={"jsonrpc":...}, status=400`. The pre-fix
    // regex only redacted bodies followed by whitespace or end-of-string.
    const e = new Error(
      'log: body={"jsonrpc":"2.0","method":"eth_sendUserOperation","params":[]}, status=400',
    );
    const result = summarizeAaErrorWithCause(e);
    expect(result.scrubbedDetail).not.toContain('"jsonrpc"');
    expect(result.scrubbedDetail).not.toContain('eth_sendUserOperation');
  });

  it('preserves multi-line content outside the JSON-RPC line', () => {
    // Line-bounded redaction means subsequent lines stay intact.
    const e = new Error(
      'preceding context\nbody={"jsonrpc":"2.0","method":"eth_sendUserOperation"}\nfollowing context',
    );
    const result = summarizeAaErrorWithCause(e);
    expect(result.scrubbedDetail).toContain('preceding context');
    expect(result.scrubbedDetail).toContain('following context');
    expect(result.scrubbedDetail).not.toContain('eth_sendUserOperation');
  });

  it('classifies AUTH from "401 Unauthorized" message', () => {
    const e = new Error('401 Unauthorized: invalid api key');
    const result = summarizeAaErrorWithCause(e);
    expect(result.code).toBe('AUTH');
    expect(result.message).toMatch(/credentials/i);
  });

  it('classifies RATE_LIMIT from "429"', () => {
    const e = new Error('429 too many requests');
    const result = summarizeAaErrorWithCause(e);
    expect(result.code).toBe('RATE_LIMIT');
  });

  it('classifies PAYMASTER_EMPTY from AA21 + paymaster mention', () => {
    const e = new Error('AA21 didn\'t pay prefund: paymaster funds depleted');
    const result = summarizeAaErrorWithCause(e);
    expect(result.code).toBe('PAYMASTER_EMPTY');
  });

  it('classifies SIMULATION_REVERT from bare AA21 (no paymaster mention)', () => {
    // AA21 without paymaster/deposit/funds keywords routes to
    // SIMULATION_REVERT to avoid misleading users when the cause is
    // actually a code bug.
    const e = new Error('AA21 didn\'t pay prefund');
    const result = summarizeAaErrorWithCause(e);
    expect(result.code).toBe('SIMULATION_REVERT');
  });

  it('classifies SIG_VALIDATION from AA24', () => {
    const e = new Error('AA24 signature error');
    const result = summarizeAaErrorWithCause(e);
    expect(result.code).toBe('SIG_VALIDATION');
  });

  it('classifies NETWORK from fetch failure', () => {
    const e = new Error('fetch failed: ECONNREFUSED');
    const result = summarizeAaErrorWithCause(e);
    expect(result.code).toBe('NETWORK');
  });

  it('classifies UNKNOWN for unrecognized text', () => {
    const e = new Error('something completely unrelated');
    const result = summarizeAaErrorWithCause(e);
    expect(result.code).toBe('UNKNOWN');
  });

  it('handles plain string input', () => {
    const result = summarizeAaErrorWithCause('429 rate limited');
    expect(result.code).toBe('RATE_LIMIT');
  });

  it('handles plain object input', () => {
    const result = summarizeAaErrorWithCause({ code: -32000, message: 'AA24 invalid sig' });
    expect(result.code).toBe('SIG_VALIDATION');
  });

  it('handles undefined input without throwing', () => {
    expect(() => summarizeAaErrorWithCause(undefined)).not.toThrow();
    const result = summarizeAaErrorWithCause(undefined);
    expect(result.code).toBe('UNKNOWN');
  });

  it('handles null input without throwing', () => {
    expect(() => summarizeAaErrorWithCause(null)).not.toThrow();
  });

  it('handles a circular object without throwing', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => summarizeAaErrorWithCause(circular)).not.toThrow();
  });

  // ── Error detail capture (round-3 MINOR 1) ────────────────────────────
  // The plain `${e.name}: ${e.message}` form drops `cause` and own
  // enumerable fields. AA-flow errors (notably JsonRpcRejectError) put
  // the protocol code in `.code` / `.data` — losing those would
  // misclassify the error.

  it('captures own enumerable fields from custom Error subclasses', () => {
    // Mimic JsonRpcRejectError's shape with an AA24 code in .data.
    class CustomRpcError extends Error {
      code: number;
      data: unknown;
      method: string;
      constructor() {
        super('bundler returned -32000');
        this.name = 'CustomRpcError';
        this.code = -32000;
        this.method = 'eth_sendUserOperation';
        this.data = { aaCode: 'AA24 signature error' };
      }
    }
    const result = summarizeAaErrorWithCause(new CustomRpcError());
    expect(result.scrubbedDetail).toContain('AA24');
    expect(result.code).toBe('SIG_VALIDATION');
  });

  it('walks the cause chain', () => {
    const inner = new Error('inner: 429 too many requests');
    const middle = new Error('middle: wrapper');
    (middle as Error & { cause?: unknown }).cause = inner;
    const outer = new Error('outer: top-level');
    (outer as Error & { cause?: unknown }).cause = middle;

    const result = summarizeAaErrorWithCause(outer);
    expect(result.scrubbedDetail).toContain('caused by');
    expect(result.scrubbedDetail).toContain('429 too many requests');
    expect(result.code).toBe('RATE_LIMIT');
  });

  it('caps cause-chain depth so a malformed cycle does not run away', () => {
    // Self-referential cause chain. Helper must terminate.
    const e = new Error('cycle');
    (e as Error & { cause?: unknown }).cause = e;
    expect(() => summarizeAaErrorWithCause(e)).not.toThrow();
  });

  it('serializes BigInt fields without throwing', () => {
    class BigError extends Error {
      nonce: bigint;
      constructor() {
        super('AA24 invalid sig');
        this.nonce = 123n;
      }
    }
    const result = summarizeAaErrorWithCause(new BigError());
    expect(result.code).toBe('SIG_VALIDATION');
    // Nonce serialized via the safeStringify replacer ('123n').
    expect(result.scrubbedDetail).toMatch(/123n/);
  });
});

describe('summarizeAaError (back-compat)', () => {
  it('returns only code + message — scrubbedDetail is NOT present at runtime', () => {
    const result = summarizeAaError(
      new Error('429 rate limited at https://api.pimlico.io/v2/10143/rpc?apikey=pim_x'),
    );
    expect(result.code).toBe('RATE_LIMIT');
    expect(result.message).toBeDefined();
    // Critical: JSON.stringify must not surface scrubbedDetail to the
    // browser through this entry point. The typed return shape says
    // {code, message}; the runtime object must match.
    expect((result as { scrubbedDetail?: unknown }).scrubbedDetail).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('scrubbedDetail');
  });
});
