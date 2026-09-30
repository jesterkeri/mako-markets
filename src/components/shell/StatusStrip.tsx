'use client';

import { useBlockNumber } from 'wagmi';

import type { CryptoSymbol } from '@/lib/crypto-assets';
import { useLivePrices } from '@/lib/use-live-prices';
import { useUser } from '@/lib/use-user';

import { pct2, usd2 } from './format';

const TICKER: CryptoSymbol[] = ['BTC', 'ETH', 'SOL', 'AVAX', 'NEAR'];

/// The desktop status strip (2a): live prices, the current block, the network, and whether gas is covered.
/// Gas is sponsored only for email accounts; wallet accounts pay their own, so the note shows only to them.
export function StatusStrip() {
  const { live, unavailable } = useLivePrices();
  const { user } = useUser();
  const { data: block } = useBlockNumber({ watch: true });
  const shown = TICKER.filter((s) => live?.prices[s]);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 22,
        height: 34,
        marginTop: 10,
        padding: '0 4px',
        boxShadow: 'inset 0 1px 0 var(--line)',
        fontFamily: 'var(--mako-font-mono)',
        fontSize: 11,
        color: 'var(--dim)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      {shown.length > 0
        ? shown.map((s) => {
            const p = live!.prices[s]!;
            return (
              <span key={s}>
                {s} <span style={{ color: 'var(--mako-canvas-fg)', fontWeight: 700 }}>{usd2(p.usd)}</span>
                {p.change24h !== null && ` ${pct2(p.change24h)}`}
              </span>
            );
          })
        : <span>{unavailable ? 'PRICES UNAVAILABLE' : 'LOADING PRICES…'}</span>}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 16 }}>
        {block !== undefined && <span>BLOCK {block.toLocaleString('en-US')}</span>}
        <span>MONAD TESTNET</span>
        {user?.authType === 'magic' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--mako-signal)' }} />
            GAS SPONSORED
          </span>
        )}
      </span>
    </div>
  );
}
