import * as React from "react";
import Link from "next/link";

export interface HistoryItem {
  id: string;
  marketTitle: string;
  action: "BOUGHT" | "CLAIMED" | "SOLD";
  outcome: "yes" | "no";
  amountUsdc: number;
  dateStr: string;
}

export const MOCK_HISTORY: HistoryItem[] = [
  { id: "h1", marketTitle: "Will Monad launch before June 30?", action: "BOUGHT", outcome: "yes", amountUsdc: 50.0, dateStr: "2 days ago" }
];

export interface BetHistoryProps {
  isLoading?: boolean;
}

const COPY = {
  heading: "Bet History",
  empty: "No bets placed yet.",
};

export function BetHistory({ isLoading = false }: BetHistoryProps) {
  return (
    <section className="w-full mt-8">
       <h3 className="mako-title text-xl mb-4">{COPY.heading}</h3>
       
       <div className="flex flex-col gap-3">
         {isLoading ? (
           <>
             {/* Dimension matched skeletons */}
             <div className="mako-skeleton w-full h-24" />
             <div className="mako-skeleton w-full h-24" />
           </>
         ) : MOCK_HISTORY.length === 0 ? (
           <div className="mako-label text-muted p-4 bg-surface-elevated rounded-xl border-2 border-ink border-dashed">
             {COPY.empty}
           </div>
         ) : (
           MOCK_HISTORY.map((item) => {
             const isYes = item.outcome === "yes";
             const colorClass = isYes ? "bg-ink text-paper" : "bg-mako-red text-paper";
             
             return (
               <div key={item.id} className="flex justify-between items-center p-4 bg-paper border-2 border-ink rounded-xl shadow-[2px_2px_0_0_#000000] hover:shadow-[4px_4px_0_0_#000000] transition-all">
                 <div className="flex flex-col gap-1 pr-4">
                   <div className="flex items-center gap-2">
                     <span className="mako-label text-ink">{item.action}</span>
                     <span className={`mako-label border-2 border-ink px-1 rounded ${colorClass}`}>
                       {item.outcome.toUpperCase()}
                     </span>
                     <span className="mako-label text-muted">&middot;</span>
                     <span className="mako-label text-muted">{item.dateStr}</span>
                   </div>
                   <div className="mako-body text-ink line-clamp-1">{item.marketTitle}</div>
                 </div>
                 <div className="mako-mono text-ink text-right whitespace-nowrap">
                   {item.action === "CLAIMED" ? "+" : "-"}${item.amountUsdc.toFixed(2)}
                 </div>
               </div>
             );
           })
         )}
       </div>
    </section>
  );
}
