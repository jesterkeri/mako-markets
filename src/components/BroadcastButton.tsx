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
  closeTimeSec,
}: {
  marketId: bigint;
  question: string;
  closeTimeSec: bigint;
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
        closeTimeSec={closeTimeSec}
      />
    </>
  );
}
