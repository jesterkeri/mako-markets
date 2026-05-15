'use client';

// ----------------------------------------------------------------------------
// src/app/create/private/page.tsx
//
// Phase 2C-2 Step 1: production "Create Private Market" page. Public
// route — any signed-in user can land here. Sibling to /create (public
// markets); this file does NOT touch the existing /create page.
//
// Owns:
//   - Per-page form state (PmCreateFormState + shape selector).
//   - Auth gate (sign-in CTA when no session).
//   - WalletDriftBanner + `drifted` prop threaded to each shape form.
//   - Search-param deep-link: /create/private?shape=friendly preselects.
//
// Defers to:
//   - usePmCreateMarket() for the actual submit state machine.
//   - validatePmCreateForm() for per-keystroke validation.
//   - Gemini-built ShapePicker / CommonFields / *Form components for
//     visual presentation.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAccount, useReadContract } from 'wagmi';
import type { Address } from 'viem';

import { MobileChromeHeader } from '@/components/MobileChromeHeader';
import { ThemeToggle } from '@/components/ThemeToggle';
import { WalletDriftBanner } from '@/components/WalletDriftBanner';
import { MONAD_TESTNET_ID } from '@/lib/chain';
import { PM_CONTRACT_ADDRESS } from '@/lib/contract';
import { useUser } from '@/lib/use-user';
import { isWalletDrifted } from '@/lib/wallet-drift';
import { PM_TREASURY_ABI } from '@/lib/private-markets/abi-fragments';
import {
  initialFormStateForShape,
  validatePmCreateForm,
  type PmCreateFormState,
  type PmShape,
} from '@/lib/private-markets/create-form';
import { usePmCreateMarket } from '@/lib/private-markets/use-create-market';

import { HoverRevealPicker } from '@/components/HoverRevealPicker';
import { FriendlyForm } from './_components/FriendlyForm';
import { OpenVoteForm } from './_components/OpenVoteForm';
import { PrizePoolForm } from './_components/PrizePoolForm';

function isPmShape(s: string | null): s is PmShape {
  return s === 'friendly' || s === 'open_vote' || s === 'prize_pool';
}

export default function CreatePrivateMarketPage() {
  const { user } = useUser();
  const { address: connectedWallet } = useAccount();
  const searchParams = useSearchParams();
  const { phase, error, submit } = usePmCreateMarket();

  // Shape is URL-driven: HoverRevealPicker navigates via ?shape= so a
  // child click re-renders the page with the new shape. Reading from
  // searchParams directly (not useState) keeps URL the source of
  // truth so deep-links, back-button, and re-navigation all work.
  const rawShape = searchParams.get('shape');
  const shape: PmShape | null = isPmShape(rawShape) ? rawShape : null;

  // Form state — re-initialised whenever the user picks a new shape
  // so shape-specific defaults (e.g. Friendly's locked NO/YES options)
  // land cleanly. Uses a guard against shape changes to avoid wiping
  // user typing on unrelated re-renders.
  const [formState, setFormState] = useState<PmCreateFormState>(
    () => initialFormStateForShape(shape ?? 'friendly'),
  );
  const lastShapeRef = useRef<PmShape | null>(shape);
  useEffect(() => {
    if (shape && shape !== lastShapeRef.current) {
      setFormState(initialFormStateForShape(shape));
      lastShapeRef.current = shape;
    }
  }, [shape]);

  const onChange = <K extends keyof PmCreateFormState>(
    key: K,
    value: PmCreateFormState[K],
  ) => {
    setFormState((prev) => ({ ...prev, [key]: value }));
  };

  // Codex r2 MAJ-2: read the PM treasury address once on mount so the
  // validator can reject treasury-in-allowlist and treasury-in-Prize-
  // Pool-participants at submit time. Without this, the validator
  // silently skipped those checks and the contract revert was the
  // first place the user found out — after a draft slot had already
  // been allocated. Treasury is immutable per contract (set in the
  // constructor, no setter), so a single chain read is authoritative.
  const treasuryRead = useReadContract({
    address: PM_CONTRACT_ADDRESS,
    abi: PM_TREASURY_ABI,
    functionName: 'treasury',
    chainId: MONAD_TESTNET_ID,
    query: {
      // Treasury never changes — cache it forever within the session.
      staleTime: Infinity,
      gcTime: Infinity,
    },
  });
  const treasuryAddress: Address | null = treasuryRead.data
    ? (treasuryRead.data as Address)
    : null;
  const treasuryLoading = treasuryRead.isLoading;
  const treasuryError = treasuryRead.isError;

  // Validator runs on every render — cheap, pure, no fetch. The form
  // components display per-field errors and compute submit enablement.
  const errors = useMemo(
    () => validatePmCreateForm(formState, { treasuryAddress }),
    [formState, treasuryAddress],
  );

  const drifted = isWalletDrifted(user ?? null, connectedWallet);
  const signedIn = Boolean(user);
  // Codex r2 MAJ-2: gate submit on treasury being known. While loading,
  // the validator can't enforce the treasury exclusion checks, so
  // letting submit through would re-introduce the bug we're fixing.
  const submitBlockedByTreasury = treasuryLoading || treasuryError;

  const onSubmit = () => {
    if (submitBlockedByTreasury) return;
    void submit(formState);
  };

  return (
    <main className="flex-1 flex flex-col w-full pb-16 bg-canvas text-canvas-fg min-h-screen">
      <MobileChromeHeader />
      <header className="hidden md:flex items-center justify-between px-6 lg:px-8 h-12 border-b-2 border-chrome-divider bg-chrome text-chrome-fg sticky top-0 z-30">
        <h1 className="mako-display text-sm lg:text-base text-chrome-fg">NEW PRIVATE MARKET</h1>
        <ThemeToggle />
      </header>
      <div className="flex-1">
        {/* Picker + heading — render only BEFORE a shape is committed.
            Once the user picks Friendly / Open Vote / Prize Pool, the
            URL gains ?shape=..., the picker hides, and the form takes
            over the viewport. Mirrors the same UX on /create. */}
        {shape === null && (
          <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 pt-8">
            <h1 className="font-display font-bold text-3xl sm:text-4xl uppercase mb-6">
              CREATE PRIVATE MARKET
            </h1>
            <HoverRevealPicker className="mb-8" />
          </div>
        )}

        <div className="max-w-[1400px] w-full mx-auto px-4 sm:px-6 lg:px-8 pt-6 md:pt-10 pb-8 space-y-6">
          {/* Drift banner — only renders when user is wallet-authed AND
              connected address differs from session wallet. Form below
              also disables via the `drifted` prop so the user can't
              submit through a misaligned identity. */}
          {drifted && user?.authType === 'wallet' && connectedWallet && (
            <div className="mb-6">
              <WalletDriftBanner
                sessionWallet={user.walletAddress}
                connectedWallet={connectedWallet}
              />
            </div>
          )}

          {/* Per-shape heading + change-type back link. Mirrors the
              public /create heading: orients the user after they pick a
              private shape and gives a one-click path back to the
              picker. */}
          {shape !== null && (
            <div>
              <Link
                href="/create/private"
                className="inline-flex items-center gap-1 mako-label text-canvas-fg/70 hover:text-link-hover transition-colors mb-3"
              >
                ← CHANGE MARKET TYPE
              </Link>
              <h2 className="font-display font-black text-4xl md:text-5xl uppercase tracking-tight text-canvas-fg leading-none">
                {shape === 'friendly' && 'FRIENDLY MARKET'}
                {shape === 'open_vote' && 'OPEN VOTE MARKET'}
                {shape === 'prize_pool' && 'PRIZE POOL MARKET'}
              </h2>
              <p className="font-sans text-canvas-fg/80 text-base md:text-lg mt-2 leading-snug">
                {shape === 'friendly' && 'Two-sided prediction with locked NO and YES options. Best for one-on-one calls.'}
                {shape === 'open_vote' && 'Multi-option vote with a fixed stake per voter. Winners split the pot.'}
                {shape === 'prize_pool' && 'Named participants compete. The wallets you list are the only ones who can be picked as the winner.'}
              </p>
            </div>
          )}

          {/* Auth gate — gentle CTA, no 404. */}
          {!signedIn && (
            <div className="border-2 border-ink bg-paper p-4 shadow-brutal space-y-2">
              <p className="font-bold uppercase">SIGN IN TO CREATE A MARKET.</p>
              <Link
                href="/signup"
                className="inline-block border-2 border-ink bg-ink text-paper px-4 py-2 font-bold uppercase hover:bg-surface-elevated hover:text-ink transition-colors"
              >
                SIGN IN
              </Link>
            </div>
          )}

          {/* Codex r2 MAJ-2: surface treasury fetch state when it's
              blocking submit. Hidden on the happy path so the rest of
              the form stays uncluttered. */}
          {shape !== null && signedIn && treasuryError && (
            <div className="border-2 border-ink bg-paper p-4 shadow-brutal space-y-2">
              <p className="font-bold uppercase">
                TREASURY CHECK UNAVAILABLE
              </p>
              <p className="text-sm">
                The on-chain treasury address could not be fetched. This
                is required to validate the allowlist + participants.
                Refresh the page to retry.
              </p>
            </div>
          )}
          {shape !== null && signedIn && treasuryLoading && !treasuryError && (
            <div className="border-2 border-ink bg-surface-elevated p-3 text-sm font-bold uppercase">
              VERIFYING TREASURY ADDRESS...
            </div>
          )}

          {/* Shape form — only renders after a shape is picked. */}
        {shape === 'friendly' && (
          <FriendlyForm
            state={formState}
            errors={errors}
            onChange={onChange}
            onSubmit={onSubmit}
            phase={phase}
            error={error}
            drifted={drifted}
            signedIn={signedIn}
            submitBlocked={submitBlockedByTreasury}
            submitBlockedReason={
              treasuryError
                ? 'TREASURY CHECK UNAVAILABLE'
                : treasuryLoading
                  ? 'VERIFYING TREASURY...'
                  : null
            }
          />
        )}
        {shape === 'open_vote' && (
          <OpenVoteForm
            state={formState}
            errors={errors}
            onChange={onChange}
            onSubmit={onSubmit}
            phase={phase}
            error={error}
            drifted={drifted}
            signedIn={signedIn}
            submitBlocked={submitBlockedByTreasury}
            submitBlockedReason={
              treasuryError
                ? 'TREASURY CHECK UNAVAILABLE'
                : treasuryLoading
                  ? 'VERIFYING TREASURY...'
                  : null
            }
          />
        )}
          {shape === 'prize_pool' && (
            <PrizePoolForm
              state={formState}
              errors={errors}
              onChange={onChange}
              onSubmit={onSubmit}
              phase={phase}
              error={error}
              drifted={drifted}
              signedIn={signedIn}
              submitBlocked={submitBlockedByTreasury}
              submitBlockedReason={
                treasuryError
                  ? 'TREASURY CHECK UNAVAILABLE'
                  : treasuryLoading
                    ? 'VERIFYING TREASURY...'
                    : null
              }
            />
          )}
        </div>
      </div>
    </main>
  );
}
