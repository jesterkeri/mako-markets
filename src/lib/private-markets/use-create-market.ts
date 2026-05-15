'use client';

// ----------------------------------------------------------------------------
// src/lib/private-markets/use-create-market.ts
//
// Phase 2C-2 Step 4: usePmCreateMarket — the dual-path (Magic + wallet)
// state machine that powers /create/private. Mirrors the pattern proven
// in usePlaceBet (src/lib/hooks.ts ~line 283) and per-shape
// requirements from Phase 2C-2 plan v6.
//
// Architecture (plan v6 lines 122-171):
//
//   submit(state)
//     │
//     ├─ Magic branch:
//     │   1. (no ensureChain — Safe is chain-bound)
//     │   2. buildCreateParamsWithoutNonce(state)
//     │   3. runCreatePrivateMarket(...) — orchestrator owns the
//     │      clientNonce + draft POST + sponsor + sign + send.
//     │   4. hasPmDraftRef(outcome) extracts pmDraft for redirect.
//     │   5. router.push(`/m/<slug>`).
//     │
//     └─ Wallet branch:
//         0. Identity guard. connectedAddress === session.walletAddress?
//         1. ensureMonadChain — user-rejection → 'chain_switch_denied'
//         2. POST /api/pm/markets/draft → { pendingDbId, slug, clientNonce }
//         3. buildCreateParams(state, clientNonce) → 17-field tuple
//         4. simulateContract — revert → 'simulate_reverted', draft preserved
//         5. writeContractAsync — user-reject → 'user_rejected', draft preserved
//         6. waitForTransactionReceipt(90s timeout). reverted/timeout
//            preserve draft so the UI can deep-link `/m/<slug>` for retry.
//         7. router.push(`/m/<slug>`).
//
// Key invariants:
//   - inFlightRef synchronous double-submit guard
//   - publicClient pinned to Monad testnet
//   - Every post-draft error carries error.draft = { slug, ... }
//   - Auto-resets phase on submit entry from 'error'
// ----------------------------------------------------------------------------

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import {
  decodeErrorResult,
  type Address,
  type Hex,
  type WriteContractParameters,
} from 'viem';

import {
  generateClientNonce,
  hasPmDraftRef,
  runCreatePrivateMarket,
} from '@/lib/aa-client';
import { monadTestnet, MONAD_TESTNET_ID } from '@/lib/chain';
import { PM_CONTRACT_ADDRESS } from '@/lib/contract';
import { useEnsureMonadChain } from '@/lib/hooks';
import { useUser } from '@/lib/use-user';
import { PM_CREATE_MARKET_ABI } from './abi-fragments';
import {
  buildCreateParams,
  buildCreateParamsWithoutNonce,
  type PmCreateDraftRef,
  type PmCreateError,
  type PmCreateErrorKind,
  type PmCreateFormState,
  type PmCreatePhase,
  type PmCreateResult,
} from './create-form';
import { isWalletIdentityAligned } from './identity-guard';

/// Local mapper. The existing `friendlyWriteError` in /create/page.tsx
/// is private to that file; rather than refactor an unrelated surface,
/// we duplicate the short list of recognized phrases. Keep this list
/// in sync if the source list grows (or extract both later when there's
/// a third copy — rule of three).
function friendlyWalletError(e: Error): string {
  const msg = (e.message || '').toLowerCase();
  if (msg.includes('user rejected') || msg.includes('user denied')) {
    return 'REJECTED IN WALLET';
  }
  if (msg.includes('insufficient funds')) {
    return 'INSUFFICIENT MON BALANCE';
  }
  if (
    msg.includes('requested resource not available') ||
    msg.includes('unsupported chain') ||
    msg.includes('chain mismatch')
  ) {
    return 'SWITCH WALLET TO MONAD TESTNET';
  }
  return `ERROR: ${e.message.slice(0, 120).toUpperCase()}`;
}

/// Pull the contract error name out of a simulateContract revert, if
/// the viem error chain carries decoded args. Returns undefined when
/// the revert wasn't a typed contract error (raw revert, gas issue,
/// network blip). The UI uses this only to enrich the error message —
/// nothing branches on it.
function decodeContractError(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') return undefined;
  // viem wraps the original revert in a chain of nested causes. We
  // walk a small fixed depth rather than recursing without bound.
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const obj = cur as {
      name?: string;
      errorName?: string;
      data?: Hex;
      cause?: unknown;
    };
    if (obj.errorName) return obj.errorName;
    if (obj.data && typeof obj.data === 'string' && obj.data.startsWith('0x')) {
      try {
        const decoded = decodeErrorResult({
          abi: PM_CREATE_MARKET_ABI,
          data: obj.data,
        });
        if (decoded?.errorName) return decoded.errorName;
      } catch {
        // ABI doesn't carry the matching error fragment — fall through.
      }
    }
    cur = obj.cause;
  }
  return undefined;
}

export interface UsePmCreateMarket {
  phase: PmCreatePhase;
  error: PmCreateError | null;
  result: PmCreateResult | null;
  reset: () => void;
  submit: (state: PmCreateFormState) => Promise<void>;
}

export function usePmCreateMarket(): UsePmCreateMarket {
  const router = useRouter();
  const { user } = useUser();
  const { address: connectedAddress } = useAccount();
  const publicClient = usePublicClient({ chainId: monadTestnet.id });
  const ensureChain = useEnsureMonadChain();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<PmCreatePhase>('idle');
  const [error, setError] = useState<PmCreateError | null>(null);
  const [result, setResult] = useState<PmCreateResult | null>(null);

  /// Synchronous double-submit guard. Mirrors usePlaceBet.
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    setPhase('idle');
    setError(null);
    setResult(null);
  }, []);

  const submit = useCallback(
    async (formState: PmCreateFormState): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      // Auto-reset on re-entry from 'error' so the retry CTA on the
      // form's error block can call submit() directly without the form
      // needing to call reset() first.
      setError(null);
      setResult(null);
      setPhase('preparing');

      /// Construct a typed error without throwing. The caller throws
      /// it so TS recognises the throw as control-flow-terminating
      /// (an indirectly-called helper with `:never` doesn't always
      /// narrow types correctly through try/catch).
      const mkErr = (
        kind: PmCreateErrorKind,
        message: string,
        opts: {
          draft?: PmCreateDraftRef;
          contractError?: string;
          technical?: string;
        } = {},
      ): PmCreateError => ({ kind, message, ...opts });

      try {
        if (!user) {
          throw mkErr('unknown', 'NOT SIGNED IN');
        }

        // ── Wallet branch ────────────────────────────────────────────
        if (user.authType === 'wallet') {
          if (!publicClient) {
            throw mkErr('unknown', 'RPC CLIENT NOT READY — RETRY');
          }

          // Step 0a: identity guard.
          if (
            !isWalletIdentityAligned({
              authType: 'wallet',
              sessionWalletAddress: user.walletAddress,
              connectedAddress,
            })
          ) {
            throw mkErr(
              'wallet_drift',
              'CONNECTED WALLET DOES NOT MATCH SIGNED-IN WALLET',
            );
          }

          // Step 0b: ensure chain.
          try {
            await ensureChain();
          } catch (e) {
            throw mkErr(
              'chain_switch_denied',
              friendlyWalletError(e as Error),
            );
          }

          // Step 1: draft.
          setPhase('wallet_drafting');
          const clientNonce = generateClientNonce();
          const draftResp = await fetch('/api/pm/markets/draft', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chainId: MONAD_TESTNET_ID,
              contractAddress: PM_CONTRACT_ADDRESS,
              shape: formState.shape,
              clientNonce,
            }),
          });
          if (!draftResp.ok) {
            const body = (await draftResp.json().catch(() => ({}))) as {
              error?: string;
              count?: number;
            };
            const code = body.error ?? `HTTP_${draftResp.status}`;
            const extra =
              code === 'pm_draft_pending_cap'
                ? ` (PENDING DRAFTS: ${body.count ?? '?'})`
                : '';
            throw mkErr('draft_failed', `DRAFT FAILED: ${code}${extra}`);
          }
          const draftBody = (await draftResp.json()) as PmCreateDraftRef;
          const draft: PmCreateDraftRef = {
            slug: draftBody.slug,
            clientNonce: draftBody.clientNonce,
            pendingDbId: draftBody.pendingDbId,
          };

          // Step 2: build params.
          let params;
          try {
            params = buildCreateParams(formState, draft.clientNonce);
          } catch (e) {
            throw mkErr(
              'unknown',
              `INVALID FORM STATE: ${(e as Error).message}`,
              { draft },
            );
          }

          // Step 3: simulate.
          setPhase('wallet_simulating');
          let simRequest: WriteContractParameters;
          try {
            const sim = await publicClient.simulateContract({
              abi: PM_CREATE_MARKET_ABI,
              address: PM_CONTRACT_ADDRESS,
              functionName: 'createMarket',
              args: [params],
              account: connectedAddress as Address,
            });
            simRequest = sim.request as WriteContractParameters;
          } catch (e) {
            throw mkErr(
              'simulate_reverted',
              friendlyWalletError(e as Error),
              { draft, contractError: decodeContractError(e) },
            );
          }

          // Step 4: write.
          let txHash: Hex;
          try {
            txHash = await writeContractAsync(simRequest);
          } catch (e) {
            const msg = (e as Error).message.toLowerCase();
            if (msg.includes('user rejected') || msg.includes('user denied')) {
              throw mkErr('user_rejected', 'REJECTED IN WALLET', { draft });
            }
            throw mkErr('wallet_error', friendlyWalletError(e as Error), {
              draft,
            });
          }

          // Step 5: receipt.
          setPhase('wallet_pending');
          let receipt;
          try {
            receipt = await publicClient.waitForTransactionReceipt({
              hash: txHash,
              timeout: 90_000,
            });
          } catch {
            throw mkErr('receipt_timeout', 'TX TIMED OUT — CHECK EXPLORER', {
              draft,
            });
          }
          if (receipt.status !== 'success') {
            throw mkErr('receipt_reverted', 'TX REVERTED ON CHAIN', {
              draft,
            });
          }

          setResult({
            slug: draft.slug,
            txHash,
            pendingDbId: draft.pendingDbId,
          });
          setPhase('success');
          router.push(`/m/${draft.slug}`);
          return;
        }

        // ── Magic branch ────────────────────────────────────────────
        if (user.authType === 'magic') {
          setPhase('sponsoring');
          // Codex r2 MAJ-1: Magic path uses the no-nonce builder; the
          // orchestrator generates the clientNonce internally.
          const params = buildCreateParamsWithoutNonce(formState);
          const outcome = await runCreatePrivateMarket({
            chainId: MONAD_TESTNET_ID,
            magicEoa: user.magicEoa as Address,
            createParams: params,
          });

          // Codex r5 MAJ-1: every post-draft outcome carries pmDraft.
          // Extract via type guard so TS narrows.
          const draft: PmCreateDraftRef | undefined = hasPmDraftRef(outcome)
            ? {
                slug: outcome.pmDraft.slug,
                clientNonce: outcome.pmDraft.clientNonce,
                pendingDbId: outcome.pmDraft.pendingDbId,
              }
            : undefined;

          if (outcome.kind === 'sent') {
            // Orchestrator always populates pmDraft on a post-draft
            // outcome, but check defensively rather than silently
            // sending the user to a missing slug.
            if (!hasPmDraftRef(outcome)) {
              throw mkErr('unknown', 'INTERNAL: sent without pmDraft');
            }
            setResult({
              slug: outcome.pmDraft.slug,
              txHash: outcome.txHash,
              pendingDbId: outcome.pmDraft.pendingDbId,
            });
            setPhase('success');
            router.push(`/m/${outcome.pmDraft.slug}`);
            return;
          }
          if (outcome.kind === 'sponsor_failed') {
            const kind: PmCreateErrorKind =
              outcome.step === 'draft'
                ? 'sponsor_failed_predraft'
                : 'sponsor_failed_postdraft';
            throw mkErr(kind, `SPONSOR FAILED: ${outcome.error}`, { draft });
          }
          if (outcome.kind === 'send_failed') {
            throw mkErr('send_failed', `SEND FAILED: ${outcome.error}`, {
              draft,
            });
          }
          if (outcome.kind === 'expired') {
            throw mkErr('send_expired', 'SIGN TIMED OUT — TRY AGAIN', {
              draft,
            });
          }
          if (outcome.kind === 'reverted') {
            throw mkErr(
              'send_reverted',
              `TX REVERTED: ${outcome.failureReason}`,
              { draft },
            );
          }
          if (outcome.kind === 'failed_pre_submit') {
            throw mkErr(
              'send_failed_pre_submit',
              `PRE-SUBMIT FAILED: ${outcome.failureReason}`,
              { draft },
            );
          }
          if (outcome.kind === 'in_progress') {
            throw mkErr(
              'send_in_progress',
              `IN PROGRESS — RETRY IN ${outcome.retryAfterSeconds}S`,
              { draft },
            );
          }
          if (outcome.kind === 'manual_review') {
            throw mkErr(
              'send_manual_review',
              'OPERATOR REVIEW REQUIRED — CONTACT SUPPORT',
              { draft },
            );
          }
          if (outcome.kind === 'submitted') {
            // Phase 1I Magic status polling isn't fully wired for PM
            // ops yet (plan v6 risks section). For 2C-2 we surface
            // 'submitted' as a soft error with draft preserved so the
            // user can revisit /m/<slug> later.
            throw mkErr(
              'send_submitted_pending',
              'TX SUBMITTED — RECEIPT STILL PENDING; CHECK BACK',
              { draft },
            );
          }
          throw mkErr('unknown', 'UNEXPECTED OUTCOME', { draft });
        }

        throw mkErr('unknown', 'UNKNOWN AUTH TYPE');
      } catch (e) {
        // Either a PmCreateError thrown by `fail()` or an unexpected
        // throw. Coerce to PmCreateError.
        const isPmError =
          e && typeof e === 'object' && 'kind' in (e as object);
        const err: PmCreateError = isPmError
          ? (e as PmCreateError)
          : {
              kind: 'unknown',
              message: `UNEXPECTED ERROR: ${(e as Error)?.message ?? 'unknown'}`,
            };
        setError(err);
        setPhase('error');
      } finally {
        inFlightRef.current = false;
      }
    },
    [
      user,
      connectedAddress,
      publicClient,
      ensureChain,
      writeContractAsync,
      router,
    ],
  );

  return { phase, error, result, reset, submit };
}
