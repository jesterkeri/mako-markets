import { notFound } from 'next/navigation';

import { PrivyMatrixHarness } from './Harness';

export const dynamic = 'force-dynamic';

/// Test-only harness for the Privy test matrix (mako-design/PRIVY_MATRIX_RUNBOOK.md, for INBOX_GAP_PLAN r10). It
/// drives Privy's own functions (email login, TOTP enrollment, wallet creation, signing, export) without creating a
/// Mako Market session. Only `next dev` serves it: production runs with MAKO_STAGE=dev too, so the stage check the
/// other /dev pages use is not enough here.
export default function DevPrivyMatrixPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <PrivyMatrixHarness />;
}
