'use client';

import { useState } from 'react';
import { BroadcastQrModal } from './BroadcastQrModal';

/**
 * Button that opens the fullscreen QR broadcast modal for a market.
 *
 * Intentionally distinct from ShareMarketButton: Share = quick link copy for
 * sending to one person. Broadcast = in-room / stream overlay for scanning
 * by a crowd.
 */
export function BroadcastButton({
  marketId,
  question,
  bettingCloseTimeSec,
}: {
  marketId: bigint;
  question: string;
  /** v4 betting cutoff. Distinct from `closeTime` (resolution legality). */
  bettingCloseTimeSec: bigint;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mako-button mako-button--signal mako-label"
      >
        ⚡ BROADCAST
      </button>
      <BroadcastQrModal
        open={open}
        onClose={() => setOpen(false)}
        marketId={marketId}
        question={question}
        bettingCloseTimeSec={bettingCloseTimeSec}
      />
    </>
  );
}
