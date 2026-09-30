import { hexToBigInt, toHex, type Address, type Hex } from 'viem';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { userSafes, type AaPendingUserOp } from '@/db/schema';
import { makoAbi } from '@/lib/MakoMarkets.abi';
import { MAKO_ADDRESS, ROUNDS_ADDRESS } from '@/lib/contract';
import { roundsAbi } from '@/lib/rounds-abi';
import {
  assertRoundClaimCall,
  assertRoundEnterBatchedCalls,
  assertRoundEnterCall,
  assertRoundRefundCall,
  assertRoundScheduleCall,
  assertRoundScheduleShape,
  assertRoundScheduler,
} from '@/lib/rounds-call-allowlist';
import {
  PENDING_TTL_MS,
  VALIDITY_WINDOW_MAX_UINT48,
} from '@/lib/aa-constants';
import { isSupportedAaChainId } from '@/lib/aa-config';
import { isPmEnabled } from '@/lib/pm-enabled';
import {
  assertBetBatchedCalls,
  assertBetSingleCall,
  assertClaimCall,
  assertCreateMarketBatchedCallsShape,
  assertCreateMarketBatchedCallsSponsor,
  assertCreateMarketCall,
  assertCreateMarketShape,
  assertPmCreateMarketCall,
  assertPmCreateMarketShapeNoTreasury,
  assertSendUsdcCall,
  assertSponsorableCall,
  NotAllowedError,
} from '@/lib/aa-call-allowlist';
import {
  assertPmBetBatchedCalls,
  assertPmBetBatchedCallsShape,
  assertPmBetCall,
  assertPmBetCallShape,
  assertPmCancelCall,
  assertPmCancelCallShape,
  assertPmClaimCall,
  assertPmConfirmCall,
  assertPmConfirmCallShape,
  assertPmDistributeCall,
  assertPmDistributeCallShape,
  assertPmEditMetadataCall,
  assertPmEditMetadataCallShapeNoTreasury,
  assertPmFinalizeCall,
  assertPmFinalizeMetadataCall,
  assertPmResolveCall,
  assertPmResolveCallShape,
  assertPmStakeBatchedCalls,
  assertPmStakeBatchedCallsShape,
  assertPmStakeCall,
  assertPmStakeCallShape,
} from '@/lib/private-markets/pm-call-allowlist';
import { createSponsorMarketStateCache } from '@/lib/private-markets/sponsor-chain-state';
import { getAaPublicClient } from '@/lib/aa-public-client';
import { summarizeAaErrorWithCause } from '@/lib/aa-errors';
import {
  insertPending,
  loadInFlightForSafe,
} from '@/lib/aa-pending-user-ops';
import { SponsorRequest } from '@/lib/aa-route-schemas';
import {
  decrementForRefund,
  incrementOrReject,
} from '@/lib/aa-sponsor-limits';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { checkSameOrigin } from '@/lib/csrf';
import { isJsonRpcReject } from '@/lib/aa-rpc';
import { getUserSession } from '@/lib/user-session';
import { buildSponsoredUserOp } from '@/lib/user-op';
import { computeUserOpHash } from '@/lib/user-op-hash';
import { storedToPacked } from '@/lib/user-op-types';
import { PM_CONTRACT_ADDRESS } from '@/lib/contract';
import { decodeFunctionData } from 'viem';
import {
  PM_CREATE_MARKET_ABI,
  type PmCreateParamsTuple,
} from '@/lib/private-markets/abi-fragments';
import { getPmTreasuryAddress } from '@/lib/private-markets/treasury';
import { assertPmSponsorDraft } from '@/lib/private-markets/sponsor-gate';
import { mapShapeEnum } from '@/lib/private-markets/normalize';

// ----------------------------------------------------------------------------
// POST /api/aa/sponsor
//
// Build + persist a sponsored ERC-4337 user op. Returns the userOp + SafeOp
// hash + userOpHash so the browser can sign via Magic and post the result
// back to /api/aa/send.
//
// Steps (mirror plan v4 §"/api/aa/sponsor flow"):
//   0. checkSameOrigin (CSRF gate — same as /api/user/auth)
//   1. getUserSession → 401 if absent
//   2. zod-validate body via SponsorRequest discriminatedUnion('kind', […])
//   3. chainId allowlist (Monad testnet only)
//   4. user_safes lookup → 403 if absent
//   5. Validator dispatch on parsed.data.kind, all → 403 NOT_ALLOWED on mismatch:
//        smoke       → assertSponsorableCall  (USDC.transfer self 0n|1n)
//        bet_single  → assertBetSingleCall    (placeBet to MAKO)
//        bet_batched → assertBetBatchedCalls  (tuple [approve(MAKO, MaxUint256), placeBet(...)])
//   6. PRECHECK in-flight row; same-user own-pending → 200 with full
//      payload (`recovered: true`); cross-user OR non-pending → 409
//   7. Atomic aa_sponsor_limits increment; >cap → 429
//   8. buildSponsoredUserOp; arg shape mirrors the kind:
//        smoke / bet_single → { call }
//        bet_batched        → { calls }   (lib emits MultiSend wrapper)
//      PathXMismatchError → refund + 500;
//      JsonRpcReject → 503; transport → 502
//   9. INSERT aa_pending_user_ops ON CONFLICT DO NOTHING; race-loss →
//      refund + reload + serializeExistingInFlight
//  10. Return 200 with the freshly-built userOp + hash + expiresAt
//
// Same-origin enforcement is step 0 because every later step (session
// lookup, DB read, RPC call) costs more than rejecting a malicious cross-
// origin request up front.
//
// `Authorization: Bearer <session cookie>` is NOT used here — the existing
// app uses session cookies + same-origin for auth. The sponsor route
// inherits that. Postman/curl callers must include the cookie header.
// ----------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ServerError =
  | { status: number; body: Record<string, unknown> };

/// Detection stopgap: sub-phase B's `buildSponsoredUserOp` throws a plain
/// Error with the message prefix below on a Path X invariant violation. A
/// typed `PathXMismatchError` class is tracked as a sub-phase B follow-up;
/// when that ships, swap the regex for `instanceof`. See plan §Risks.
function isPathXMismatch(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /user-op:\s*safeAddress mismatch/i.test(e.message);
}

function mapBuildErrorToResponse(e: unknown): ServerError {
  const summary = summarizeAaErrorWithCause(e);
  if (isPathXMismatch(e)) {
    return {
      status: 500,
      body: { error: 'INTERNAL', message: summary.message },
    };
  }
  if (isJsonRpcReject(e)) {
    return {
      status: 503,
      body: { error: 'SPONSOR_UNAVAILABLE', message: summary.message },
    };
  }
  return {
    status: 502,
    body: { error: 'UPSTREAM', message: summary.message },
  };
}

/// Branches on (existing.userId, existing.status) to decide whether the
/// caller gets back the full signing payload (same-user own-pending —
/// dropped-response recovery) or just a minimal status snapshot.
/// Used by BOTH the precheck branch (step 6) and the INSERT race-loss
/// branch (step 9).
function serializeExistingInFlight(args: {
  existing: AaPendingUserOp;
  sessionUserId: string;
  chainId: number;
}): ServerError {
  const { existing, sessionUserId, chainId } = args;
  if (existing.userId === sessionUserId && existing.status === 'pending') {
    const userOpHash = computeUserOpHash({
      userOp: storedToPacked(existing.userOp),
      chainId,
    });
    return {
      status: 200,
      body: {
        pendingUserOpId: existing.id,
        userOp: existing.userOp,
        safeOpHash: existing.safeOpHash,
        userOpHash,
        validAfter: '0x0',
        validUntil: toHex(VALIDITY_WINDOW_MAX_UINT48),
        expiresAt: existing.expiresAt.toISOString(),
        recovered: true,
      },
    };
  }
  return {
    status: 409,
    body: {
      error: 'IN_FLIGHT',
      existing: {
        id: existing.id,
        status: existing.status,
        statusUpdatedAt: existing.statusUpdatedAt.toISOString(),
      },
    },
  };
}

export async function POST(req: Request) {
  // Step -1: PM feature-flag gate. When NEXT_PUBLIC_PM_ENABLED is
  // not literal "true", reject any kind starting with `pm_` with
  // 503 BEFORE any session check, zod-parse, DB read, RPC, or
  // user-op build. This prevents a direct API caller from
  // bypassing the UI gate (HoverRevealPicker hides the PRIVATE
  // column; /create/private and /m/[slug] return 404; this seals
  // the AA-sponsor surface). `/api/aa/send` is intentionally NOT
  // gated — it has no `kind` in its request body and the drain
  // policy lets already-validated pending rows complete; see
  // [[mako-pm-gate]] memory + the gate plan's locked decision #6.
  if (!isPmEnabled()) {
    try {
      const body = (await req.clone().json()) as { kind?: unknown };
      if (typeof body?.kind === 'string' && body.kind.startsWith('pm_')) {
        return Response.json(
          { error: 'feature_not_enabled' },
          { status: 503 },
        );
      }
    } catch {
      // Malformed body falls through to the existing zod-parse
      // path below, which returns 400 `bad_body` consistently.
    }
  }

  // Step 0: same-origin gate.
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return Response.json({ error: 'cross_origin' }, { status: 403 });
  }

  // Step 1: session.
  const session = await getUserSession();
  if (!session) {
    return Response.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // Step 2: zod-validate body.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }
  const parsed = SponsorRequest.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: 'bad_body', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { chainId } = parsed.data;

  // Step 3: chainId allowlist. Same gate for every `kind`.
  if (!isSupportedAaChainId(chainId) || chainId !== MONAD_TESTNET_ID) {
    return Response.json(
      { error: 'NOT_ALLOWED', reason: 'chain_unsupported' },
      { status: 400 },
    );
  }

  // Step 4: user_safes lookup. Same gate for every `kind`.
  const safeRows = await db
    .select({ safeAddress: userSafes.safeAddress })
    .from(userSafes)
    .where(
      and(
        eq(userSafes.userId, session.userId),
        eq(userSafes.chainId, chainId),
      ),
    )
    .limit(1);
  const userSafe = safeRows[0];
  if (!userSafe) {
    return Response.json(
      { error: 'NOT_ALLOWED', reason: 'no_user_safe' },
      { status: 403 },
    );
  }
  const safeAddress = userSafe.safeAddress as Address;

  // Step 5: callData allowlist + per-kind builder args.
  //
  // Phase 1D Group 4: dispatch on `kind`. Each branch validates the
  // kind-specific shape and prepares the args for buildSponsoredUserOp.
  // The common middle (precheck / rate-limit / INSERT / conflict) is
  // shared below.
  type Call = { to: Address; value: bigint; data: Hex };
  let buildArgs:
    | {
        kind:
          | 'smoke'
          | 'bet_single'
          | 'send_usdc'
          | 'create_market'
          | 'claim'
          | 'pm_create_market'
          | 'pm_bet'
          | 'pm_stake'
          | 'pm_claim'
          | 'pm_resolve'
          | 'pm_confirm'
          | 'pm_distribute'
          | 'pm_cancel'
          | 'pm_finalize'
          | 'pm_finalize_metadata'
          | 'pm_edit_metadata'
          | 'round_enter'
          | 'round_claim'
          | 'round_refund'
          | 'round_schedule';
        call: Call;
      }
    | {
        kind:
          | 'bet_batched'
          | 'create_market_batched'
          | 'pm_bet_batched'
          | 'pm_stake_batched'
          | 'round_enter_batched';
        calls: readonly [Call, Call];
      };
  try {
    switch (parsed.data.kind) {
      case 'smoke': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        assertSponsorableCall({ chainId, safeAddress, call });
        buildArgs = { kind: 'smoke', call };
        break;
      }
      case 'bet_single': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        assertBetSingleCall({ chainId, safeAddress, call });
        buildArgs = { kind: 'bet_single', call };
        break;
      }
      case 'bet_batched': {
        const [a, b] = parsed.data.calls;
        const calls: readonly [Call, Call] = [
          {
            to: a.to as Address,
            value: hexToBigInt(a.value as Hex),
            data: a.data as Hex,
          },
          {
            to: b.to as Address,
            value: hexToBigInt(b.value as Hex),
            data: b.data as Hex,
          },
        ];
        assertBetBatchedCalls({ chainId, safeAddress, calls });
        buildArgs = { kind: 'bet_batched', calls };
        break;
      }
      case 'send_usdc': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        assertSendUsdcCall({ chainId, safeAddress, call });
        buildArgs = { kind: 'send_usdc', call };
        break;
      }
      case 'create_market': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        // Round-8 MINOR 1: cheap shape-only checks BEFORE the chain-
        // time RPC. Wrong target / wrong selector / bad mType / bad
        // question / immutable bettingCloseTime > closeTime all
        // reject without paying for a getBlock roundtrip. An authed
        // tester spamming malformed bodies cannot force chain-time
        // reads. Full validator below repeats these checks plus
        // the clock-relative invariants.
        assertCreateMarketShape({ chainId, safeAddress, call });

        // ONLY now do we pay the RPC cost for the latest chain block
        // timestamp. ONLY the create_market case incurs this; smoke /
        // bet_single / bet_batched / send_usdc are byte-for-byte
        // unchanged. Browser Date.now() is never trusted here.
        const block = await getAaPublicClient(chainId).getBlock({
          blockTag: 'latest',
        });
        // v4 redeploy (slice 4c): validator is async and reads
        // blocked(safeAddress) from the v4 contract for non-MAKO creates.
        // The chain read lives inside the validator (per codex r7 nit-2)
        // so the route doesn't need to know about the gate; we just
        // hand it a publicClient-backed callback. MAKO creates skip
        // the read by design (admin-Safe owner gate is the access control).
        const aaClient = getAaPublicClient(chainId);
        await assertCreateMarketCall({
          chainId,
          safeAddress,
          call,
          nowSec: block.timestamp,
          readBlocked: async (safe) =>
            (await aaClient.readContract({
              address: MAKO_ADDRESS,
              abi: makoAbi,
              functionName: 'blocked',
              args: [safe],
            })) as boolean,
          readCreatorCreatesToday: async (safe) => {
            const [count, remaining] = (await aaClient.readContract({
              address: MAKO_ADDRESS,
              abi: makoAbi,
              functionName: 'creatorCreatesToday',
              args: [safe],
            })) as readonly [bigint, bigint];
            return { count, remaining };
          },
        });
        buildArgs = { kind: 'create_market', call };
        break;
      }
      case 'create_market_batched': {
        // v4 redeploy (slice 4c-3): batched approve+create for Magic users
        // whose Safe has insufficient USDC allowance against MakoMarketsV4.
        // Same shape-then-clock-then-blocklist discipline as the single-call
        // path; the batched validator handles tuple-level checks (approve
        // target/spender/amount) and recurses into the same async single-
        // call sponsor validator for sub[1].
        const sub0 = parsed.data.calls[0];
        const sub1 = parsed.data.calls[1];
        const calls: readonly [Call, Call] = [
          {
            to: sub0.to as Address,
            value: hexToBigInt(sub0.value as Hex),
            data: sub0.data as Hex,
          },
          {
            to: sub1.to as Address,
            value: hexToBigInt(sub1.value as Hex),
            data: sub1.data as Hex,
          },
        ] as const;
        // Cheap shape pre-flight before any RPC. assertCreateMarketBatched-
        // CallsShape recurses into the sync single-call shape validator.
        assertCreateMarketBatchedCallsShape({
          chainId,
          safeAddress,
          calls,
        });
        const block = await getAaPublicClient(chainId).getBlock({
          blockTag: 'latest',
        });
        const aaClient = getAaPublicClient(chainId);
        await assertCreateMarketBatchedCallsSponsor({
          chainId,
          safeAddress,
          calls,
          nowSec: block.timestamp,
          readBlocked: async (safe) =>
            (await aaClient.readContract({
              address: MAKO_ADDRESS,
              abi: makoAbi,
              functionName: 'blocked',
              args: [safe],
            })) as boolean,
          readCreatorCreatesToday: async (safe) => {
            const [count, remaining] = (await aaClient.readContract({
              address: MAKO_ADDRESS,
              abi: makoAbi,
              functionName: 'creatorCreatesToday',
              args: [safe],
            })) as readonly [bigint, bigint];
            return { count, remaining };
          },
        });
        buildArgs = { kind: 'create_market_batched', calls };
        break;
      }
      case 'claim': {
        // claim-magic-parity: single-call MakoMarketsV4.claim(id) from
        // the Safe. No clock-relative checks — contract enforces
        // resolution + position + has-not-claimed.
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        assertClaimCall({ chainId, safeAddress, call });
        buildArgs = { kind: 'claim', call };
        break;
      }
      case 'pm_create_market': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };

        // Stage 1: cheap shape-only checks BEFORE any RPC. Wrong
        // target / value / selector / shape enum / metadata size /
        // immutable closeAt > stakingOpensAt all reject without
        // paying for getBlock OR getPmTreasuryAddress. An authed
        // caller spamming malformed bodies cannot force RPC reads.
        assertPmCreateMarketShapeNoTreasury({ chainId, safeAddress, call });

        // Parallel RPC reads — independent. getBlock is one roundtrip;
        // getPmTreasuryAddress is cached after first call (env fallback
        // on RPC failure per treasury.ts contract).
        const [treasury, block] = await Promise.all([
          getPmTreasuryAddress(),
          getAaPublicClient(chainId).getBlock({ blockTag: 'latest' }),
        ]);

        // Stage 1+2+3: full validator. Re-runs Stage 1 (cheap) plus
        // treasury exclusion + clock check. Keeps invariants
        // self-contained — each entry point validates everything it
        // claims to validate.
        assertPmCreateMarketCall({
          chainId,
          safeAddress,
          call,
          treasury,
          nowSec: block.timestamp,
        });

        // ABI-decode the call params to extract clientNonce + shape
        // for the draft-row gate. The validator already proved the
        // calldata decodes cleanly, so this can't realistically throw
        // here, but the try/catch keeps a malformed-decoded edge case
        // from escaping as a 500.
        let params: PmCreateParamsTuple;
        try {
          const decoded = decodeFunctionData({
            abi: PM_CREATE_MARKET_ABI,
            data: call.data,
          });
          params = (decoded.args as readonly [PmCreateParamsTuple])[0];
        } catch {
          throw new NotAllowedError('pm_bad_create_args', 'decode_failed');
        }

        // Draft-row gate (SELECT FOR UPDATE). Reasons map 1:1 to the
        // plan's 3 rejection paths; surfaced as 403 NOT_ALLOWED with
        // the helper's stable reason string in the response body.
        const gate = await assertPmSponsorDraft({
          chainId,
          contractAddress: PM_CONTRACT_ADDRESS,
          clientNonce: params.clientNonce,
          sessionWallet: safeAddress,
          shapeFromCall: mapShapeEnum(params.shape),
        });
        if (!gate.ok) {
          console.warn('[aa.sponsor.pm_gate_rejected]', {
            reason: gate.reason,
            userId: session.userId,
            chainId,
          });
          return Response.json(
            { error: 'NOT_ALLOWED', reason: gate.reason },
            { status: 403 },
          );
        }

        // ⚠️ Sweep race window opens here per v6 plan. Recovery is via
        // the indexer's dx-row path (processMarketCreated synthetic
        // insert) when MarketCreated arrives for a since-swept pending
        // row. No funds at risk; user just gets a synthetic-slug
        // market instead of their chosen one.
        buildArgs = { kind: 'pm_create_market', call };
        break;
      }

      // ── Phase 2E-1 PM action branches (slice 1D-2) ──────────────────────
      //
      // Seven branches share a chain-state hydration step: bet / stake
      // / resolve / confirm / distribute / cancel / edit_metadata all
      // need market state via `readSponsorMarketState`. Each route
      // invocation creates a FRESH request-scoped cache (per the
      // v7 MAJ-1 module-scope-cache bug). Even though each branch
      // currently only hydrates one marketId, the cache is the
      // contract for "no second multicall for the same id" — and a
      // future internal refactor (e.g., a pre-flight existence check)
      // would silently regress without it.
      //
      // Three branches need NO chain state: claim / finalize /
      // finalize_metadata — the contract enforces every gate and
      // idempotency. They run the structural-only validators below.
      //
      // bet / stake / resolve / edit_metadata all need `nowSec` for
      // their time-window check. `getBlock` is read once and passed
      // through.
      case 'pm_bet': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        // Codex r2 MAJ-1: cheap shape-only checks BEFORE getBlock(). A
        // malformed authenticated request must never force an RPC
        // roundtrip — same pattern createMarket already uses via
        // assertCreateMarketShape.
        assertPmBetCallShape({ chainId, safeAddress, call });
        const block = await getAaPublicClient(chainId).getBlock({
          blockTag: 'latest',
        });
        const cache = createSponsorMarketStateCache();
        await assertPmBetCall({
          chainId,
          safeAddress,
          call,
          nowSec: block.timestamp,
          cache,
        });
        buildArgs = { kind: 'pm_bet', call };
        break;
      }
      case 'pm_bet_batched': {
        // Codex r1 MAJ-1: Magic first-bet path. tuple[0] is
        // approve(USDC, PM, MaxUint256); tuple[1] is bet(...).
        const [a, b] = parsed.data.calls;
        const calls: readonly [Call, Call] = [
          {
            to: a.to as Address,
            value: hexToBigInt(a.value as Hex),
            data: a.data as Hex,
          },
          {
            to: b.to as Address,
            value: hexToBigInt(b.value as Hex),
            data: b.data as Hex,
          },
        ];
        // Codex r2 MAJ-1 pre-flight: shape-only batched check before
        // getBlock. Catches wrong approve target/spender/amount + wrong
        // bet target/selector/side/amount without paying for RPC.
        assertPmBetBatchedCallsShape({ chainId, safeAddress, calls });
        const block = await getAaPublicClient(chainId).getBlock({
          blockTag: 'latest',
        });
        const cache = createSponsorMarketStateCache();
        await assertPmBetBatchedCalls({
          chainId,
          safeAddress,
          calls,
          nowSec: block.timestamp,
          cache,
        });
        buildArgs = { kind: 'pm_bet_batched', calls };
        break;
      }
      case 'pm_stake': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        // Codex r2 MAJ-1 pre-flight.
        assertPmStakeCallShape({ chainId, safeAddress, call });
        const block = await getAaPublicClient(chainId).getBlock({
          blockTag: 'latest',
        });
        const cache = createSponsorMarketStateCache();
        await assertPmStakeCall({
          chainId,
          safeAddress,
          call,
          nowSec: block.timestamp,
          cache,
        });
        buildArgs = { kind: 'pm_stake', call };
        break;
      }
      case 'pm_stake_batched': {
        // Codex r1 MAJ-1: Magic first-stake path. Same as pm_bet_batched
        // but tuple[1] is stake(marketId, optionIndex, amount).
        const [a, b] = parsed.data.calls;
        const calls: readonly [Call, Call] = [
          {
            to: a.to as Address,
            value: hexToBigInt(a.value as Hex),
            data: a.data as Hex,
          },
          {
            to: b.to as Address,
            value: hexToBigInt(b.value as Hex),
            data: b.data as Hex,
          },
        ];
        // Codex r2 MAJ-1 pre-flight.
        assertPmStakeBatchedCallsShape({ chainId, safeAddress, calls });
        const block = await getAaPublicClient(chainId).getBlock({
          blockTag: 'latest',
        });
        const cache = createSponsorMarketStateCache();
        await assertPmStakeBatchedCalls({
          chainId,
          safeAddress,
          calls,
          nowSec: block.timestamp,
          cache,
        });
        buildArgs = { kind: 'pm_stake_batched', calls };
        break;
      }
      case 'pm_claim': {
        // No chain reads — contract enforces all gates.
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        assertPmClaimCall({ chainId, safeAddress, call });
        buildArgs = { kind: 'pm_claim', call };
        break;
      }
      case 'pm_resolve': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        // Codex r2 MAJ-1 pre-flight.
        assertPmResolveCallShape({ chainId, safeAddress, call });
        const block = await getAaPublicClient(chainId).getBlock({
          blockTag: 'latest',
        });
        const cache = createSponsorMarketStateCache();
        await assertPmResolveCall({
          chainId,
          safeAddress,
          call,
          nowSec: block.timestamp,
          cache,
        });
        buildArgs = { kind: 'pm_resolve', call };
        break;
      }
      case 'pm_confirm': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        // Codex r2 MAJ-1 pre-flight.
        assertPmConfirmCallShape({ chainId, safeAddress, call });
        const block = await getAaPublicClient(chainId).getBlock({
          blockTag: 'latest',
        });
        const cache = createSponsorMarketStateCache();
        await assertPmConfirmCall({
          chainId,
          safeAddress,
          call,
          nowSec: block.timestamp,
          cache,
        });
        buildArgs = { kind: 'pm_confirm', call };
        break;
      }
      case 'pm_distribute': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        // Codex r2 MAJ-1 pre-flight.
        assertPmDistributeCallShape({ chainId, safeAddress, call });
        const block = await getAaPublicClient(chainId).getBlock({
          blockTag: 'latest',
        });
        const cache = createSponsorMarketStateCache();
        await assertPmDistributeCall({
          chainId,
          safeAddress,
          call,
          nowSec: block.timestamp,
          cache,
        });
        buildArgs = { kind: 'pm_distribute', call };
        break;
      }
      case 'pm_cancel': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        // Codex r2 MAJ-1 pre-flight.
        assertPmCancelCallShape({ chainId, safeAddress, call });
        const block = await getAaPublicClient(chainId).getBlock({
          blockTag: 'latest',
        });
        const cache = createSponsorMarketStateCache();
        await assertPmCancelCall({
          chainId,
          safeAddress,
          call,
          nowSec: block.timestamp,
          cache,
        });
        buildArgs = { kind: 'pm_cancel', call };
        break;
      }
      case 'pm_finalize': {
        // No chain reads — contract handles existence + idempotency.
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        assertPmFinalizeCall({ chainId, safeAddress, call });
        buildArgs = { kind: 'pm_finalize', call };
        break;
      }
      case 'pm_finalize_metadata': {
        // No chain reads — contract handles existence + idempotency.
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        assertPmFinalizeMetadataCall({ chainId, safeAddress, call });
        buildArgs = { kind: 'pm_finalize_metadata', call };
        break;
      }
      case 'pm_edit_metadata': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        // Codex r2 MAJ-1 pre-flight: outer shape + decode + full
        // createMarket body validation on new params. NO treasury or
        // block read here — those land after this gate passes. A
        // malformed pm_edit_metadata caller can't force RPC.
        assertPmEditMetadataCallShapeNoTreasury({
          chainId,
          safeAddress,
          call,
        });
        const block = await getAaPublicClient(chainId).getBlock({
          blockTag: 'latest',
        });
        const cache = createSponsorMarketStateCache();
        await assertPmEditMetadataCall({
          chainId,
          safeAddress,
          call,
          nowSec: block.timestamp,
          cache,
        });
        buildArgs = { kind: 'pm_edit_metadata', call };
        break;
      }
      // Rounds (MakoRoundsV1). Refused with round_unavailable while Rounds is not live.
      case 'round_enter':
      case 'round_claim':
      case 'round_refund':
      case 'round_schedule': {
        const c = parsed.data.call;
        const call: Call = {
          to: c.to as Address,
          value: hexToBigInt(c.value as Hex),
          data: c.data as Hex,
        };
        const kind = parsed.data.kind;
        if (kind === 'round_enter') assertRoundEnterCall({ chainId, call });
        else if (kind === 'round_claim') assertRoundClaimCall({ chainId, call });
        else if (kind === 'round_refund') assertRoundRefundCall({ chainId, call });
        else {
          // Shape first, with no chain read, so a malformed request (or Rounds not live) never costs an RPC call.
          // Then the lead window by the latest block's time (the clock the contract uses), then only a creator is
          // sponsored: schedule() reverts for anyone else.
          assertRoundScheduleShape({ chainId, call });
          const client = getAaPublicClient(chainId);
          const block = await client.getBlock({ blockTag: 'latest' });
          assertRoundScheduleCall({ chainId, call, nowSec: Number(block.timestamp) });
          await assertRoundScheduler(safeAddress, (who) =>
            // The pinned ROUNDS address (non-null here: the validator above refuses when Rounds is not live).
            client.readContract({ address: ROUNDS_ADDRESS as Address, abi: roundsAbi, functionName: 'isCreator', args: [who] }),
          );
        }
        buildArgs = { kind, call };
        break;
      }
      case 'round_enter_batched': {
        const [a, b] = parsed.data.calls;
        const calls: readonly [Call, Call] = [
          { to: a.to as Address, value: hexToBigInt(a.value as Hex), data: a.data as Hex },
          { to: b.to as Address, value: hexToBigInt(b.value as Hex), data: b.data as Hex },
        ];
        assertRoundEnterBatchedCalls({ chainId, calls });
        buildArgs = { kind: 'round_enter_batched', calls };
        break;
      }
    }
  } catch (e) {
    if (e instanceof NotAllowedError) {
      // Round-8 MINOR 2: log `detail` for operators (when present) so
      // a NOT_ALLOWED rejection is debuggable beyond the stable reason
      // string. Response body intentionally omits detail — UI branches
      // on `reason` only and shouldn't see implementation specifics.
      console.warn('[aa.sponsor.not_allowed]', {
        reason: e.reason,
        detail: e.detail,
        userId: session.userId,
        chainId,
        kind: parsed.data.kind,
      });
      // Rounds not live is not the caller's fault (503); a failed creator read is an upstream failure (502).
      const status = e.reason === 'round_unavailable' ? 503 : e.reason === 'round_state_rpc_failure' ? 502 : 403;
      return Response.json(
        { error: 'NOT_ALLOWED', reason: e.reason },
        { status },
      );
    }
    // codex r1 4f-fe MINOR 1: validators may now do chain reads
    // (`blocked(safe)`, `creatorCreatesToday(safe)`) and either can
    // reject with a non-NotAllowedError if the RPC errors or the view
    // reverts (e.g. interim state between FE deploy and contract
    // redeploy). Map to a clean 502 with a sanitized summary instead
    // of letting Next surface a generic 500. No funds at risk —
    // incrementOrReject hasn't run yet — but the user deserves a
    // clear error and operators a debuggable log line.
    const summary = summarizeAaErrorWithCause(e);
    console.error('[aa.sponsor.validate_failed]', {
      userId: session.userId,
      chainId,
      kind: parsed.data.kind,
      ...summary,
    });
    return Response.json(
      { error: 'VALIDATE_FAILED' },
      { status: 502 },
    );
  }

  // Step 6: PRECHECK in-flight.
  const preExisting = await loadInFlightForSafe({ chainId, safeAddress });
  if (preExisting) {
    const result = serializeExistingInFlight({
      existing: preExisting,
      sessionUserId: session.userId,
      chainId,
    });
    return Response.json(result.body, { status: result.status });
  }

  // Step 7: atomic rate-limit increment.
  const limit = await incrementOrReject({
    userId: session.userId,
    chainId,
  });
  if (limit.kind === 'cap_exceeded') {
    return Response.json(
      { error: 'CAP_EXCEEDED', count: limit.count },
      { status: 429 },
    );
  }

  // Step 8: buildSponsoredUserOp. Branch on the discriminated buildArgs
  // so TypeScript's discriminated-union arg type narrows correctly.
  let built: Awaited<ReturnType<typeof buildSponsoredUserOp>>;
  try {
    if ('calls' in buildArgs) {
      built = await buildSponsoredUserOp({
        chainId,
        safeAddress,
        magicEoa: session.magicEoa as Address,
        calls: buildArgs.calls,
      });
    } else {
      built = await buildSponsoredUserOp({
        chainId,
        safeAddress,
        magicEoa: session.magicEoa as Address,
        call: buildArgs.call,
      });
    }
  } catch (e) {
    // Refund policy: PathXMismatch (pre-RPC code-side bug) refunds. All
    // Pimlico-side failures preserve the count (the user's attempt counted
    // against the local cap; Pimlico enforces dollar caps independently).
    if (isPathXMismatch(e)) {
      await decrementForRefund({ userId: session.userId, chainId });
    }
    const summary = summarizeAaErrorWithCause(e);
    console.error('[aa.sponsor.build_failed]', summary);
    const mapped = mapBuildErrorToResponse(e);
    return Response.json(mapped.body, { status: mapped.status });
  }

  // Step 9: INSERT pending row; partial unique index is the final
  // concurrency primitive.
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS);
  const inserted = await insertPending({
    userId: session.userId,
    chainId,
    safeAddress,
    magicEoa: session.magicEoa as Address,
    userOp: built.userOp,
    nonceHex: toHex(storedToPacked(built.userOp).nonce),
    safeOpHash: built.safeOpHash,
    expiresAt,
  });

  if (inserted.kind === 'conflict') {
    // Lost the partial-index race. Refund this caller's increment; the
    // Pimlico spend on `built` is unrecoverable but logged.
    await decrementForRefund({ userId: session.userId, chainId });
    console.warn('[aa.sponsor.race_lost]', {
      userId: session.userId,
      chainId,
      safeAddress,
      pimlicoSpendUnrecoverable: true,
    });

    const winner = await loadInFlightForSafe({ chainId, safeAddress });
    if (!winner) {
      // Edge case: the winner row got terminal between INSERT-conflict
      // and reload. Treat as transient — caller can retry.
      return Response.json(
        { error: 'IN_FLIGHT', message: 'in-flight row vanished mid-resolve' },
        { status: 409 },
      );
    }
    const result = serializeExistingInFlight({
      existing: winner,
      sessionUserId: session.userId,
      chainId,
    });
    return Response.json(result.body, { status: result.status });
  }

  // Step 10: success — return the freshly-built signing payload.
  return Response.json({
    pendingUserOpId: inserted.id,
    userOp: built.userOp,
    safeOpHash: built.safeOpHash,
    userOpHash: built.userOpHash,
    validAfter: '0x0',
    validUntil: toHex(VALIDITY_WINDOW_MAX_UINT48),
    expiresAt: inserted.expiresAt.toISOString(),
  });
}
