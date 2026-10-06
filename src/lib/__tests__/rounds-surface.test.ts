// Codex T1.4 r2: the app's sponsored Rounds selectors, the contracts repository's surface gate and the compiled
// MakoRoundsV1 must agree, and a change to ONE side alone must fail. The unit cases mutate one copy at a time; the
// cross-repository case reads a real checkout of jesterkeri/mako-contracts at ROUNDS_CONTRACTS_COMMIT and runs forge
// there. CI sets MAKO_CONTRACTS_DIR and REQUIRE_ROUNDS_SURFACE=1, so in CI it cannot be skipped.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { roundsAbi } from '@/lib/rounds-abi';
import { ROUND_SPONSORED } from '@/lib/rounds-call-allowlist';
import { parseGateSponsored, ROUNDS_CONTRACTS_COMMIT, roundsSurfaceProblems, type SurfaceInput } from '@/lib/rounds-surface';

const GATE = {
  'enter(uint256,uint8,uint256)': '9ad6c260',
  'claim(uint256)': '379607f5',
  'schedule(uint64)': '0ad9f5d2',
  'finalizeRefund(uint256)': 'e6d6aedc',
};
const IDS = { ...GATE, 'settle(uint256,bytes,bytes)': '577b64a0', 'withdrawTreasury()': '166bab95' };
const base = (): SurfaceInput => ({
  appSponsored: { ...ROUND_SPONSORED },
  appAbi: roundsAbi,
  gateSponsored: { ...GATE },
  compiledIds: { ...IDS },
  compiledAbi: roundsAbi,
});

describe('the three copies of the sponsored Rounds surface', () => {
  it('agree as committed', () => {
    expect(roundsSurfaceProblems(base())).toEqual([]);
  });

  it('an app selector changed alone fails', () => {
    const i = base();
    i.appSponsored = { ...i.appSponsored, 'enter(uint256,uint8,uint256)': '0xdeadbeef' };
    expect(roundsSurfaceProblems(i).join('\n')).toContain('app selector 0xdeadbeef');
  });

  it('an app signature swapped alone fails, even with a matching selector of its own', () => {
    const i = base();
    const { ['enter(uint256,uint8,uint256)']: _drop, ...rest } = i.appSponsored;
    void _drop;
    i.appSponsored = { ...rest, 'enter(uint256,uint8,uint128)': '0x11111111' };
    const p = roundsSurfaceProblems(i).join('\n');
    expect(p).toContain('sponsored signatures differ');
    expect(p).toContain('enter(uint256,uint8,uint128) is not a function of the compiled MakoRoundsV1');
  });

  it('a fifth app entry fails', () => {
    const i = base();
    i.appSponsored = { ...i.appSponsored, 'settle(uint256,bytes,bytes)': '0x577b64a0' };
    expect(roundsSurfaceProblems(i).join('\n')).toContain('not exactly four');
  });

  it('the contracts gate changed alone fails', () => {
    const i = base();
    i.gateSponsored = { ...i.gateSponsored, 'claim(uint256)': 'aaaaaaaa' };
    expect(roundsSurfaceProblems(i).join('\n')).toContain('contracts gate selector 0xaaaaaaaa');
  });

  it('the compiled contract changed alone fails', () => {
    const i = base();
    const { ['schedule(uint64)']: _gone, ...ids } = i.compiledIds;
    void _gone;
    i.compiledIds = { ...ids, 'schedule(uint32)': '12345678' };
    expect(roundsSurfaceProblems(i).join('\n')).toContain('schedule(uint64) is not a function of the compiled MakoRoundsV1');
  });

  it('an app ABI edited alone fails', () => {
    const i = base();
    i.appAbi = JSON.parse(JSON.stringify(roundsAbi).replace('"name":"enter"', '"name":"enterX"'));
    expect(roundsSurfaceProblems(i).join('\n')).toContain('regenerate it');
  });

  it('reads the gate literal exactly, and refuses one it cannot read', () => {
    const src = `x\nconst SPONSORED = {\n  'enter(uint256,uint8,uint256)': '9ad6c260',\n  'claim(uint256)': '379607f5',\n};\ny`;
    expect(parseGateSponsored(src)).toEqual({ 'enter(uint256,uint8,uint256)': '9ad6c260', 'claim(uint256)': '379607f5' });
    expect(() => parseGateSponsored(src.replace("'379607f5'", 'CLAIM_SEL'))).toThrow('cannot read');
    expect(() => parseGateSponsored('const OTHER = {};')).toThrow('not found');
  });
});

const DIR = process.env.MAKO_CONTRACTS_DIR ?? '';

describe('against the real contracts repository', () => {
  it('runs in CI', () => {
    if (process.env.REQUIRE_ROUNDS_SURFACE === '1') expect(DIR, 'MAKO_CONTRACTS_DIR must be set in CI').not.toBe('');
  });

  it.runIf(DIR)('the checkout is the pinned commit, and all three copies agree', () => {
    const git = (...a: string[]) => execFileSync('git', ['-C', DIR, ...a], { encoding: 'utf8' }).trim();
    expect(git('rev-parse', 'HEAD')).toBe(ROUNDS_CONTRACTS_COMMIT);
    const forge = (what: string) =>
      JSON.parse(execFileSync('forge', ['inspect', 'src/MakoRoundsV1.sol:MakoRoundsV1', what, '--json'], { cwd: DIR, encoding: 'utf8' }));
    const problems = roundsSurfaceProblems({
      appSponsored: ROUND_SPONSORED,
      appAbi: roundsAbi,
      gateSponsored: parseGateSponsored(readFileSync(join(DIR, 'script/check-surface.mjs'), 'utf8')),
      compiledIds: forge('methodIdentifiers'),
      compiledAbi: forge('abi'),
    });
    expect(problems).toEqual([]);
  }, 300_000);
});
