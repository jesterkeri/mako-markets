'use client';

import { useMemo, useState } from 'react';
import { getMarketShareUrl } from '@/lib/share';

export function ShareMarketButton({ marketId }: { marketId: bigint }) {
  const shareUrl = useMemo(() => getMarketShareUrl(marketId), [marketId]);
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  const handleShare = async () => {
    try {
      if (
        typeof navigator !== 'undefined'
        && 'share' in navigator
        && typeof navigator.share === 'function'
      ) {
        await navigator.share({ url: shareUrl });
        return;
      }

      if (
        typeof navigator !== 'undefined'
        && navigator.clipboard
        && typeof navigator.clipboard.writeText === 'function'
      ) {
        await navigator.clipboard.writeText(shareUrl);
        setStatus('copied');
        setTimeout(() => setStatus('idle'), 2000);
        return;
      }

      setStatus('error');
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setStatus('error');
    }
  };

  return (
    <button
      type="button"
      onClick={handleShare}
      className="mako-button mako-label"
      title={shareUrl}
    >
      {status === 'copied'
        ? '↗ LINK COPIED'
        : status === 'error'
          ? '↗ COPY FAILED'
          : '↗ SHARE'}
    </button>
  );
}
