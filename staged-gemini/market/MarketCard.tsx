import * as React from "react";
import Link from "next/link";

export interface MarketCardProps {
  id: string;
  title: string;
  totalVolume: number;
  imageObj?: string;
  yesPrice: number;
  noPrice: number;
  isLoading?: boolean;
}

export const MOCK_MARKETS: MarketCardProps[] = [
  { id: "1", title: "Will Monad launch its mainnet before June 30?", totalVolume: 14500, yesPrice: 48, noPrice: 52 },
];

const COPY = {
  volumePrefix: "$",
  volumeSuffix: " Vol",
  yesLabel: "YES",
  noLabel: "NO"
};

export function MarketCard({ 
  id, 
  title, 
  totalVolume, 
  yesPrice, 
  noPrice,
  isLoading = false 
}: MarketCardProps) {
  
  if (isLoading) {
    // Skeletons match card dimensions via mako-skeleton
    return <div className="mako-skeleton w-full h-48" aria-hidden="true" />;
  }

  return (
    <Link 
      href={`/market/${id}`} 
      className="block w-full bg-paper border-2 border-ink rounded-2xl shadow-[4px_4px_0_0_#000000] hover:shadow-[6px_6px_0_0_#000000] hover:-translate-y-1 transition-all group overflow-hidden"
    >
      <div className="p-5 flex flex-col h-full bg-surface-elevated">
        <div className="flex justify-between items-start mb-4">
          <div className="mako-label text-muted">
            {COPY.volumePrefix}{totalVolume.toLocaleString()}{COPY.volumeSuffix}
          </div>
          {/* Decorative element or category icon could go here */}
        </div>
        
        <h3 className="mako-title text-xl mb-6 line-clamp-3 group-hover:underline underline-offset-4 decoration-2">
          {title}
        </h3>
        
        <div className="mt-auto grid grid-cols-2 gap-3">
          <div className="flex flex-col items-center bg-ink text-paper py-2 px-3 border-2 border-ink rounded-lg">
            <span className="mako-label text-[10px] text-paper/80">{COPY.yesLabel}</span>
            <span className="mako-display text-xl">{yesPrice.toFixed(0)}¢</span>
          </div>
          <div className="flex flex-col items-center bg-mako-red text-paper py-2 px-3 border-2 border-ink rounded-lg">
            <span className="mako-label text-[10px] text-paper/80">{COPY.noLabel}</span>
            <span className="mako-display text-xl">{noPrice.toFixed(0)}¢</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
