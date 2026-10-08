'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAccount, useWaitForTransactionReceipt } from 'wagmi';
import { decodeMarketCreatedId, MarketType } from '@/lib/contract';
import { useCreateMarket, type CreateMarketResult } from '@/lib/hooks';
import { useUser } from '@/lib/use-user';
import { useIsAdmin } from '@/lib/admin';
import { useAdminSession } from '@/lib/use-admin-session';
import { isWalletDrifted } from '@/lib/wallet-drift';
import { WalletDriftBanner } from '@/components/WalletDriftBanner';
import { AdminNav } from '@/components/AdminNav';
import { AdminLogin } from '@/components/AdminLogin';
import { TopBar, NotAuthorized } from '@/components/admin-shared';
import { toBytes32 } from '@/lib/oracle';
import { validateMarketTimestamps } from '@/lib/market-timing';
import {
  MAKO_LABEL_MAX_BYTES,
  utf8ByteLength as utf8ByteLengthShared,
  validateLabelPair,
} from '@/lib/mako-labels';
import { describeTime, fromLocalInput, localInputProblem, toLocalInput } from '@/lib/datetime-local';

/**
 * /admin/create-mako -- admin-curated MAKO market creation.
 *
 * MAKO markets are the contract's special 7th market type (admin-only,
 * free-form question, no creator seed required, 99% payout to bettors
 * after 1% protocol fee). The on-chain enforcement is `msg.sender ==
 * owner()` on the v4 contract; this page is the only UI surface that
 * exposes the form.
 *
 * Gate stack (post outcome-labels round-9 — wallet-only):
 *   1. `useIsAdmin()` — wallet must equal ADMIN_ADDRESS (resolver EOA).
 *      Magic admin doesn't pass this gate; they hit <NotAuthorized />.
 *      Rationale: per the v4 deploy resume point, owner rotation to a
 *      Safe was skipped. Contract `owner()` is still the EOA, so the
 *      Magic-admin path on this surface can only ever revert at the
 *      onlyOwner modifier. Narrowing the client gate removes that
 *      dead path and aligns with the SIWE-only labels write route.
 *   2. `useAdminSession()` — wallet match + SIWE cookie. If wallet
 *      matches but SIWE absent, render <AdminLogin />. This guarantees
 *      that by the time the form is reachable, the POST to
 *      /api/admin/mako-labels (which uses getAdminSession()) will not
 *      401 under normal flow.
 *   3. `useUser().authType === 'wallet'` — closes the Group B
 *      adversarial-review MAJOR. `useCreateMarket()` chooses Magic
 *      vs wagmi based on `useUser().authType`, not the wagmi
 *      connection. A session that's signed in via Magic email AND
 *      has the admin wallet connected would otherwise route the tx
 *      through the AA/Magic path (which would revert at onlyOwner).
 *      Requiring an explicitly wallet-authed session keeps the create
 *      tx on the wagmi path, matching this surface's contract gate.
 *
 * Submission flow:
 *   1. createMarket via wagmi (wallet-only path through useCreateMarket).
 *   2. After tx lands and MarketCreated yields newId, if the admin
 *      filled both labels, POST them to /api/admin/mako-labels.
 *      Labels are snapshotted at submit time (savedLabels state) so
 *      late edits to the input fields can't race with an in-flight
 *      POST and silently overwrite newer labels with older — Group B
 *      review MAJOR 3.
 *   3. If the label save fails, the market still exists on chain with
 *      the default YES/NO display; we surface a recovery banner
 *      pointing at /admin/markets/[id]/labels.
 *   4. Redirect to /market/[newId].
 */
function friendlyWriteError(e: Error): string {
  const msg = (e.message || '').toLowerCase();
  if (msg.includes('switch your wallet to monad')) {
    return 'SWITCH WALLET TO MONAD TESTNET';
  }
  if (msg.includes('user rejected') || msg.includes('user denied')) {
    return 'REJECTED IN WALLET';
  }
  if (msg.includes('insufficient funds')) {
    return 'INSUFFICIENT MON BALANCE';
  }
  if (
    msg.includes('requested resource not available')
    || msg.includes('unsupported chain')
    || msg.includes('chain mismatch')
  ) {
    return 'SWITCH WALLET TO MONAD TESTNET';
  }
  return `ERROR: ${e.message.slice(0, 100).toUpperCase()}`;
}

/// The contract / sponsor validator caps `question` at 200 BYTES of
/// UTF-8, not 200 chars. Non-ASCII text (Yoruba diacritics, emoji,
/// smart quotes from a paste) inflates a 200-char string past the byte
/// cap. Compute length the same way the validator does.
const MAKO_QUESTION_MAX_BYTES = 200;

/// The contract settles within 7 days (market-timing.ts MAX_DURATION_SEC); the pickers offer no later time.
const MAX_AHEAD_SEC = 7 * 24 * 60 * 60;


export default function AdminCreateMakoPage() {
  const router = useRouter();
  const isAdmin = useIsAdmin();
  /// Cheap SIWE-cookie probe. Skipped entirely when the wallet doesn't
  /// match — non-admins go straight to <NotAuthorized />.
  const session = useAdminSession({ enabled: isAdmin });

  const { user } = useUser();
  const { address: connectedWallet } = useAccount();
  const drifted = isWalletDrifted(user ?? null, connectedWallet);

  const { create, hash, isPending, error, flow } = useCreateMarket();
  const { data: receipt, isLoading: isWaiting, isSuccess } =
    useWaitForTransactionReceipt({ hash });

  const parsedReceipt = useMemo(() => {
    if (!isSuccess || !receipt) {
      return { newId: null as bigint | null, error: null as string | null };
    }
    const newId = decodeMarketCreatedId(receipt);
    return {
      newId,
      error:
        newId === null
          ? 'TX SUCCEEDED BUT MARKET ID NOT FOUND IN RECEIPT * CHECK EXPLORER'
          : null,
    };
  }, [isSuccess, receipt]);

  const { newId: parsedNewId, error: decodeError } = parsedReceipt;

  /// Form state — question + timing + optional outcome labels.
  ///
  /// `oracleRef` is dead metadata for MAKO markets — the contract's
  /// resolveMarket() is a direct admin call and never reads the field.
  /// The other 6 market types use it for the auto-resolver to identify
  /// an event / price feed; MAKO doesn't. Keeping a required input
  /// here would confuse future admins (task #178). We auto-generate
  /// `manual:mako:<timestamp>` at submit time instead — short enough
  /// to fit the bytes32 slot, deterministic enough for log grepping,
  /// invisible to the admin.
  const [magicStatusBanner, setMagicStatusBanner] = useState<string | null>(null);
  const [labelSaveBanner, setLabelSaveBanner] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  // Chosen as dates and times (Joshua, 2026-10-08: minutes-from-now could not set a date), held as Unix seconds.
  const [closeSec, setCloseSec] = useState(() => Math.floor(Date.now() / 1000) + 60 * 60);
  const [bettingCloseSec, setBettingCloseSec] = useState(() => Math.floor(Date.now() / 1000) + 55 * 60);
  /// A typed time the form refused (a spring-forward gap, or a cleared field). The input snaps back to the last good
  /// time, so without this the admin would submit a time they did not pick (Codex RELEASE_R5).
  const [bettingTimeError, setBettingTimeError] = useState<string | null>(null);
  const [closeTimeError, setCloseTimeError] = useState<string | null>(null);
  /// Why the last submit was refused, shown under the button (the defaults go stale while the page sits open).
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [label1, setLabel1] = useState('');
  const [label2, setLabel2] = useState('');

  /// Labels captured at submit time. Group B review MAJOR 3:
  /// the label inputs stay mounted (and theoretically editable post-
  /// receipt) so an admin who tweaks them after createMarket lands
  /// must NOT race the in-flight POST. Once submit fires we snapshot
  /// the trimmed pair here; the save effect reads from the snapshot,
  /// never from the live state. Setting this also doubles as the
  /// "submit has been pressed" signal that locks the input fields
  /// (see `submitSent` derived flag below).
  const [savedLabels, setSavedLabels] = useState<
    { label1: string; label2: string } | null
  >(null);

  /// Synchronously-resolved newId from useCreateMarket's result.kind
  /// === 'created' branch. Group B review MAJOR 2: this branch is
  /// unreachable today (Magic auth is blocked at the gate so the
  /// hook's wagmi path returns 'wallet_submitted', not 'created').
  /// Wiring it through anyway as defense in depth so a future hook
  /// change that returns 'created' from the wagmi path won't drop
  /// the label save + redirect silently.
  const [hookNewId, setHookNewId] = useState<bigint | null>(null);

  /// Effective newId = either path produced one. Both paths converge
  /// here so the label save + redirect effects only key on this.
  const effectiveNewId = hookNewId ?? parsedNewId;

  const trimmedQuestion = question.trim();
  const questionBytes = utf8ByteLengthShared(trimmedQuestion);
  const questionOverLimit = questionBytes > MAKO_QUESTION_MAX_BYTES;

  /// Shared validator from src/lib/mako-labels.ts — applies the same
  /// both-or-neither + byte-cap rule the SIWE write route enforces.
  /// Form rejects partial pairs before the create tx fires, so the
  /// market never lands on chain without consistent label state.
  const labelCheck = validateLabelPair(label1, label2);
  const labelsInvalid = !labelCheck.ok;
  const labelsFilled = labelCheck.ok && labelCheck.mode === 'filled';
  const label1Bytes = utf8ByteLengthShared(label1.trim());
  const label2Bytes = utf8ByteLengthShared(label2.trim());

  /// Used to redirect after createMarket lands. We DON'T redirect until
  /// the label save (if any) has resolved one way or the other — that
  /// keeps the user on the page long enough to see the recovery banner
  /// if the POST fails.
  const [labelSaveDone, setLabelSaveDone] = useState(false);

  const isBusy = isPending || isWaiting;
  /// statusText branch order matters: when the label save fails,
  /// `labelSaveBanner` is set and we DON'T auto-redirect (round-2
  /// MAJOR 3 fix). The "MARKET CREATED * REDIRECTING..." line would
  /// contradict the red recovery banner that's already on screen,
  /// so suppress it in favor of the explicit banner (round-2 NIT).
  const statusText = magicStatusBanner
    ? magicStatusBanner
    : isPending
      ? flow === 'loading'
        ? 'CHECKING SIGN-IN...'
        : flow === 'magic'
          ? 'AWAITING SIGNATURE...'
          : 'CONFIRM IN WALLET...'
      : isWaiting
        ? 'CREATING MARKET...'
        : decodeError
          ? decodeError
          : isSuccess && !labelSaveBanner
            ? 'MARKET CREATED * REDIRECTING...'
            : error
              ? friendlyWriteError(error as Error)
              : null;

  /// `effectiveNewId !== null` closes the round-2 MINOR: after a
  /// label-save failure the recovery banner stays on screen but the
  /// submit button was previously still clickable. A second click
  /// would burn the daily cap creating another market — and since
  /// `labelSaveDone` is already true, the new market's labels would
  /// silently never be persisted. Once a market id exists for this
  /// session, the create form is locked entirely; recovery happens
  /// via the `/admin/markets/[id]/labels` link in the recovery
  /// banner.
  const disabled =
    isBusy
    || !trimmedQuestion
    || questionOverLimit
    || bettingCloseSec >= closeSec
    || bettingTimeError !== null
    || closeTimeError !== null
    || labelsInvalid
    || drifted
    || effectiveNewId !== null;

  /// Save labels after createMarket lands. Reads from the snapshot
  /// captured at submit time — NOT from the live label1/label2
  /// state — so a stray onChange after the tx lands can't race the
  /// in-flight POST (Group B review MAJOR 3).
  useEffect(() => {
    if (effectiveNewId === null) return;
    if (labelSaveDone) return;

    /// No snapshot = admin didn't fill labels (empty pair). Empty pair
    /// is the documented signal for "no DB row, fall back to YES/NO
    /// at render time" — skip the POST entirely.
    if (savedLabels === null) {
      setLabelSaveDone(true);
      return;
    }

    let cancelled = false;
    const newIdStr = effectiveNewId.toString();
    const save = async () => {
      try {
        const res = await fetch('/api/admin/mako-labels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            marketId: newIdStr,
            label1: savedLabels.label1,
            label2: savedLabels.label2,
          }),
        });
        if (cancelled) return;
        if (res.ok) {
          setLabelSaveBanner(null);
        } else if (res.status === 401) {
          setLabelSaveBanner(
            `MARKET CREATED (#${newIdStr}) BUT LABEL SAVE NEEDS RE-AUTH * `
              + `EDIT VIA /admin/markets/${newIdStr}/labels`,
          );
        } else {
          setLabelSaveBanner(
            `MARKET CREATED (#${newIdStr}) BUT LABEL SAVE FAILED (${res.status}) * `
              + `EDIT VIA /admin/markets/${newIdStr}/labels`,
          );
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setLabelSaveBanner(
          `MARKET CREATED (#${newIdStr}) BUT LABEL SAVE THREW: ${msg.slice(0, 60).toUpperCase()} * `
            + `EDIT VIA /admin/markets/${newIdStr}/labels`,
        );
      } finally {
        if (!cancelled) setLabelSaveDone(true);
      }
    };
    save();
    return () => {
      cancelled = true;
    };
  }, [effectiveNewId, savedLabels, labelSaveDone]);

  /// Redirect only after both the on-chain tx AND the label save (if
  /// any) finish. If the label save failed, we DON'T auto-redirect —
  /// the admin needs to see the recovery banner.
  useEffect(() => {
    if (effectiveNewId !== null && labelSaveDone && !labelSaveBanner) {
      router.push(`/pools/${effectiveNewId.toString()}`);
    } else if (decodeError && receipt) {
      console.warn(
        '[admin/create-mako] MarketCreated event not found in receipt logs',
        receipt,
      );
    }
  }, [effectiveNewId, labelSaveDone, labelSaveBanner, decodeError, receipt, router]);

  /// Gate stack — wallet match first, then SIWE cookie, then wallet-
  /// authed session (NOT a Magic session that has the admin wallet
  /// connected — those would route createMarket through the AA path
  /// and revert at the contract's onlyOwner. Group B review MAJOR 1).
  if (!isAdmin) return <NotAuthorized />;
  if (session.isLoading && !session.data) {
    return (
      <main className="flex-1 flex flex-col w-full pb-16">
        <TopBar />
        <div className="py-20 text-center mako-label text-muted">
          CHECKING SESSION...
        </div>
      </main>
    );
  }
  if (!session.data?.authed) return <AdminLogin />;
  /// Wallet-auth requirement — a user with both an active Magic session
  /// AND the admin wallet connected would otherwise pass the first two
  /// gates but `useCreateMarket()` would still take the Magic/AA path
  /// because that hook reads `useUser().authType`. The AA path would
  /// revert at `onlyOwner` on chain. Treating a non-wallet session as
  /// NotAuthorized keeps the contract gate, the SIWE gate, and the
  /// wagmi create path aligned on a single identity.
  if (user && user.authType !== 'wallet') return <NotAuthorized />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedQuestion || isBusy || drifted) return;

    if (questionOverLimit) {
      console.error('[admin/create-mako] question too long (bytes)', questionBytes);
      return;
    }
    if (labelsInvalid) {
      console.error('[admin/create-mako] labels invalid', labelCheck);
      return;
    }

    const submitNowSec = Math.floor(Date.now() / 1000);
    const closeTime = BigInt(closeSec);
    const bettingCloseTime = BigInt(bettingCloseSec);

    const validation = validateMarketTimestamps({
      nowSec: submitNowSec,
      bettingCloseTime,
      closeTime,
      strictBettingBeforeClose: true,
    });
    if (validation) {
      setSubmitError(validation);
      return;
    }
    setSubmitError(null);

    /// Auto-generated oracleRef: `manual:mako:<timestamp_sec>`. Format
    /// is 22-25 ASCII chars (well under the 32-byte bytes32 cap),
    /// deterministic per submit, unique enough for admin log grepping
    /// (the daily per-user cap is 10/day so timestamp collisions are
    /// impossible). The field is dead metadata on chain — MAKO's
    /// resolveMarket() is a direct admin call and never reads it.
    /// See task #178.
    const oracleRef = toBytes32(`manual:mako:${submitNowSec}`);

    /// Snapshot labels at submit time so the save effect can't race
    /// post-receipt edits (Group B review MAJOR 3). `null` means the
    /// admin left both labels blank — empty pair, no DB row needed.
    if (labelsFilled) {
      setSavedLabels({ label1: label1.trim(), label2: label2.trim() });
    } else {
      setSavedLabels(null);
    }

    try {
      const result: CreateMarketResult = await create({
        mType: MarketType.MAKO,
        oracleRef,
        bettingCloseTime,
        closeTime,
        question: trimmedQuestion,
        /// MAKO MUST submit zero seed; the contract reverts non-zero
        /// seed on the admin-curated type. creatorYes is ignored
        /// downstream when seed === 0n but typed `true` to keep the
        /// union narrow.
        creatorSeed: 0n,
        creatorYes: true,
      });

      switch (result.kind) {
        case 'created':
          /// Synchronously-resolved newId from the hook. Today this
          /// branch is unreachable from /admin/create-mako because
          /// the gate stack above (`authType === 'wallet'`) forces
          /// useCreateMarket onto the wagmi path which returns
          /// 'wallet_submitted' instead. Wired through anyway as
          /// defense in depth (Group B review MAJOR 2): if a future
          /// hook change ever returns 'created' from the wagmi path,
          /// the label save + redirect effects still fire because
          /// they key on `effectiveNewId = hookNewId ?? parsedNewId`.
          setHookNewId(result.newId);
          setMagicStatusBanner(null);
          return;
        case 'wallet_submitted':
          setMagicStatusBanner(null);
          return;
        case 'submitted':
          setMagicStatusBanner(
            'MARKET SUBMITTED * REFRESH THE HOME FEED IN A FEW MINUTES TO SEE IT',
          );
          return;
        case 'decode_pending':
          setMagicStatusBanner(
            'TX LANDED * REFRESH THE HOME FEED IN A MOMENT TO SEE YOUR MARKET',
          );
          return;
        case 'decode_failed':
          setMagicStatusBanner(
            'TX SUBMITTED BUT MARKET ID NOT FOUND * REFRESH THE HOME FEED OR CHECK EXPLORER',
          );
          return;
        case 'reverted':
          setMagicStatusBanner(
            `MARKET CREATION REVERTED * ${result.reason.toUpperCase()}`,
          );
          return;
        case 'error':
          setMagicStatusBanner(`ERROR: ${result.message.slice(0, 100).toUpperCase()}`);
          return;
      }
    } catch (err) {
      console.error('[admin/create-mako] failed:', err);
    }
  };

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <TopBar />
      <AdminNav active="create-mako" />

      <div className="px-6 lg:px-8 py-8 border-b-2 border-ink">
        <div className="mako-label text-muted mb-2">ADMIN · CREATE MAKO MARKET</div>
        <h1 className="mako-display text-3xl md:text-4xl mb-2 text-canvas-fg">
          NEW MAKO MARKET
        </h1>
        <p className="mako-label text-muted">
          HOUSE-CURATED * MANUAL RESOLUTION * 99% PAYOUT TO BETTORS
        </p>
      </div>

      <div className="px-4 sm:px-6 lg:px-8 py-8 max-w-2xl w-full mx-auto flex flex-col gap-6">
        {/*
          Wallet-drift banner. Same pattern as /create — renders only when
          a wallet-authed session no longer matches the connected wallet.
        */}
        {drifted && user?.authType === 'wallet' && connectedWallet && (
          <WalletDriftBanner
            sessionWallet={user.walletAddress}
            connectedWallet={connectedWallet}
          />
        )}

        <form
          onSubmit={handleSubmit}
          className="bg-paper border-2 border-ink rounded-2xl shadow-brutal overflow-hidden flex flex-col"
        >
          <div className="px-6 py-5 border-b-2 border-ink">
            <label htmlFor="mako-question" className="mako-label text-muted mb-3 block">
              QUESTION
            </label>
            <textarea
              id="mako-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={isBusy}
              rows={3}
              placeholder="Will X happen by Y?"
              className="w-full border-2 border-ink rounded-xl px-4 py-3 bg-paper font-sans text-base outline-none disabled:opacity-50"
            />
            <div
              className={`mako-label mt-2 tabular-nums ${
                questionOverLimit ? 'text-mako-red' : 'text-muted'
              }`}
            >
              {questionBytes} / {MAKO_QUESTION_MAX_BYTES} BYTES
              {questionOverLimit ? ' * OVER LIMIT' : ''}
            </div>
          </div>


          {/*
            Optional outcome labels. Both blank = default YES/NO display
            at every UI surface that renders MAKO outcomes (BetSheet,
            MarketCard, /market/[id], admin/resolve buttons, activity
            rows). Both filled = custom labels stored off-chain via
            /api/admin/mako-labels. Mixed empty/filled rejected — the
            shared validator in src/lib/mako-labels.ts enforces this
            same rule on the server route.

            Inputs lock once the create tx is in flight OR after a
            market exists (`effectiveNewId !== null`). Belt and
            suspenders on top of the savedLabels snapshot taken in
            handleSubmit (Group B review MAJOR 3) — the snapshot
            stops the race at the data layer; locking the UI signals
            that to the admin and removes the "is my edit doing
            anything?" guesswork.
          */}
          <div className="px-6 py-5 border-b-2 border-ink flex flex-col gap-4">
            <div>
              <label htmlFor="mako-label-1" className="mako-label text-muted mb-2 block">
                OUTCOME 1 LABEL <span className="text-subtle">(OPTIONAL * DEFAULTS TO YES)</span>
              </label>
              <input
                id="mako-label-1"
                type="text"
                value={label1}
                onChange={(e) => setLabel1(e.target.value)}
                disabled={isBusy || isSuccess || effectiveNewId !== null}
                placeholder="e.g. APC"
                className="w-full border-2 border-ink rounded-xl px-4 py-3 bg-paper font-sans text-base outline-none disabled:opacity-50"
              />
              <div
                className={`mako-label mt-1 tabular-nums ${
                  label1Bytes > MAKO_LABEL_MAX_BYTES ? 'text-mako-red' : 'text-muted'
                }`}
              >
                {label1Bytes} / {MAKO_LABEL_MAX_BYTES} BYTES
              </div>
            </div>

            <div>
              <label htmlFor="mako-label-2" className="mako-label text-muted mb-2 block">
                OUTCOME 2 LABEL <span className="text-subtle">(OPTIONAL * DEFAULTS TO NO)</span>
              </label>
              <input
                id="mako-label-2"
                type="text"
                value={label2}
                onChange={(e) => setLabel2(e.target.value)}
                disabled={isBusy || isSuccess || effectiveNewId !== null}
                placeholder="e.g. PDP"
                className="w-full border-2 border-ink rounded-xl px-4 py-3 bg-paper font-sans text-base outline-none disabled:opacity-50"
              />
              <div
                className={`mako-label mt-1 tabular-nums ${
                  label2Bytes > MAKO_LABEL_MAX_BYTES ? 'text-mako-red' : 'text-muted'
                }`}
              >
                {label2Bytes} / {MAKO_LABEL_MAX_BYTES} BYTES
              </div>
            </div>

            {labelsInvalid && (
              <div className="mako-label text-mako-red">
                {labelCheck.reason === 'mixed_empty'
                  ? 'BOTH LABELS MUST BE FILLED OR BOTH BLANK'
                  : labelCheck.reason === 'label1_too_long'
                    ? 'OUTCOME 1 LABEL OVER 32 BYTES'
                    : 'OUTCOME 2 LABEL OVER 32 BYTES'}
              </div>
            )}
          </div>

          <div className="px-6 py-5 border-b-2 border-ink">
            <label className="mako-label text-muted mb-3 block" htmlFor="betting-close-at">
              BETTING CLOSES (DATE AND TIME, YOUR TIMEZONE)
            </label>
            <input
              id="betting-close-at"
              type="datetime-local"
              min={toLocalInput(Math.floor(Date.now() / 1000) + 60)}
              max={toLocalInput(Math.floor(Date.now() / 1000) + MAX_AHEAD_SEC)}
              value={toLocalInput(bettingCloseSec)}
              onChange={(e) => {
                const sec = fromLocalInput(e.target.value);
                setSubmitError(null);
                if (sec === null) {
                  setBettingTimeError(localInputProblem(e.target.value));
                  return;
                }
                setBettingTimeError(null);
                setBettingCloseSec(sec);
              }}
              disabled={isBusy}
              className="w-full border-2 border-ink rounded-xl px-4 py-3 bg-paper mako-display text-2xl tabular-nums outline-none disabled:opacity-50"
            />
            <div className="mako-label text-muted mt-2">{describeTime(bettingCloseSec)}</div>
            {bettingTimeError && (
              <div role="alert" className="mako-label text-mako-red mt-2">{bettingTimeError}</div>
            )}
          </div>

          <div className="px-6 py-5 border-b-2 border-ink">
            <label className="mako-label text-muted mb-3 block" htmlFor="resolves-at">
              RESOLVES (DATE AND TIME, YOUR TIMEZONE)
            </label>
            <input
              id="resolves-at"
              type="datetime-local"
              min={toLocalInput(Math.floor(Date.now() / 1000) + 5 * 60)}
              max={toLocalInput(Math.floor(Date.now() / 1000) + MAX_AHEAD_SEC)}
              value={toLocalInput(closeSec)}
              onChange={(e) => {
                const sec = fromLocalInput(e.target.value);
                setSubmitError(null);
                if (sec === null) {
                  setCloseTimeError(localInputProblem(e.target.value));
                  return;
                }
                setCloseTimeError(null);
                setCloseSec(sec);
              }}
              disabled={isBusy}
              className="w-full border-2 border-ink rounded-xl px-4 py-3 bg-paper mako-display text-2xl tabular-nums outline-none disabled:opacity-50"
            />
            <div className="mako-label text-muted mt-2">{describeTime(closeSec)}</div>
            {closeTimeError && (
              <div role="alert" className="mako-label text-mako-red mt-2">{closeTimeError}</div>
            )}
            {bettingCloseSec >= closeSec && (
              <div className="mako-label text-mako-red mt-2">
                RESOLVES MUST BE LATER THAN BETTING CLOSES
              </div>
            )}
          </div>

          <div className="px-6 py-5 border-b-2 border-ink bg-surface-elevated">
            <p className="mako-label text-subtle text-[10px] leading-relaxed">
              Admin-curated. Resolved manually by calling resolveMarket. No
              creator seed required. Bettors receive 99% of the pool (1%
              protocol fee only).
            </p>
          </div>

          <button
            type="submit"
            disabled={disabled}
            className={`w-full py-5 mako-display text-lg uppercase tracking-tight transition-colors ${
              disabled
                ? 'bg-surface-elevated text-muted cursor-not-allowed'
                : 'bg-signal text-ink hover:bg-signal/90'
            }`}
          >
            {isBusy ? statusText ?? '...' : 'CREATE MAKO MARKET'}
          </button>
          {submitError && (
            <div role="alert" className="px-6 py-3 mako-label text-mako-red border-t-2 border-ink">
              {submitError} Pick new times and try again.
            </div>
          )}
        </form>

        {labelSaveBanner && (
          <div className="px-4 py-3 mako-label text-center rounded-xl border-2 break-words bg-mako-red/15 text-mako-red border-mako-red">
            {labelSaveBanner}
          </div>
        )}

        {statusText && !isBusy && (
          <div
            className={`px-4 py-3 mako-label text-center rounded-xl border-2 break-words ${
              isSuccess && !decodeError
                ? 'bg-signal/30 text-ink border-ink'
                : 'bg-mako-red/15 text-mako-red border-mako-red'
            }`}
          >
            {statusText}
          </div>
        )}

        <Link
          href="/admin"
          className="mako-label text-canvas-fg/70 hover:text-link-hover transition-colors text-center"
        >
          ← BACK TO ADMIN
        </Link>
      </div>
    </main>
  );
}
