// ----------------------------------------------------------------------------
// src/lib/private-markets/create-form.ts
//
// Phase 2C-2 Step 2: pure form module for /create/private. No
// 'server-only' imports, no React, no fetch. Runs in the browser on
// every keystroke.
//
// Single source of truth for:
//   - PmCreateFormState shape
//   - PmCreateFormErrors map
//   - validatePmCreateForm  — mirrors MakoPrivateMarketsV1._validateCreate
//   - buildCreateParams     — form-state → 17-field PmCreateParamsTuple
//   - buildCreateParamsWithoutNonce — same minus clientNonce, for the
//     Magic path where runCreatePrivateMarket generates the nonce
//   - initialFormStateForShape — defaults when the user picks a shape
//   - byteLength — UTF-8 byte length (NOT JS char length) for byte
//     counters and contract-mirroring validation
//   - Hook-layer types (PmCreatePhase, PmCreateErrorKind, PmCreateError,
//     PmCreateDraftRef, PmCreateResult) — co-located here so form
//     components can import them without pulling the React hook module
//
// Per the contract surface in MakoPrivateMarketsV1.sol:
//   - enum ViewMode { LinkOnly, Public }                  → 'link_only' | 'public'
//   - enum VisibilityParticipation { Open, Allowlisted }  → 'open' | 'allowlisted'
//   - PM_MIN_STAKE = 10_000n base units (0.01 USDC)
//   - Friendly: optionLabels locked to [NO, YES]
//   - Open Vote: perStakeMin/Max/perWalletCumulativeMax MUST be 0
//   - Prize Pool: optionLabels.length === participantWallets.length
// ----------------------------------------------------------------------------

import { isAddress, parseUnits, toHex, type Address, type Hex } from 'viem';

import {
  PM_MIN_STAKE_USDC_BASE_UNITS,
  PM_MAX_OPTIONS,
  PM_MAX_WINNERS,
  PM_MAX_ALLOWLIST,
  PM_MAX_TITLE_BYTES,
  PM_MAX_DESCRIPTION_BYTES,
  PM_MAX_OPTION_LABEL_BYTES,
  PM_MAX_STREAM_URL_BYTES,
} from '@/lib/aa-constants';
import type { PmCreateParamsTuple } from './abi-fragments';

// ─── Public types ──────────────────────────────────────────────────────────

export type PmShape = 'friendly' | 'open_vote' | 'prize_pool';
export type ViewMode = 'link_only' | 'public';
export type ParticipationMode = 'open' | 'allowlisted';

export interface PmCreateFormState {
  shape: PmShape;

  // Common
  title: string;
  description: string;
  streamUrl: string;
  stakingOpensAtIso: string; // <input type="datetime-local"> string
  closeAtIso: string;

  // Visibility (independent axes)
  viewMode: ViewMode;
  participationMode: ParticipationMode;
  allowlist: string[]; // one 0x-address per line; only required when allowlisted

  // Comments (#182 Slice B) — OFF-CHAIN ONLY. Not part of the contract
  // params tuple; persisted to pm_markets.comments_enabled at draft time
  // and later editable by the creator via the comments-toggle route.
  // Defaults ON. Blocks new comment WRITES when false; reads stay open.
  commentsEnabled: boolean;

  // Per-shape
  optionLabels: string[]; // friendly: ['NO','YES'] locked; others: 2..PM_MAX_OPTIONS
  participantWallets: string[]; // prize_pool only; length must equal optionLabels

  // Stake bounds (USDC display strings, e.g. '0.01')
  perStakeMin: string;
  perStakeMax: string;
  perWalletCumulativeMax: string;
  fixedStake: string;

  // Open Vote + Prize Pool — 1..min(optionLabels.length, PM_MAX_WINNERS)
  winnersCount: number;
}

export type PmCreateFormErrors = Partial<Record<keyof PmCreateFormState, string>>;

// ─── Hook-layer types ──────────────────────────────────────────────────────
//
// Co-located here (rather than in use-create-market.ts) so the form
// components can import the error / phase types without depending on
// the React hook module's runtime. Plan v6 step 4 sketched these in
// the hook file; keeping them here narrows the import graph.

export type PmCreatePhase =
  | 'idle'
  | 'preparing'         // both: identity + chain checks
  | 'sponsoring'        // Magic: AA orchestrator running
  | 'wallet_drafting'   // wallet: POST draft
  | 'wallet_simulating' // wallet: simulateContract
  | 'wallet_pending'    // wallet: writeContract sent, waiting receipt
  | 'success'
  | 'error';

export type PmCreateErrorKind =
  // Pre-draft errors — slug never reserved.
  | 'wallet_drift'
  | 'chain_switch_denied'
  | 'draft_failed'
  | 'sponsor_failed_predraft'
  | 'unknown'
  // Post-draft errors — slug WAS reserved; preserved in error.draft.
  | 'simulate_reverted'
  | 'user_rejected'
  | 'wallet_error'
  | 'receipt_reverted'
  | 'receipt_timeout'
  | 'sponsor_failed_postdraft'
  | 'send_failed'
  | 'send_expired'
  | 'send_reverted'
  | 'send_in_progress'
  | 'send_manual_review'
  | 'send_failed_pre_submit'
  | 'send_submitted_pending';

export interface PmCreateDraftRef {
  slug: string;
  pendingDbId: string;
  clientNonce: Hex;
}

export interface PmCreateResult {
  slug: string;
  txHash: Hex;
  pendingDbId: string;
}

export interface PmCreateError {
  kind: PmCreateErrorKind;
  message: string;
  technical?: string;
  /// Plan v6 / Codex r2 MAJ-5: post-draft errors preserve the reserved
  /// slug + clientNonce + pendingDbId so the UI can show "Your draft at
  /// /m/<slug> didn't land — retry?" copy. Pre-draft errors leave this
  /// undefined.
  draft?: PmCreateDraftRef;
  /// For simulate_reverted: the decoded contract error name when
  /// available.
  contractError?: string;
}

// ─── Encoding helpers ──────────────────────────────────────────────────────

/// UTF-8 byte length (NOT JS char length). Mirrors what the contract's
/// `bytes` length check sees on-chain. Emoji and non-ASCII expand to
/// 2-4 bytes each.
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function shapeToInt(shape: PmShape): 0 | 1 | 2 {
  switch (shape) {
    case 'friendly':
      return 0;
    case 'open_vote':
      return 1;
    case 'prize_pool':
      return 2;
  }
}

function viewModeToInt(v: ViewMode): 0 | 1 {
  return v === 'link_only' ? 0 : 1;
}

function participationModeToInt(p: ParticipationMode): 0 | 1 {
  return p === 'open' ? 0 : 1;
}

/// Strict regex for a USDC display amount: unsigned, optional decimal
/// of 1..6 digits. Rejects:
///   - signs (+/-) — viem.parseUnits silently accepts negatives
///   - scientific notation ('1e10')
///   - >6 decimal digits — viem.parseUnits silently rounds away precision
///   - leading/trailing whitespace, empty fractional ('1.')
///   - hex / radix prefixes
const USDC_DISPLAY_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

/// Parse a USDC display string into 6-decimal base units. Returns null
/// on invalid input. Empty string and '0' both resolve to 0n.
///
/// Codex r1 MAJ-2: viem.parseUnits is too permissive — it accepts
/// negatives and silently rounds over-precision values. We gate it
/// behind a strict regex so anything that reaches parseUnits is
/// already known-good.
function parseUsdcDisplay(display: string): bigint | null {
  const trimmed = display.trim();
  if (trimmed === '') return 0n;
  if (!USDC_DISPLAY_RE.test(trimmed)) return null;
  try {
    const parsed = parseUnits(trimmed, 6);
    if (parsed < 0n) return null; // belt + suspenders; regex precludes
    return parsed;
  } catch {
    return null;
  }
}

/// Format a local Date back to the YYYY-MM-DDTHH:MM shape the picker
/// emits. Used by parseIsoToUnixSeconds to detect normalized values
/// (DST gap: e.g. 2024-03-10T02:30 in US/Eastern, which `new Date()`
/// silently shifts to 03:30). Codex r2 MIN-1.
function formatLocalIsoMinute(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/// Parse a `datetime-local` ISO string into Unix seconds. Returns null
/// on invalid input. Browser supplies local-time ISO without timezone
/// suffix; `new Date(iso)` interprets it as local time, which is what
/// the user typed.
///
/// Codex r2 MIN-1: reject normalized parses. If
/// formatLocalIsoMinute(new Date(iso)) !== iso, the input named a
/// non-existent local time (DST spring-forward gap) and `new Date`
/// silently rolled it forward. Treat as invalid so the user sees an
/// error rather than a silently-different timestamp.
function parseIsoToUnixSeconds(iso: string): number | null {
  if (!iso || iso.trim() === '') return null;
  const trimmed = iso.trim();
  const date = new Date(trimmed);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  if (formatLocalIsoMinute(date) !== trimmed) return null;
  return Math.floor(ms / 1000);
}

/// Filter empty lines out of textarea-driven address lists. Trailing
/// newlines and blank lines are a normal artifact of typing in a
/// textarea, not an attempt to submit empty entries.
function nonEmptyLines(list: string[]): string[] {
  return list.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ─── Initial state ─────────────────────────────────────────────────────────

const FRIENDLY_LOCKED_OPTIONS = ['NO', 'YES'] as const;

export function initialFormStateForShape(shape: PmShape): PmCreateFormState {
  const baseDefaults: Omit<PmCreateFormState, 'shape' | 'optionLabels' | 'participantWallets' | 'winnersCount'> = {
    title: '',
    description: '',
    streamUrl: '',
    stakingOpensAtIso: '',
    closeAtIso: '',
    viewMode: 'link_only',
    participationMode: 'open',
    allowlist: [],
    commentsEnabled: true,
    perStakeMin: '0',
    perStakeMax: '0',
    perWalletCumulativeMax: '0',
    fixedStake: '0',
  };

  switch (shape) {
    case 'friendly':
      return {
        ...baseDefaults,
        shape,
        optionLabels: [...FRIENDLY_LOCKED_OPTIONS],
        participantWallets: [],
        winnersCount: 0,
      };
    case 'open_vote':
      return {
        ...baseDefaults,
        shape,
        optionLabels: ['', ''],
        participantWallets: [],
        winnersCount: 1,
      };
    case 'prize_pool':
      return {
        ...baseDefaults,
        shape,
        optionLabels: ['', ''],
        participantWallets: ['', ''],
        winnersCount: 1,
      };
  }
}

// ─── Validator ─────────────────────────────────────────────────────────────

export interface ValidateOptions {
  /// Optional treasury address for the participant + allowlist exclusion
  /// check. The page fetches this once on mount via a public lookup and
  /// passes it in; null means skip the treasury check (contract will
  /// revert at submit time as fallback).
  treasuryAddress?: Address | null;
  /// Override `Date.now()` for deterministic tests. Unix seconds.
  nowSeconds?: number;
}

/// Pure validator. Mirrors MakoPrivateMarketsV1._validateCreate (lines
/// 481-516). Per-shape rules per the matrix in Phase 2C-2 plan v6.
/// Returns {} for a valid state.
export function validatePmCreateForm(
  state: PmCreateFormState,
  opts: ValidateOptions = {},
): PmCreateFormErrors {
  const errors: PmCreateFormErrors = {};
  const treasuryLower = opts.treasuryAddress
    ? opts.treasuryAddress.toLowerCase()
    : null;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  // ── Common: title / description / streamUrl ──
  const titleBytes = byteLength(state.title);
  if (titleBytes === 0) {
    errors.title = 'TITLE REQUIRED';
  } else if (titleBytes > PM_MAX_TITLE_BYTES) {
    errors.title = `TITLE EXCEEDS ${PM_MAX_TITLE_BYTES} BYTES (${titleBytes})`;
  }

  if (byteLength(state.description) > PM_MAX_DESCRIPTION_BYTES) {
    errors.description = `DESCRIPTION EXCEEDS ${PM_MAX_DESCRIPTION_BYTES} BYTES`;
  }

  if (state.streamUrl.trim() !== '') {
    if (byteLength(state.streamUrl) > PM_MAX_STREAM_URL_BYTES) {
      errors.streamUrl = `URL EXCEEDS ${PM_MAX_STREAM_URL_BYTES} BYTES`;
    } else if (!state.streamUrl.startsWith('https://')) {
      // Product rule, not contract rule. Documented in plan v6 step 2.
      errors.streamUrl = 'URL MUST START WITH HTTPS://';
    }
  }

  // ── Common: timing ──
  const stakingOpensAt = parseIsoToUnixSeconds(state.stakingOpensAtIso);
  const closeAt = parseIsoToUnixSeconds(state.closeAtIso);

  if (stakingOpensAt === null) {
    errors.stakingOpensAtIso = 'STAKING OPENS AT REQUIRED';
  } else if (stakingOpensAt < now) {
    // Equality is valid; only strictly-past times reject (Codex r2 MAJ-2).
    errors.stakingOpensAtIso = 'STAKING OPENS AT CANNOT BE IN THE PAST';
  }

  if (closeAt === null) {
    errors.closeAtIso = 'CLOSE AT REQUIRED';
  } else if (stakingOpensAt !== null && closeAt <= stakingOpensAt) {
    errors.closeAtIso = 'CLOSE AT MUST BE AFTER STAKING OPENS';
  }

  // ── Common: allowlist (only when participation = allowlisted) ──
  if (state.participationMode === 'allowlisted') {
    const list = nonEmptyLines(state.allowlist);
    if (list.length === 0) {
      errors.allowlist = 'ALLOWLIST REQUIRED WHEN PARTICIPATION IS ALLOWLISTED';
    } else if (list.length > PM_MAX_ALLOWLIST) {
      errors.allowlist = `ALLOWLIST EXCEEDS ${PM_MAX_ALLOWLIST} ADDRESSES (${list.length})`;
    } else {
      const seen = new Set<string>();
      let dupeFound = false;
      let badAddr = false;
      let treasuryFound = false;
      for (const raw of list) {
        if (!isAddress(raw)) {
          badAddr = true;
          break;
        }
        const lower = raw.toLowerCase();
        if (treasuryLower && lower === treasuryLower) {
          treasuryFound = true;
          break;
        }
        if (seen.has(lower)) {
          dupeFound = true;
          break;
        }
        seen.add(lower);
      }
      if (badAddr) {
        errors.allowlist = 'ALLOWLIST CONTAINS INVALID ADDRESS';
      } else if (treasuryFound) {
        errors.allowlist = 'TREASURY ADDRESS NOT ALLOWED IN ALLOWLIST';
      } else if (dupeFound) {
        errors.allowlist = 'ALLOWLIST CONTAINS DUPLICATE ADDRESS';
      }
    }
  }

  // ── Common: option labels (length + byte limits per label) ──
  for (let i = 0; i < state.optionLabels.length; i++) {
    const b = byteLength(state.optionLabels[i]);
    if (b === 0) {
      errors.optionLabels = `OPTION ${i + 1} LABEL REQUIRED`;
      break;
    }
    if (b > PM_MAX_OPTION_LABEL_BYTES) {
      errors.optionLabels = `OPTION ${i + 1} EXCEEDS ${PM_MAX_OPTION_LABEL_BYTES} BYTES`;
      break;
    }
  }

  // ── Per-shape rules ──
  const min = parseUsdcDisplay(state.perStakeMin);
  const max = parseUsdcDisplay(state.perStakeMax);
  const cumulative = parseUsdcDisplay(state.perWalletCumulativeMax);
  const fixed = parseUsdcDisplay(state.fixedStake);

  switch (state.shape) {
    case 'friendly': {
      if (
        state.optionLabels.length !== 2 ||
        state.optionLabels[0] !== 'NO' ||
        state.optionLabels[1] !== 'YES'
      ) {
        errors.optionLabels = 'FRIENDLY MARKETS USE LOCKED NO / YES OPTIONS';
      }
      if (state.participantWallets.length > 0) {
        errors.participantWallets = 'FRIENDLY MARKETS HAVE NO PARTICIPANTS';
      }
      if (cumulative === null || cumulative !== 0n) {
        errors.perWalletCumulativeMax = 'MUST BE 0 FOR FRIENDLY';
      }
      if (fixed === null || fixed !== 0n) {
        errors.fixedStake = 'MUST BE 0 FOR FRIENDLY';
      }
      if (state.winnersCount !== 0) {
        errors.winnersCount = 'MUST BE 0 FOR FRIENDLY';
      }
      if (min === null) {
        errors.perStakeMin = 'INVALID USDC AMOUNT';
      } else if (min !== 0n && min < PM_MIN_STAKE_USDC_BASE_UNITS) {
        errors.perStakeMin = 'MIN STAKE MUST BE 0 OR ≥ 0.01 USDC';
      }
      if (max === null) {
        errors.perStakeMax = 'INVALID USDC AMOUNT';
      } else if (min !== null && max !== 0n) {
        const effectiveMin = min === 0n ? PM_MIN_STAKE_USDC_BASE_UNITS : min;
        if (max < effectiveMin) {
          errors.perStakeMax = 'MAX STAKE MUST BE ≥ EFFECTIVE MIN';
        }
      }
      break;
    }

    case 'open_vote': {
      if (
        state.optionLabels.length < 2 ||
        state.optionLabels.length > PM_MAX_OPTIONS
      ) {
        errors.optionLabels = `OPEN VOTE NEEDS 2..${PM_MAX_OPTIONS} OPTIONS`;
      }
      if (state.participantWallets.length > 0) {
        errors.participantWallets = 'OPEN VOTE HAS NO PARTICIPANTS';
      }
      if (min === null || min !== 0n) {
        errors.perStakeMin = 'MUST BE 0 FOR OPEN VOTE';
      }
      if (max === null || max !== 0n) {
        errors.perStakeMax = 'MUST BE 0 FOR OPEN VOTE';
      }
      if (cumulative === null || cumulative !== 0n) {
        errors.perWalletCumulativeMax = 'MUST BE 0 FOR OPEN VOTE';
      }
      if (fixed === null || fixed < PM_MIN_STAKE_USDC_BASE_UNITS) {
        errors.fixedStake = 'FIXED STAKE MUST BE ≥ 0.01 USDC';
      }
      // Codex r2 MAJ-3: contract permits 1..PM_MAX_WINNERS for Open Vote.
      if (
        !Number.isInteger(state.winnersCount) ||
        state.winnersCount < 1 ||
        state.winnersCount > PM_MAX_WINNERS ||
        state.winnersCount > state.optionLabels.length
      ) {
        errors.winnersCount = `WINNERS COUNT MUST BE 1..MIN(${PM_MAX_WINNERS}, OPTIONS)`;
      }
      break;
    }

    case 'prize_pool': {
      if (
        state.optionLabels.length < 2 ||
        state.optionLabels.length > PM_MAX_OPTIONS
      ) {
        errors.optionLabels = `PRIZE POOL NEEDS 2..${PM_MAX_OPTIONS} OPTIONS`;
      }
      if (state.participantWallets.length !== state.optionLabels.length) {
        errors.participantWallets =
          'PARTICIPANT COUNT MUST MATCH OPTION COUNT';
      } else {
        const seen = new Set<string>();
        let badAddr = false;
        let dupe = false;
        let treasury = false;
        for (const raw of state.participantWallets) {
          if (!isAddress(raw)) {
            badAddr = true;
            break;
          }
          const lower = raw.toLowerCase();
          if (treasuryLower && lower === treasuryLower) {
            treasury = true;
            break;
          }
          if (seen.has(lower)) {
            dupe = true;
            break;
          }
          seen.add(lower);
        }
        if (badAddr) {
          errors.participantWallets =
            'PARTICIPANTS CONTAIN INVALID ADDRESS';
        } else if (treasury) {
          errors.participantWallets =
            'TREASURY ADDRESS NOT ALLOWED IN PARTICIPANTS';
        } else if (dupe) {
          errors.participantWallets =
            'PARTICIPANTS CONTAIN DUPLICATE ADDRESS';
        }
      }
      if (min === null) {
        errors.perStakeMin = 'INVALID USDC AMOUNT';
      } else if (min !== 0n && min < PM_MIN_STAKE_USDC_BASE_UNITS) {
        errors.perStakeMin = 'MIN STAKE MUST BE 0 OR ≥ 0.01 USDC';
      }
      if (max === null) {
        errors.perStakeMax = 'INVALID USDC AMOUNT';
      } else if (min !== null && max !== 0n) {
        const effectiveMin = min === 0n ? PM_MIN_STAKE_USDC_BASE_UNITS : min;
        if (max < effectiveMin) {
          errors.perStakeMax = 'MAX STAKE MUST BE ≥ EFFECTIVE MIN';
        }
      }
      if (cumulative === null) {
        errors.perWalletCumulativeMax = 'INVALID USDC AMOUNT';
      }
      if (fixed === null || fixed !== 0n) {
        errors.fixedStake = 'MUST BE 0 FOR PRIZE POOL';
      }
      if (
        !Number.isInteger(state.winnersCount) ||
        state.winnersCount < 1 ||
        state.winnersCount > PM_MAX_WINNERS ||
        state.winnersCount > state.optionLabels.length
      ) {
        errors.winnersCount = `WINNERS COUNT MUST BE 1..MIN(${PM_MAX_WINNERS}, OPTIONS)`;
      }
      break;
    }
  }

  return errors;
}

// ─── Builders ──────────────────────────────────────────────────────────────

/// Internal: assemble every field except clientNonce. Both builders
/// share this so the type-level split is the only difference.
///
/// Defense-in-depth: assumes the validator was satisfied. Throws
/// PmFormInvariantError on unparseable values the validator should
/// have caught.
function buildCreateParamsCore(
  state: PmCreateFormState,
): Omit<PmCreateParamsTuple, 'clientNonce'> {
  const stakingOpensAt = parseIsoToUnixSeconds(state.stakingOpensAtIso);
  const closeAt = parseIsoToUnixSeconds(state.closeAtIso);
  if (stakingOpensAt === null || closeAt === null) {
    throw new PmFormInvariantError('invalid datetime in form state');
  }

  const min = parseUsdcDisplay(state.perStakeMin);
  const max = parseUsdcDisplay(state.perStakeMax);
  const cumulative = parseUsdcDisplay(state.perWalletCumulativeMax);
  const fixed = parseUsdcDisplay(state.fixedStake);
  if (min === null || max === null || cumulative === null || fixed === null) {
    throw new PmFormInvariantError('invalid USDC amount in form state');
  }

  const allowlistLines =
    state.participationMode === 'allowlisted'
      ? nonEmptyLines(state.allowlist)
      : [];
  for (const a of allowlistLines) {
    if (!isAddress(a)) {
      throw new PmFormInvariantError(`invalid allowlist address: ${a}`);
    }
  }
  for (const a of state.participantWallets) {
    if (a !== '' && !isAddress(a)) {
      throw new PmFormInvariantError(`invalid participant address: ${a}`);
    }
  }

  return {
    shape: shapeToInt(state.shape),
    stakingOpensAt: BigInt(stakingOpensAt),
    closeAt: BigInt(closeAt),
    title: toHex(state.title),
    description: toHex(state.description),
    streamUrl: toHex(state.streamUrl),
    optionLabels: state.optionLabels.map((s) => toHex(s)),
    participantWallets: state.participantWallets.map(
      (a) => a.toLowerCase() as Address,
    ),
    allowlist: allowlistLines.map((a) => a.toLowerCase() as Address),
    viewMode: viewModeToInt(state.viewMode),
    participationMode: participationModeToInt(state.participationMode),
    perStakeMin: min,
    perStakeMax: max,
    perWalletCumulativeMax: cumulative,
    fixedStake: fixed,
    winnersCount: state.winnersCount,
  };
}

/// Build the full 17-field params tuple. Used by the wallet path,
/// which owns the clientNonce (returned by the draft route response).
export function buildCreateParams(
  state: PmCreateFormState,
  clientNonce: Hex,
): PmCreateParamsTuple {
  return {
    ...buildCreateParamsCore(state),
    clientNonce,
  };
}

/// Build everything except clientNonce. Used by the Magic path:
/// runCreatePrivateMarket generates its own clientNonce internally
/// and threads it into the draft POST + the callData encoding.
///
/// Codex r2 MAJ-1 — split out so the Magic branch's call site is
/// type-safe and the test surface is the two helpers, not one
/// helper-with-two-modes.
export function buildCreateParamsWithoutNonce(
  state: PmCreateFormState,
): Omit<PmCreateParamsTuple, 'clientNonce'> {
  return buildCreateParamsCore(state);
}

export class PmFormInvariantError extends Error {
  constructor(message: string) {
    super(`PmFormInvariantError: ${message}`);
    this.name = 'PmFormInvariantError';
  }
}
