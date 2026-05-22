/**
 * Single source of truth for the NEXT_PUBLIC_PM_ENABLED feature
 * flag. Used by:
 *   - public PM page server-shells (/create/private, /m/[slug])
 *   - public PM API routes (/api/pm/markets/draft, /api/aa/sponsor
 *     for pm_* kind discrimination)
 *   - the HoverRevealPicker UI (hide private column when disabled)
 *
 * Default is FALSE: unset, empty string, or any non-`'true'`
 * value disables PM. The flag must be set to the literal string
 * `'true'` to enable.
 *
 * Production: KEEP FALSE until PM Phase 2E + 2F is verified
 * end-to-end on Monad testnet (#165). cf-worker pm-indexer +
 * pm-maintenance crons keep running regardless so the DB stays
 * warm and PM unlocks with a single env flip.
 *
 * Intentionally NOT imported by /api/aa/send: that route consumes
 * `{ pendingUserOpId, signature }` with no kind discrimination,
 * and the drain policy lets already-validated pending rows
 * complete even with the flag off. The send route carries only
 * an explanatory comment, not an import. See the gate plan's
 * locked decision #6 in C:/Users/hr/AppData/Local/Temp/
 * mako-pm-gate-plan.md.
 */
export function isPmEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PM_ENABLED === 'true';
}
