// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/create-form.test.ts
//
// Phase 2C-2 Step 11 — pure tests for the form module:
//   - validatePmCreateForm: common rules + per-shape matrix
//   - byteLength: UTF-8 byte semantics (not JS char count)
//   - buildCreateParams + buildCreateParamsWithoutNonce: round-trip
//     to the 17-field PmCreateParamsTuple, including int enum mapping
//     and invariant throws on values the validator should have caught
//
// No fetch, no React, no DB. The validator mirrors
// MakoPrivateMarketsV1._validateCreate (lines 481-516); these tests
// pin every documented rule so a refactor that drops one fires loudly.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { toHex } from 'viem';

import {
  byteLength,
  buildCreateParams,
  buildCreateParamsWithoutNonce,
  initialFormStateForShape,
  PmFormInvariantError,
  validatePmCreateForm,
  type PmCreateFormState,
} from '../create-form';
import {
  PM_MAX_ALLOWLIST,
  PM_MAX_DESCRIPTION_BYTES,
  PM_MAX_OPTION_LABEL_BYTES,
  PM_MAX_OPTIONS,
  PM_MAX_STREAM_URL_BYTES,
  PM_MAX_TITLE_BYTES,
  PM_MAX_WINNERS,
  PM_MIN_STAKE_USDC_BASE_UNITS,
} from '@/lib/aa-constants';

// ─── Test fixtures ─────────────────────────────────────────────────────────

// NOW is well before FUTURE_*_ISO so the validator's "no past time"
// rule accepts the fixture dates. NOW = 2023-11 (1_700_000_000s).
const NOW = 1_700_000_000;
const FUTURE_OPEN_ISO = '2030-01-01T12:00';
const FUTURE_CLOSE_ISO = '2030-01-01T13:00';
const FUTURE_OPEN_UNIX = Math.floor(new Date(FUTURE_OPEN_ISO).getTime() / 1000);
const FUTURE_CLOSE_UNIX = Math.floor(new Date(FUTURE_CLOSE_ISO).getTime() / 1000);

const ADDR_A = '0x1111111111111111111111111111111111111111' as const;
const ADDR_B = '0x2222222222222222222222222222222222222222' as const;
const ADDR_C = '0x3333333333333333333333333333333333333333' as const;
// A real EIP-55 checksummed address (vitalik.eth's well-known
// resolution). viem's `isAddress` runs strict checksum validation
// on mixed-case inputs and rejects anything that isn't a valid
// checksum — so we cannot use a hand-rolled mixed-case value here.
// Both ADDR_MIXED and ADDR_MIXED_LOWER pass `isAddress`; they're
// the same 20-byte address in different cases, used to verify
// case-insensitive dedupe + lowercase normalization in the builder.
const ADDR_MIXED = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as const;
const ADDR_MIXED_LOWER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' as const;
const TREASURY = '0x9999999999999999999999999999999999999999' as const;
const NONCE = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

/// Spread on top of an initial state to make a valid form for that
/// shape — title, dates, and any per-shape requirements that aren't
/// already covered by initialFormStateForShape's defaults. Tests then
/// override individual fields to assert the targeted failure mode.
function validFriendly(): PmCreateFormState {
  return {
    ...initialFormStateForShape('friendly'),
    title: 'Hello',
    stakingOpensAtIso: FUTURE_OPEN_ISO,
    closeAtIso: FUTURE_CLOSE_ISO,
  };
}

function validOpenVote(): PmCreateFormState {
  return {
    ...initialFormStateForShape('open_vote'),
    title: 'Hello',
    optionLabels: ['A', 'B'],
    fixedStake: '1.00',
    stakingOpensAtIso: FUTURE_OPEN_ISO,
    closeAtIso: FUTURE_CLOSE_ISO,
  };
}

function validPrizePool(): PmCreateFormState {
  return {
    ...initialFormStateForShape('prize_pool'),
    title: 'Hello',
    optionLabels: ['Alice', 'Bob'],
    participantWallets: [ADDR_A, ADDR_B],
    stakingOpensAtIso: FUTURE_OPEN_ISO,
    closeAtIso: FUTURE_CLOSE_ISO,
  };
}

// ─── byteLength ────────────────────────────────────────────────────────────

describe('byteLength', () => {
  it('returns 0 for empty string', () => {
    expect(byteLength('')).toBe(0);
  });
  it('returns ASCII char count for plain ASCII', () => {
    expect(byteLength('hello')).toBe(5);
  });
  it('counts a 2-byte UTF-8 character', () => {
    // 'é' is 0xC3 0xA9 — 2 bytes, 1 JS char.
    expect(byteLength('é')).toBe(2);
  });
  it('counts a 4-byte emoji', () => {
    // '🦈' is a 4-byte UTF-8 codepoint, encoded as 2 JS chars (surrogate
    // pair). String.length lies; byteLength must not.
    expect('🦈'.length).toBe(2);
    expect(byteLength('🦈')).toBe(4);
  });
});

// ─── initialFormStateForShape ──────────────────────────────────────────────

describe('initialFormStateForShape', () => {
  it('friendly seeds locked NO/YES options + winnersCount=0', () => {
    const s = initialFormStateForShape('friendly');
    expect(s.shape).toBe('friendly');
    expect(s.optionLabels).toEqual(['NO', 'YES']);
    expect(s.participantWallets).toEqual([]);
    expect(s.winnersCount).toBe(0);
  });
  it('open_vote seeds 2 blank options + winnersCount=1', () => {
    const s = initialFormStateForShape('open_vote');
    expect(s.optionLabels).toEqual(['', '']);
    expect(s.participantWallets).toEqual([]);
    expect(s.winnersCount).toBe(1);
  });
  it('prize_pool seeds 2 blank options + 2 blank participants', () => {
    const s = initialFormStateForShape('prize_pool');
    expect(s.optionLabels).toEqual(['', '']);
    expect(s.participantWallets).toEqual(['', '']);
    expect(s.winnersCount).toBe(1);
  });
});

// ─── validatePmCreateForm: common rules ────────────────────────────────────

describe('validatePmCreateForm — title', () => {
  it('rejects empty title', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), title: '' },
      { nowSeconds: NOW },
    );
    expect(e.title).toBe('TITLE REQUIRED');
  });
  it('rejects title above the byte cap', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), title: 'x'.repeat(PM_MAX_TITLE_BYTES + 1) },
      { nowSeconds: NOW },
    );
    expect(e.title).toMatch(/EXCEEDS/);
  });
  it('accepts a title at the byte cap', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), title: 'x'.repeat(PM_MAX_TITLE_BYTES) },
      { nowSeconds: NOW },
    );
    expect(e.title).toBeUndefined();
  });
  it('measures title in bytes, not JS chars (emoji over the cap)', () => {
    // PM_MAX_TITLE_BYTES is 100. 26 sharks = 104 bytes (4 each), 52 JS
    // chars (2 each via surrogate pair). A naive .length check would
    // pass; the byte check must fail.
    const sharks = '🦈'.repeat(26);
    expect(sharks.length).toBe(52); // surrogate-pair JS length
    const e = validatePmCreateForm(
      { ...validFriendly(), title: sharks },
      { nowSeconds: NOW },
    );
    expect(e.title).toMatch(/EXCEEDS/);
  });
});

describe('validatePmCreateForm — description', () => {
  it('accepts empty description (optional field)', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), description: '' },
      { nowSeconds: NOW },
    );
    expect(e.description).toBeUndefined();
  });
  it('rejects above the byte cap', () => {
    const e = validatePmCreateForm(
      {
        ...validFriendly(),
        description: 'x'.repeat(PM_MAX_DESCRIPTION_BYTES + 1),
      },
      { nowSeconds: NOW },
    );
    expect(e.description).toMatch(/EXCEEDS/);
  });
});

describe('validatePmCreateForm — streamUrl', () => {
  it('accepts empty (optional)', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), streamUrl: '' },
      { nowSeconds: NOW },
    );
    expect(e.streamUrl).toBeUndefined();
  });
  it('rejects non-https URL', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), streamUrl: 'http://example.com' },
      { nowSeconds: NOW },
    );
    expect(e.streamUrl).toMatch(/HTTPS/);
  });
  it('accepts an https URL', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), streamUrl: 'https://example.com/live' },
      { nowSeconds: NOW },
    );
    expect(e.streamUrl).toBeUndefined();
  });
  it('rejects above the byte cap', () => {
    const e = validatePmCreateForm(
      {
        ...validFriendly(),
        streamUrl: 'https://' + 'a'.repeat(PM_MAX_STREAM_URL_BYTES),
      },
      { nowSeconds: NOW },
    );
    expect(e.streamUrl).toMatch(/EXCEEDS/);
  });
});

describe('validatePmCreateForm — timing', () => {
  it('rejects missing stakingOpensAt', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), stakingOpensAtIso: '' },
      { nowSeconds: NOW },
    );
    expect(e.stakingOpensAtIso).toBe('STAKING OPENS AT REQUIRED');
  });
  it('rejects stakingOpensAt strictly in the past', () => {
    const e = validatePmCreateForm(
      validFriendly(),
      // Force `now` to be far after the FUTURE_* constants so the
      // future ISO becomes "past" from the validator's perspective.
      { nowSeconds: FUTURE_OPEN_UNIX + 60 },
    );
    expect(e.stakingOpensAtIso).toMatch(/PAST/);
  });
  it('accepts stakingOpensAt at exactly now (Codex r2 MAJ-2 pin)', () => {
    const e = validatePmCreateForm(
      validFriendly(),
      { nowSeconds: FUTURE_OPEN_UNIX },
    );
    // Equality is valid; only `<` rejects.
    expect(e.stakingOpensAtIso).toBeUndefined();
  });
  it('rejects missing closeAt', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), closeAtIso: '' },
      { nowSeconds: NOW },
    );
    expect(e.closeAtIso).toBe('CLOSE AT REQUIRED');
  });
  it('rejects closeAt equal to stakingOpensAt', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), closeAtIso: FUTURE_OPEN_ISO },
      { nowSeconds: NOW },
    );
    expect(e.closeAtIso).toMatch(/AFTER/);
  });
  it('rejects closeAt before stakingOpensAt', () => {
    const e = validatePmCreateForm(
      {
        ...validFriendly(),
        stakingOpensAtIso: FUTURE_CLOSE_ISO,
        closeAtIso: FUTURE_OPEN_ISO,
      },
      { nowSeconds: NOW },
    );
    expect(e.closeAtIso).toMatch(/AFTER/);
  });
});

describe('validatePmCreateForm — allowlist (allowlisted mode)', () => {
  function withAllowlist(list: string[]): PmCreateFormState {
    return {
      ...validFriendly(),
      participationMode: 'allowlisted',
      allowlist: list,
    };
  }

  it('rejects empty list when allowlisted', () => {
    const e = validatePmCreateForm(withAllowlist([]), { nowSeconds: NOW });
    expect(e.allowlist).toMatch(/REQUIRED/);
  });
  it('accepts a single valid address', () => {
    const e = validatePmCreateForm(withAllowlist([ADDR_A]), { nowSeconds: NOW });
    expect(e.allowlist).toBeUndefined();
  });
  it('rejects invalid hex address', () => {
    const e = validatePmCreateForm(
      withAllowlist(['0xnothex']),
      { nowSeconds: NOW },
    );
    expect(e.allowlist).toMatch(/INVALID/);
  });
  it('rejects duplicate (case-insensitive)', () => {
    // Mixed-case + lowercased forms of the same address. The validator
    // must dedupe by lowercased comparison, NOT raw string equality.
    const e = validatePmCreateForm(
      withAllowlist([ADDR_MIXED, ADDR_MIXED_LOWER]),
      { nowSeconds: NOW },
    );
    expect(e.allowlist).toMatch(/DUPLICATE/);
  });
  it('rejects treasury address when treasury provided', () => {
    const e = validatePmCreateForm(withAllowlist([TREASURY]), {
      nowSeconds: NOW,
      treasuryAddress: TREASURY,
    });
    expect(e.allowlist).toMatch(/TREASURY/);
  });
  it('skips treasury check when treasury is null', () => {
    const e = validatePmCreateForm(withAllowlist([TREASURY]), {
      nowSeconds: NOW,
      treasuryAddress: null,
    });
    // No treasury → no treasury error; address itself is valid.
    expect(e.allowlist).toBeUndefined();
  });
  it('rejects above PM_MAX_ALLOWLIST', () => {
    const list = Array.from({ length: PM_MAX_ALLOWLIST + 1 }, (_, i) =>
      `0x${(i + 1).toString(16).padStart(40, '0')}`,
    );
    const e = validatePmCreateForm(withAllowlist(list), { nowSeconds: NOW });
    expect(e.allowlist).toMatch(/EXCEEDS/);
  });
  it('ignores empty / whitespace lines (textarea artifact)', () => {
    const e = validatePmCreateForm(
      withAllowlist(['', '  ', ADDR_A, '\t']),
      { nowSeconds: NOW },
    );
    expect(e.allowlist).toBeUndefined();
  });
  it('skips allowlist checks entirely when participation = open', () => {
    // Even with garbage in the list, the validator should not look at
    // it when mode is open. Friendly default is `open`.
    const e = validatePmCreateForm(
      { ...validFriendly(), allowlist: ['0xnothex'] },
      { nowSeconds: NOW },
    );
    expect(e.allowlist).toBeUndefined();
  });
});

describe('validatePmCreateForm — option labels (common)', () => {
  it('rejects an empty label slot', () => {
    const e = validatePmCreateForm(
      { ...validOpenVote(), optionLabels: ['A', ''] },
      { nowSeconds: NOW },
    );
    expect(e.optionLabels).toMatch(/REQUIRED/);
  });
  it('rejects an oversize label', () => {
    const e = validatePmCreateForm(
      {
        ...validOpenVote(),
        optionLabels: ['A', 'x'.repeat(PM_MAX_OPTION_LABEL_BYTES + 1)],
      },
      { nowSeconds: NOW },
    );
    expect(e.optionLabels).toMatch(/EXCEEDS/);
  });
});

// ─── Friendly shape ────────────────────────────────────────────────────────

describe('validatePmCreateForm — friendly shape', () => {
  it('valid friendly state has no errors', () => {
    expect(validatePmCreateForm(validFriendly(), { nowSeconds: NOW })).toEqual({});
  });
  it('rejects optionLabels not equal to [NO, YES]', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), optionLabels: ['YES', 'NO'] }, // reversed
      { nowSeconds: NOW },
    );
    expect(e.optionLabels).toMatch(/LOCKED/);
  });
  it('rejects non-empty participantWallets', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), participantWallets: [ADDR_A] },
      { nowSeconds: NOW },
    );
    expect(e.participantWallets).toMatch(/NO PARTICIPANTS/);
  });
  it('rejects perWalletCumulativeMax != 0', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), perWalletCumulativeMax: '1.00' },
      { nowSeconds: NOW },
    );
    expect(e.perWalletCumulativeMax).toMatch(/MUST BE 0/);
  });
  it('rejects fixedStake != 0', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), fixedStake: '0.5' },
      { nowSeconds: NOW },
    );
    expect(e.fixedStake).toMatch(/MUST BE 0/);
  });
  it('rejects winnersCount != 0', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), winnersCount: 1 },
      { nowSeconds: NOW },
    );
    expect(e.winnersCount).toMatch(/MUST BE 0/);
  });
  it('accepts perStakeMin = 0', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), perStakeMin: '0' },
      { nowSeconds: NOW },
    );
    expect(e.perStakeMin).toBeUndefined();
  });
  it('rejects perStakeMin between 0 and the floor (e.g. 0.001)', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), perStakeMin: '0.001' },
      { nowSeconds: NOW },
    );
    expect(e.perStakeMin).toMatch(/0 OR/);
  });
  it('rejects perStakeMax less than effective min when both non-zero', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), perStakeMin: '0.50', perStakeMax: '0.10' },
      { nowSeconds: NOW },
    );
    expect(e.perStakeMax).toMatch(/MAX STAKE/);
  });
  it('accepts perStakeMax = 0 even when min > 0 (zero = "no max")', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), perStakeMin: '0.50', perStakeMax: '0' },
      { nowSeconds: NOW },
    );
    expect(e.perStakeMax).toBeUndefined();
  });
  it('rejects unparseable USDC strings', () => {
    const e = validatePmCreateForm(
      { ...validFriendly(), perStakeMin: 'abc' },
      { nowSeconds: NOW },
    );
    expect(e.perStakeMin).toMatch(/INVALID/);
  });
});

// ─── Open Vote shape ───────────────────────────────────────────────────────

describe('validatePmCreateForm — open_vote shape', () => {
  it('valid open_vote state has no errors', () => {
    expect(validatePmCreateForm(validOpenVote(), { nowSeconds: NOW })).toEqual(
      {},
    );
  });
  it('rejects fewer than 2 options', () => {
    const e = validatePmCreateForm(
      { ...validOpenVote(), optionLabels: ['A'] },
      { nowSeconds: NOW },
    );
    expect(e.optionLabels).toMatch(/NEEDS/);
  });
  it('rejects more than PM_MAX_OPTIONS options', () => {
    const e = validatePmCreateForm(
      {
        ...validOpenVote(),
        optionLabels: Array.from(
          { length: PM_MAX_OPTIONS + 1 },
          (_, i) => `opt-${i}`,
        ),
      },
      { nowSeconds: NOW },
    );
    expect(e.optionLabels).toMatch(/NEEDS/);
  });
  it('rejects participantWallets present', () => {
    const e = validatePmCreateForm(
      { ...validOpenVote(), participantWallets: [ADDR_A, ADDR_B] },
      { nowSeconds: NOW },
    );
    expect(e.participantWallets).toMatch(/NO PARTICIPANTS/);
  });
  it('rejects non-zero perStakeMin/Max/cumulative', () => {
    const e = validatePmCreateForm(
      { ...validOpenVote(), perStakeMin: '0.10' },
      { nowSeconds: NOW },
    );
    expect(e.perStakeMin).toMatch(/MUST BE 0/);
  });
  it('rejects fixedStake below the floor', () => {
    const e = validatePmCreateForm(
      { ...validOpenVote(), fixedStake: '0.001' },
      { nowSeconds: NOW },
    );
    expect(e.fixedStake).toMatch(/0\.01 USDC/);
  });
  it('accepts fixedStake exactly at PM_MIN_STAKE', () => {
    const e = validatePmCreateForm(
      { ...validOpenVote(), fixedStake: '0.01' },
      { nowSeconds: NOW },
    );
    expect(e.fixedStake).toBeUndefined();
  });
  it('rejects winnersCount = 0', () => {
    const e = validatePmCreateForm(
      { ...validOpenVote(), winnersCount: 0 },
      { nowSeconds: NOW },
    );
    expect(e.winnersCount).toMatch(/WINNERS COUNT/);
  });
  it('rejects winnersCount above PM_MAX_WINNERS', () => {
    // Need enough options that the cap, not the option count, is what
    // bites. PM_MAX_WINNERS+1 options gives the winnersCount cap room
    // to be the binding constraint.
    const opts = Array.from(
      { length: PM_MAX_WINNERS + 1 },
      (_, i) => `opt-${i}`,
    );
    const e = validatePmCreateForm(
      {
        ...validOpenVote(),
        optionLabels: opts,
        winnersCount: PM_MAX_WINNERS + 1,
      },
      { nowSeconds: NOW },
    );
    expect(e.winnersCount).toMatch(/WINNERS COUNT/);
  });
  it('rejects winnersCount > optionLabels.length', () => {
    const e = validatePmCreateForm(
      {
        ...validOpenVote(),
        optionLabels: ['A', 'B'],
        winnersCount: 3,
      },
      { nowSeconds: NOW },
    );
    expect(e.winnersCount).toMatch(/WINNERS COUNT/);
  });
  it('rejects non-integer winnersCount', () => {
    const e = validatePmCreateForm(
      { ...validOpenVote(), winnersCount: 1.5 },
      { nowSeconds: NOW },
    );
    expect(e.winnersCount).toMatch(/WINNERS COUNT/);
  });
});

// ─── Prize Pool shape ──────────────────────────────────────────────────────

describe('validatePmCreateForm — prize_pool shape', () => {
  it('valid prize_pool state has no errors', () => {
    expect(validatePmCreateForm(validPrizePool(), { nowSeconds: NOW })).toEqual(
      {},
    );
  });
  it('rejects when participantWallets count differs from optionLabels count', () => {
    const e = validatePmCreateForm(
      {
        ...validPrizePool(),
        optionLabels: ['Alice', 'Bob', 'Charlie'],
        participantWallets: [ADDR_A, ADDR_B],
      },
      { nowSeconds: NOW },
    );
    expect(e.participantWallets).toMatch(/MATCH OPTION COUNT/);
  });
  it('rejects invalid participant address', () => {
    const e = validatePmCreateForm(
      {
        ...validPrizePool(),
        participantWallets: [ADDR_A, '0xnothex'],
      },
      { nowSeconds: NOW },
    );
    expect(e.participantWallets).toMatch(/INVALID/);
  });
  it('rejects duplicate participants (case-insensitive)', () => {
    const e = validatePmCreateForm(
      {
        ...validPrizePool(),
        participantWallets: [ADDR_MIXED, ADDR_MIXED_LOWER],
      },
      { nowSeconds: NOW },
    );
    expect(e.participantWallets).toMatch(/DUPLICATE/);
  });
  it('rejects treasury in participants when treasury provided', () => {
    const e = validatePmCreateForm(
      {
        ...validPrizePool(),
        participantWallets: [ADDR_A, TREASURY],
      },
      { nowSeconds: NOW, treasuryAddress: TREASURY },
    );
    expect(e.participantWallets).toMatch(/TREASURY/);
  });
  it('rejects fixedStake != 0', () => {
    const e = validatePmCreateForm(
      { ...validPrizePool(), fixedStake: '0.50' },
      { nowSeconds: NOW },
    );
    expect(e.fixedStake).toMatch(/MUST BE 0/);
  });
  it('rejects winnersCount 0', () => {
    const e = validatePmCreateForm(
      { ...validPrizePool(), winnersCount: 0 },
      { nowSeconds: NOW },
    );
    expect(e.winnersCount).toMatch(/WINNERS COUNT/);
  });
});

// ─── Builders ──────────────────────────────────────────────────────────────

describe('buildCreateParams + buildCreateParamsWithoutNonce', () => {
  it('friendly round-trips: int enums, hex-encoded strings, addresses lowercased', () => {
    const state: PmCreateFormState = {
      ...validFriendly(),
      title: 'Hello',
      description: '',
      streamUrl: '',
    };
    const params = buildCreateParams(state, NONCE);

    expect(params.shape).toBe(0); // friendly
    expect(params.viewMode).toBe(0); // link_only (default)
    expect(params.participationMode).toBe(0); // open (default)
    expect(params.stakingOpensAt).toBe(BigInt(FUTURE_OPEN_UNIX));
    expect(params.closeAt).toBe(BigInt(FUTURE_CLOSE_UNIX));
    expect(params.title).toBe(toHex('Hello'));
    expect(params.optionLabels).toEqual([toHex('NO'), toHex('YES')]);
    expect(params.participantWallets).toEqual([]);
    expect(params.allowlist).toEqual([]);
    expect(params.perStakeMin).toBe(0n);
    expect(params.perStakeMax).toBe(0n);
    expect(params.perWalletCumulativeMax).toBe(0n);
    expect(params.fixedStake).toBe(0n);
    expect(params.winnersCount).toBe(0);
    expect(params.clientNonce).toBe(NONCE);
  });

  it('open_vote round-trips with non-zero fixedStake', () => {
    const state = {
      ...validOpenVote(),
      fixedStake: '1.50',
    };
    const params = buildCreateParams(state, NONCE);

    expect(params.shape).toBe(1); // open_vote
    expect(params.optionLabels).toEqual([toHex('A'), toHex('B')]);
    // parseUnits('1.50', 6) === 1_500_000n
    expect(params.fixedStake).toBe(1_500_000n);
    expect(params.winnersCount).toBe(1);
  });

  it('prize_pool round-trips: shape=2 + participants lowercased', () => {
    const state = {
      ...validPrizePool(),
      // Feed in a mixed-case address; assert the builder lowercases it
      // (the contract's bytes32 keys are lowercase-derived).
      participantWallets: [ADDR_MIXED, ADDR_B],
    };
    const params = buildCreateParams(state, NONCE);

    expect(params.shape).toBe(2); // prize_pool
    expect(params.participantWallets).toEqual([
      ADDR_MIXED_LOWER,
      ADDR_B.toLowerCase(),
    ]);
  });

  it('public viewMode + allowlisted participation map to ints + carry allowlist', () => {
    const state: PmCreateFormState = {
      ...validFriendly(),
      viewMode: 'public',
      participationMode: 'allowlisted',
      // Whitespace line in the middle is a normal textarea artifact —
      // builder should drop it. Mixed-case entry should be lowercased.
      allowlist: [ADDR_A, ADDR_B, ' ', ADDR_MIXED],
    };
    const params = buildCreateParams(state, NONCE);

    expect(params.viewMode).toBe(1);
    expect(params.participationMode).toBe(1);
    expect(params.allowlist).toEqual([
      ADDR_A.toLowerCase(),
      ADDR_B.toLowerCase(),
      ADDR_MIXED_LOWER,
    ]);
  });

  it('drops the allowlist entirely when participation is open', () => {
    const state: PmCreateFormState = {
      ...validFriendly(),
      participationMode: 'open',
      // Even with values present, open mode should produce []
      allowlist: [ADDR_A, ADDR_B],
    };
    const params = buildCreateParams(state, NONCE);
    expect(params.allowlist).toEqual([]);
  });

  it('buildCreateParamsWithoutNonce returns the same shape minus clientNonce', () => {
    const state = validFriendly();
    const withNonce = buildCreateParams(state, NONCE);
    const noNonce = buildCreateParamsWithoutNonce(state);

    expect('clientNonce' in noNonce).toBe(false);
    // Every OTHER field matches.
    const { clientNonce: _drop, ...rest } = withNonce;
    expect(noNonce).toEqual(rest);
  });

  it('throws PmFormInvariantError on unparseable datetime', () => {
    const state = { ...validFriendly(), stakingOpensAtIso: 'not-a-date' };
    expect(() => buildCreateParams(state, NONCE)).toThrow(
      PmFormInvariantError,
    );
  });

  it('throws PmFormInvariantError on unparseable USDC string', () => {
    const state = { ...validFriendly(), perStakeMin: 'abc' };
    expect(() => buildCreateParams(state, NONCE)).toThrow(
      PmFormInvariantError,
    );
  });

  it('throws PmFormInvariantError on bad allowlist address when allowlisted', () => {
    const state: PmCreateFormState = {
      ...validFriendly(),
      participationMode: 'allowlisted',
      allowlist: [ADDR_A, '0xnothex'],
    };
    expect(() => buildCreateParams(state, NONCE)).toThrow(
      PmFormInvariantError,
    );
  });
});
