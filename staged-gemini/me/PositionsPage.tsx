import * as React from "react";
import Link from "next/link";
import { PaymentStatePill, PaymentState } from "../deposit/PaymentStatePill";

export interface Position {
  id: string;
  marketId: string;
  marketTitle: string;
  outcome: "yes" | "no";
  shares: number;
  value: number;
  status: "active" | "won" | "lost";
}

export const MOCK_POSITIONS: Position[] = [
  { id: "p1", marketId: "1", marketTitle: "Will Monad launch before June 30?", outcome: "yes", shares: 150.5, value: 72.24, status: "active" },
  { id: "p2", marketId: "2", marketTitle: "ETH ETF Approval", outcome: "no", shares: 50, value: 0, status: "lost" },
];

export interface PositionsPageProps {
  isLoading?: boolean;
}

const COPY = {
  activeTab: "ACTIVE",
  closedTab: "CLOSED",
  sharesSuffix: " shares",
  claimAction: "CLAIM",
  emptyActive: "No active bets.",
  emptyClosed: "No closed bets.",
};

export function PositionsPage({ isLoading = false }: PositionsPageProps) {
  const [activeTab, setActiveTab] = React.useState<"active" | "closed">("active");

  const positions = MOCK_POSITIONS.filter(p => 
    activeTab === "active" ? p.status === "active" : p.status !== "active"
  );

  return (
    <div className="w-full max-w-3xl mx-auto px-4 py-8">
      <h1 className="mako-display text-4xl mb-6">Portfolio</h1>

      <div className="flex gap-4 mb-8 border-b-2 border-ink pb-2 overflow-x-auto">
        <button 
          className={`mako-label px-2 py-1 border-b-4 focus-visible:outline-none ${activeTab === 'active' ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink'}`}
          onClick={() => setActiveTab("active")}
        >
          {COPY.activeTab}
        </button>
        <button 
          className={`mako-label px-2 py-1 border-b-4 focus-visible:outline-none ${activeTab === 'closed' ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink'}`}
          onClick={() => setActiveTab("closed")}
        >
          {COPY.closedTab}
        </button>
      </div>

      <div className="flex flex-col gap-4">
        {isLoading ? (
           <>
             {/* Note from prompt: loading skeletons match card dimensions */}
             <div className="mako-skeleton w-full h-32" />
             <div className="mako-skeleton w-full h-32" />
           </>
        ) : positions.length === 0 ? (
          <div className="bg-surface-elevated border-2 border-ink border-dashed rounded-xl p-8 text-center rotate-1 transform mx-4 my-8 shadow-[4px_4px_0_0_#000000]">
             <span className="mako-title text-muted text-xl">
               {activeTab === "active" ? COPY.emptyActive : COPY.emptyClosed}
             </span>
          </div>
        ) : (
          positions.map((pos) => {
            const isYes = pos.outcome === "yes";
            const colorClass = isYes ? "bg-ink text-paper" : "bg-mako-red text-paper";
            const outcomeName = isYes ? "YES" : "NO";

            return (
              <div key={pos.id} className="bg-paper border-2 border-ink rounded-xl shadow-[4px_4px_0_0_#000000] p-4 sm:p-6 flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center overflow-hidden relative group">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <span className={`mako-label px-2 py-1 rounded border-2 border-ink ${colorClass}`}>
                      {outcomeName}
                    </span>
                    <span className="mako-label text-muted">
                      {pos.shares.toFixed(2)}{COPY.sharesSuffix}
                    </span>
                  </div>
                  <Link href={`/market/${pos.marketId}`} className="mako-title text-xl group-hover:underline underline-offset-2 decoration-2 line-clamp-2 pr-4">
                    {pos.marketTitle}
                  </Link>
                </div>
                
                <div className="flex items-center gap-6 sm:pl-4 sm:border-l-2 border-ink border-dashed w-full sm:w-auto justify-between sm:justify-start">
                   <div className="flex flex-col">
                     <span className="mako-label text-muted mb-1">VALUE</span>
                     <span className={`mako-display text-2xl ${pos.status === 'lost' ? 'text-muted line-through' : 'text-ink'}`}>
                       ${pos.value.toFixed(2)}
                     </span>
                   </div>
                   
                   {pos.status === "won" && (
                     <button className="mako-button bg-signal text-ink px-4 py-2 text-sm whitespace-nowrap self-end sm:self-center">
                       {COPY.claimAction}
                     </button>
                   )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
