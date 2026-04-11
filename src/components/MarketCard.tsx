'use client';

import { useState, useEffect } from 'react';
import { type MarketWithId, MarketType, Outcome } from '@/lib/contract';
import { yesMultiplier, noMultiplier, secondsLeft, poolSizeMon } from '@/lib/mocks';

export function MarketCard({ market }: { market: MarketWithId }) {
  const [timeLeft, setTimeLeft] = useState(() => secondsLeft(market));

  useEffect(() => {
    if (timeLeft <= 0) return;
    const timer = setInterval(() => {
      const remaining = secondsLeft(market);
      setTimeLeft(remaining);
      if (remaining <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [market, timeLeft]);

  const poolSize = poolSizeMon(market);
  const yesMult = yesMultiplier(market);
  const noMult = noMultiplier(market);
  const totalBettors = market.yesBettorCount + market.noBettorCount;
  
  const isClosed = timeLeft <= 0 || market.resolved;

  const formatTime = (s: number) => {
    if (s <= 0) return 'MARKET CLOSED';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}H ${m}M`;
    return `${m}M ${s % 60}S`;
  };

  const badgeText = 
    market.mType === MarketType.FOOTBALL ? 'FOOTBALL' :
    market.mType === MarketType.CRYPTO ? 'CRYPTO' :
    'EVENT';

  return (
    <div className="w-full flex border-b border-black flex-col bg-transparent relative hover:bg-black/[0.02] transition-colors cursor-pointer group">
      {isClosed && (
        <div className="absolute inset-0 bg-background/50 z-10 pointer-events-none" />
      )}
      
      {/* Top Header */}
      <div className="flex justify-between items-center px-8 py-2.5 border-b border-black">
        <span className={`text-[11px] font-black tracking-widest uppercase ${isClosed ? 'text-muted' : 'text-foreground'}`}>
          {badgeText}
        </span>
        <span className={`text-[11px] font-black tracking-widest uppercase flex gap-1 ${isClosed ? 'text-muted line-through decoration-black' : 'text-warning'}`}>
          {isClosed ? formatTime(0) : <><span className="text-warning">T-MINUS</span> <span className="text-warning mix-blend-multiply">{formatTime(timeLeft)}</span></>}
        </span>
      </div>

      {/* Question */}
      <div className="px-8 py-8 border-b border-black bg-transparent">
        <h2 className={`text-4xl font-black uppercase leading-[1.05] tracking-tight ${isClosed ? 'text-muted' : 'text-foreground'}`}>
          {market.question}
        </h2>
      </div>

      {/* Odds Row */}
      <div className="flex flex-row border-b border-black divide-x divide-black w-full relative z-0">
        <div className="flex-[0.5] stretch flex flex-col pl-8 pr-4 py-5 hover:bg-black hover:text-background transition-colors">
          <span className="text-xs font-black uppercase tracking-widest mb-3">YES</span>
          <span className="text-4xl font-black tabular-nums tracking-tighter leading-none">{yesMult > 0 ? `${yesMult.toFixed(2)}x` : '-'}</span>
        </div>
        <div className="flex-[0.5] stretch flex flex-col pl-6 pr-8 py-5 hover:bg-black hover:text-background transition-colors">
          <span className="text-xs font-black uppercase tracking-widest mb-3">NO</span>
          <span className="text-4xl font-black tabular-nums tracking-tighter leading-none">{noMult > 0 ? `${noMult.toFixed(2)}x` : '-'}</span>
        </div>
      </div>

      {/* Footer Cells */}
      <div className="flex flex-row w-full divide-x divide-black text-[11px] font-black uppercase tracking-widest">
        <div className="w-[45%] p-3 flex flex-col gap-1.5 pl-8">
          <span className="text-muted">POOL</span>
          <span className="text-foreground tabular-nums">${poolSize.toFixed(2)} MON</span>
        </div>
        <div className="w-[30%] p-3 flex flex-col gap-1.5 pl-6">
          <span className="text-muted">BETTORS</span>
          <span className="text-foreground tabular-nums">{totalBettors}</span>
        </div>
        <div className="w-[25%] p-3 flex flex-col gap-1.5 pl-4 pr-8">
          <span className="text-muted">{isClosed ? 'RES' : 'VOL'}</span>
          <span className="text-foreground">{isClosed ? 'NO_DATA' : 'HIGH'}</span>
        </div>
      </div>
    </div>
  );
}
