// Config is checked before a run starts. Sending is off unless DRY_RUN is exactly "false", and a key that is
// not KEEPER_ADDRESS's is refused before it signs anything. Errors name the variable, never its value.

import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { readEnv, type Env } from '../src/index';

// A throwaway test key (the well-known Foundry/Anvil account #1), never used for anything real.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADDRESS = privateKeyToAccount(KEY).address;

const base = (over: Partial<Env> = {}): Env =>
  ({
    ROUNDS_ADDRESS: '0x00000000000000000000000000000000000A11cE',
    POOLS_ADDRESS: '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195',
    KEEPER_ADDRESS: ADDRESS,
    RPC_URL: 'https://testnet-rpc.monad.xyz/',
    DATASTREAMS_URL: 'https://api.testnet-dataengine.chain.link',
    KEEPER_PRIVATE_KEY: KEY,
    DATASTREAMS_API_KEY: 'k',
    DATASTREAMS_API_SECRET: 's',
    HEALTHCHECKS_PING_URL: 'https://hc-ping.com/abc',
    ...over,
  }) as Env;

describe('keeper config', () => {
  it('is a dry run unless DRY_RUN is exactly "false"', () => {
    expect(readEnv(base()).cfg.dryRun).toBe(true);
    expect(readEnv(base({ DRY_RUN: 'true' })).cfg.dryRun).toBe(true);
    expect(readEnv(base({ DRY_RUN: 'no' })).cfg.dryRun).toBe(true);
    expect(readEnv(base({ DRY_RUN: 'false' })).cfg.dryRun).toBe(false);
  });

  it('refuses a key that does not belong to KEEPER_ADDRESS, without printing either', () => {
    const other = '0x0000000000000000000000000000000000000B0B';
    expect(() => readEnv(base({ KEEPER_ADDRESS: other }))).toThrow('KEEPER_PRIVATE_KEY does not belong to KEEPER_ADDRESS');
    try {
      readEnv(base({ KEEPER_ADDRESS: other }));
    } catch (e) {
      expect(String(e)).not.toContain(KEY.slice(2, 12));
    }
  });

  it('refuses an out-of-range key by name, without the value viem would print', () => {
    const zero = '0x' + '0'.repeat(64);
    expect(() => readEnv(base({ KEEPER_PRIVATE_KEY: zero }))).toThrow('KEEPER_PRIVATE_KEY is not a valid secp256k1 key');
    const max = '0x' + 'f'.repeat(64);
    try {
      readEnv(base({ KEEPER_PRIVATE_KEY: max }));
      throw new Error('accepted');
    } catch (e) {
      expect(String(e)).toBe('Error: KEEPER_PRIVATE_KEY is not a valid secp256k1 key');
    }
  });

  it('refuses a malformed key, a missing contract address and a non-HTTPS endpoint', () => {
    expect(() => readEnv(base({ KEEPER_PRIVATE_KEY: '0x1234' }))).toThrow('KEEPER_PRIVATE_KEY is not a 32-byte hex key');
    expect(() => readEnv(base({ ROUNDS_ADDRESS: '' }))).toThrow('ROUNDS_ADDRESS is not set');
    expect(() => readEnv(base({ RPC_URL: 'http://testnet-rpc.monad.xyz/' }))).toThrow('RPC_URL must be HTTPS');
  });
});
