import * as React from "react";

export interface BetSheetProps {
  selectedOutcome: "yes" | "no" | null;
  price: number;
  onBet: (amount: number) => Promise<void>;
}

const COPY = {
  selectOutcome: "Select an outcome to bet",
  amountLabel: "USDC AMOUNT",
  payoutLabel: "POTENTIAL PAYOUT",
  placeBet: "PLACE BET",
  loading: "PROCESSING...",
};

export function BetSheet({ selectedOutcome, price, onBet }: BetSheetProps) {
  const [amountStr, setAmountStr] = React.useState("10");
  const [isLoading, setIsLoading] = React.useState(false);
  
  if (!selectedOutcome) {
    return (
      <div className="w-full bg-paper border-2 border-ink border-dashed rounded-2xl p-8 flex items-center justify-center text-center">
        <span className="mako-title text-muted text-xl">{COPY.selectOutcome}</span>
      </div>
    );
  }

  const isYes = selectedOutcome === "yes";
  const colorClass = isYes ? "bg-ink text-paper" : "bg-mako-red text-paper";
  const nameLabel = isYes ? "YES" : "NO";
  
  const amount = parseFloat(amountStr) || 0;
  // Simple payout math (keep math untouched per prompt instruction, just visual restyle)
  const shares = price > 0 ? amount / (price / 100) : 0;
  const payout = shares * 1.0; 

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (amount <= 0) return;
    setIsLoading(true);
    try {
      await onBet(amount);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full bg-paper border-2 border-ink rounded-2xl shadow-[4px_4px_0_0_#000000] p-6">
      <div className={`mako-title text-2xl flex items-center gap-3 mb-6`}>
         <span className={`px-2 py-1 border-2 border-ink rounded mako-label text-[10px] ${colorClass}`}>
           {nameLabel}
         </span>
         <span className="text-ink">{price.toFixed(1)}¢</span>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <div>
          <label className="mako-label block mb-2" htmlFor="bet-amount">{COPY.amountLabel}</label>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 mako-title text-xl text-ink">$</span>
            <input 
              id="bet-amount"
              type="number" 
              min="1"
              step="1"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              className="w-full bg-surface-elevated border-2 border-ink rounded-xl pl-10 pr-4 py-3 mako-title text-2xl text-ink focus:outline-none focus:bg-paper focus:ring-2 focus:ring-signal"
            />
          </div>
        </div>

        <div className="flex justify-between items-end border-t-2 border-ink border-dashed pt-4">
          <span className="mako-label text-muted">{COPY.payoutLabel}</span>
          <span className="mako-display text-3xl text-signal" style={{ textShadow: '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000' }}>
            ${payout.toFixed(2)}
          </span>
        </div>

        <button 
          type="submit"
          disabled={isLoading || amount <= 0}
          className="w-full mako-button mako-button--signal disabled:opacity-50 mt-2"
        >
          {isLoading ? COPY.loading : COPY.placeBet}
        </button>
      </form>
    </div>
  );
}
