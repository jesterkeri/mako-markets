'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useReadContract } from 'wagmi';
import { makoContract, MarketType, type MarketWithId } from '@/lib/contract';
import { useIsAdmin } from '@/lib/admin';
import { useAdminSession } from '@/lib/use-admin-session';
import { AdminLogin } from '@/components/AdminLogin';
import { TopBar, NotAuthorized } from '@/components/admin-shared';
import {
  MAKO_LABEL_MAX_BYTES,
  utf8ByteLength,
  validateLabelPair,
  type MakoOutcomeLabels,
  type MakoLabelsRow,
} from '@/lib/mako-labels';

/**
 * /admin/markets/[id]/labels — edit MAKO outcome labels for an existing market.
 *
 * Two purposes:
 *   1. Recovery surface when /admin/create-mako creates the market but
 *      the post-tx label POST fails (network blip, expired SIWE, etc.).
 *      The market exists on chain with YES/NO fallback; this page lets
 *      the admin retry the label save.
 *   2. Retroactive labeling for older MAKO markets that pre-date the
 *      labels feature.
 *
 * Gate stack mirrors /admin/create-mako: useIsAdmin (wallet) +
 * useAdminSession (SIWE cookie) + <AdminLogin /> fallback.
 *
 * Resolved-market guard: when the on-chain `resolved` flag is true, the
 * form is disabled and the server route returns 409. A closed market's
 * label history shouldn't drift after the fact.
 *
 * Save uses the same /api/admin/mako-labels route that the create-mako
 * page uses; the upsert is idempotent.
 */
export default function AdminMakoLabelsEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  /// Next 16 unwraps params via React.use() — see node_modules/next/dist/docs.
  const { id: marketIdParam } = use(params);

  const isAdmin = useIsAdmin();
  const session = useAdminSession({ enabled: isAdmin });

  /// Chain read for market metadata. Needed for:
  ///   - existence check (renders NOT FOUND if no question)
  ///   - mType === MAKO check (renders NOT MAKO if anything else)
  ///   - resolved flag (disables the form when true)
  /// Skipped when the gate stack hasn't admitted the user yet — avoids
  /// hammering the public RPC from a page that won't render the form.
  const idIsValid = /^[0-9]+$/.test(marketIdParam);
  const {
    data: market,
    isLoading: isMarketLoading,
    error: marketError,
  } = useReadContract({
    ...makoContract,
    functionName: 'getMarket',
    args: idIsValid ? [BigInt(marketIdParam)] : undefined,
    query: { enabled: idIsValid && isAdmin && session.data?.authed === true },
  });

  /// Existing labels (if any) — uses the public batch endpoint with a
  /// single id. `labels[0] ?? null` unwrap matches the read-side hook
  /// shape that Group C will introduce.
  const queryClient = useQueryClient();
  const {
    data: existingLabels,
    isLoading: isLabelsLoading,
  } = useQuery<MakoOutcomeLabels | null>({
    queryKey: ['mako-labels-single', marketIdParam],
    enabled: idIsValid && isAdmin && session.data?.authed === true,
    queryFn: async () => {
      const res = await fetch(`/api/mako-labels?ids=${marketIdParam}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { labels } = (await res.json()) as { labels: MakoLabelsRow[] };
      if (labels.length === 0) return null;
      return { label1: labels[0].label1, label2: labels[0].label2 };
    },
    staleTime: 30_000,
  });

  const [label1, setLabel1] = useState('');
  const [label2, setLabel2] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  /// Seed the form with whatever labels currently exist (if any). The
  /// effect fires once when the query resolves; setLabel1/2 with the
  /// same value are no-ops so React reconciliation stays cheap.
  useEffect(() => {
    if (existingLabels) {
      setLabel1(existingLabels.label1);
      setLabel2(existingLabels.label2);
    }
  }, [existingLabels]);

  const labelCheck = validateLabelPair(label1, label2);
  const labelsInvalid = !labelCheck.ok;
  const label1Bytes = utf8ByteLength(label1.trim());
  const label2Bytes = utf8ByteLength(label2.trim());

  const m = market as Omit<MarketWithId, 'id'> | undefined;
  const marketExists = idIsValid && !!m && !!m.question;
  const isMako = marketExists && m.mType === MarketType.MAKO;
  const isResolved = marketExists && m.resolved;

  const disabled =
    submitting
    || labelsInvalid
    || !marketExists
    || !isMako
    || isResolved
    || labelCheck.mode === 'empty';

  /// Gate stack — wallet match, then SIWE cookie, then page renders.
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    setSubmitting(true);
    setStatusBanner(null);
    setSuccess(false);
    try {
      const res = await fetch('/api/admin/mako-labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketId: marketIdParam,
          label1: label1.trim(),
          label2: label2.trim(),
        }),
      });
      if (res.ok) {
        setSuccess(true);
        setStatusBanner('LABELS SAVED');
        /// Invalidate so any other surface on this tab refetches.
        queryClient.invalidateQueries({
          queryKey: ['mako-labels-single', marketIdParam],
        });
        queryClient.invalidateQueries({ queryKey: ['mako-labels-batch'] });
      } else if (res.status === 401) {
        setStatusBanner('SESSION EXPIRED * RE-AUTHENTICATE AND TRY AGAIN');
      } else if (res.status === 409) {
        setStatusBanner('MARKET IS RESOLVED * LABELS CANNOT BE EDITED');
      } else {
        let msg = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          /* ignore parse error */
        }
        setStatusBanner(`SAVE FAILED * ${msg.toUpperCase()}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner(`SAVE THREW * ${msg.slice(0, 80).toUpperCase()}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex-1 flex flex-col w-full pb-16">
      <TopBar />

      <div className="px-6 lg:px-8 py-8 border-b-2 border-ink">
        <div className="mako-label text-muted mb-2">
          ADMIN · EDIT MAKO LABELS · MARKET #{marketIdParam}
        </div>
        <h1 className="mako-display text-3xl md:text-4xl mb-2 text-canvas-fg">
          OUTCOME LABELS
        </h1>
        <p className="mako-label text-muted">
          DISPLAY-ONLY * CONTRACT OUTCOME STAYS 1 / 2 ON CHAIN
        </p>
      </div>

      <div className="px-4 sm:px-6 lg:px-8 py-8 max-w-2xl w-full mx-auto flex flex-col gap-6">
        {!idIsValid && (
          <div className="px-4 py-3 mako-label rounded-xl border-2 border-mako-red bg-mako-red/15 text-mako-red">
            INVALID MARKET ID
          </div>
        )}

        {idIsValid && isMarketLoading && (
          <div className="py-20 text-center mako-label text-muted">
            LOADING MARKET...
          </div>
        )}

        {idIsValid && !isMarketLoading && marketError && (
          <div className="px-4 py-3 mako-label rounded-xl border-2 border-mako-red bg-mako-red/15 text-mako-red break-words">
            RPC ERROR * COULD NOT LOAD MARKET METADATA
          </div>
        )}

        {idIsValid && !isMarketLoading && !marketError && !marketExists && (
          <div className="px-4 py-3 mako-label rounded-xl border-2 border-mako-red bg-mako-red/15 text-mako-red">
            MARKET #{marketIdParam} NOT FOUND ON CHAIN
          </div>
        )}

        {marketExists && !isMako && (
          <div className="px-4 py-3 mako-label rounded-xl border-2 border-mako-red bg-mako-red/15 text-mako-red">
            MARKET #{marketIdParam} IS NOT MAKO TYPE * LABELS APPLY TO MAKO ONLY
          </div>
        )}

        {marketExists && isMako && isResolved && (
          <div className="px-4 py-3 mako-label rounded-xl border-2 border-mako-red bg-mako-red/15 text-mako-red">
            MARKET IS RESOLVED * LABELS CANNOT BE EDITED
          </div>
        )}

        {marketExists && isMako && !isResolved && isLabelsLoading && (
          <div className="py-6 text-center mako-label text-muted">
            LOADING EXISTING LABELS...
          </div>
        )}

        {marketExists && isMako && !isResolved && !isLabelsLoading && (
          <form
            onSubmit={handleSubmit}
            className="bg-paper border-2 border-ink rounded-2xl shadow-brutal overflow-hidden flex flex-col"
          >
            <div className="px-6 py-5 border-b-2 border-ink">
              <div className="mako-label text-muted mb-2">QUESTION</div>
              <p className="text-base text-ink">{m?.question}</p>
            </div>

            <div className="px-6 py-5 border-b-2 border-ink">
              <label htmlFor="mako-label-1" className="mako-label text-muted mb-2 block">
                OUTCOME 1 LABEL <span className="text-subtle">(MAPS TO ON-CHAIN OUTCOME 1 = YES)</span>
              </label>
              <input
                id="mako-label-1"
                type="text"
                value={label1}
                onChange={(e) => setLabel1(e.target.value)}
                disabled={submitting}
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

            <div className="px-6 py-5 border-b-2 border-ink">
              <label htmlFor="mako-label-2" className="mako-label text-muted mb-2 block">
                OUTCOME 2 LABEL <span className="text-subtle">(MAPS TO ON-CHAIN OUTCOME 2 = NO)</span>
              </label>
              <input
                id="mako-label-2"
                type="text"
                value={label2}
                onChange={(e) => setLabel2(e.target.value)}
                disabled={submitting}
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
              <div className="px-6 py-3 mako-label text-mako-red border-b-2 border-ink">
                {labelCheck.reason === 'mixed_empty'
                  ? 'BOTH LABELS MUST BE FILLED'
                  : labelCheck.reason === 'label1_too_long'
                    ? 'OUTCOME 1 LABEL OVER 32 BYTES'
                    : 'OUTCOME 2 LABEL OVER 32 BYTES'}
              </div>
            )}

            <button
              type="submit"
              disabled={disabled}
              className={`w-full py-5 mako-display text-lg uppercase tracking-tight transition-colors ${
                disabled
                  ? 'bg-surface-elevated text-muted cursor-not-allowed'
                  : 'bg-signal text-ink hover:bg-signal/90'
              }`}
            >
              {submitting ? 'SAVING...' : 'SAVE LABELS'}
            </button>
          </form>
        )}

        {statusBanner && (
          <div
            className={`px-4 py-3 mako-label text-center rounded-xl border-2 break-words ${
              success
                ? 'bg-signal/30 text-ink border-ink'
                : 'bg-mako-red/15 text-mako-red border-mako-red'
            }`}
          >
            {statusBanner}
          </div>
        )}

        <div className="flex gap-4 justify-center">
          <Link
            href={`/market/${marketIdParam}`}
            className="mako-label text-canvas-fg/70 hover:text-link-hover transition-colors"
          >
            → VIEW MARKET
          </Link>
          <Link
            href="/admin/markets"
            className="mako-label text-canvas-fg/70 hover:text-link-hover transition-colors"
          >
            ← BACK TO MARKETS
          </Link>
        </div>
      </div>
    </main>
  );
}
