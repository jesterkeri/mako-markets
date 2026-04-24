import * as React from "react";
import { BetTile } from "./BetTile";
import { BetSheet } from "./BetSheet";

export interface MarketDetailProps {
  id: string;
  title: string;
  description: string;
  yesPrice: number;
  noPrice: number;
  isOpen: boolean;
  onPlaceBet: (type: "yes" | "no", amount: number) => Promise<void>;
  onClaim?: () => Promise<void>;
}

export const MOCK_MARKET_DETAIL: MarketDetailProps = {
  id: "1",
  title: "Will Monad launch its mainnet before June 30?",
  description: "Resolves to YES if the mainnet is officially accessible by the public before June 30th 23:59 UTC.",
  yesPrice: 48,
  noPrice: 52,
  isOpen: true,
  onPlaceBet: async () => {},
};

const COPY = {
  claimWinnings: "CLAIM WINNINGS",
  resolvedLabel: "RESOLVED",
  liveLabel: "LIVE",
};

export function MarketDetail({ 
  title, 
  description, 
  yesPrice, 
  noPrice, 
  isOpen, 
  onPlaceBet,
  onClaim 
}: MarketDetailProps) {
  const [selectedOutcome, setSelectedOutcome] = React.useState<"yes" | "no" | null>(null);

  return (
    <div className="flex flex-col md:flex-row gap-8 w-full max-w-5xl mx-auto">
      {/* Left Column: Info & Outcome Selection */}
      <div className="flex-1 flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <div className={`mako-label px-2 py-1 rounded border-2 border-ink flex items-center justify-center gap-2 ${isOpen ? 'bg-signal' : 'bg-surface-elevated'}`}>
            {isOpen && <span className="w-2 h-2 rounded-full bg-mako-red animate-pulse" aria-hidden="true" />}
            {isOpen ? COPY.liveLabel : COPY.resolvedLabel}
          </div>
        </div>

        <h1 className="mako-display text-4xl md:text-5xl">{title}</h1>
        <p className="mako-body text-ink/80 text-lg">{description}</p>

        {isOpen ? (
          <div className="grid grid-cols-2 gap-4 mt-4">
            <BetTile 
              type="yes" 
              label="YES" 
              price={yesPrice} 
              selected={selectedOutcome === "yes"}
              onClick={() => setSelectedOutcome("yes")} 
            />
            <BetTile 
              type="no" 
              label="NO" 
              price={noPrice} 
              selected={selectedOutcome === "no"}
              onClick={() => setSelectedOutcome("no")} 
            />
          </div>
        ) : (
          <div className="bg-surface-elevated border-2 border-ink p-6 rounded-2xl shadow-[4px_4px_0_0_#000000]">
            <h3 className="mako-title text-2xl mb-4">Market is Resolved</h3>
            {onClaim && (
              <button 
                onClick={onClaim}
                className="w-full mako-button bg-signal text-ink"
              >
                {COPY.claimWinnings}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right Column: Bet Sheet (Sticky) */}
      {isOpen && (
        <div className="w-full md:w-96 flex-shrink-0">
          <div className="sticky top-24">
             <BetSheet 
               selectedOutcome={selectedOutcome} 
               price={selectedOutcome === "yes" ? yesPrice : noPrice}
               onBet={(amount) => selectedOutcome ? onPlaceBet(selectedOutcome, amount) : Promise.reject()} 
             />
          </div>
        </div>
      )}
    </div>
  );
}
