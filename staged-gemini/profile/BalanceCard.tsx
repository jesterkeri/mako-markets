import * as React from "react";
import { PaymentStatePill, PaymentState } from "../deposit/PaymentStatePill";

export interface PendingDeposit {
  id: string;
  amount: number;
  state: PaymentState;
}

export interface BalanceCardProps {
  settledBalance: number;
  pendingDeposits: PendingDeposit[];
  onPendingClick: (deposit: PendingDeposit) => void;
}

export const MOCK_BALANCE_DATA = {
  settledBalance: 420.50,
  pendingDeposits: [
    { id: "tx1", amount: 100, state: "paid" as PaymentState },
    { id: "tx2", amount: 50, state: "bridging" as PaymentState },
  ]
};

const COPY = {
  balanceLabel: "SPENDABLE BALANCE",
};

export function BalanceCard({ settledBalance, pendingDeposits, onPendingClick }: BalanceCardProps) {
  return (
    <div className="w-full bg-paper border-2 border-ink rounded-2xl shadow-[4px_4px_0_0_#000000] p-6 mb-6">
      <h2 className="mako-label text-muted mb-2">{COPY.balanceLabel}</h2>
      
      {/* Huge Display Math */}
      <div className="mako-display text-5xl md:text-3xl lg:text-3xl mb-6">
        ${settledBalance.toFixed(2)}
      </div>

      {/* Pending Items */}
      {pendingDeposits.length > 0 && (
        <div className="flex flex-col gap-3 border-t-2 border-ink border-dashed pt-4">
          {pendingDeposits.map(deposit => (
            <div 
              key={deposit.id} 
              className="flex justify-between items-center bg-surface-elevated rounded-lg px-3 py-2 cursor-pointer hover:bg-signal transition-colors group"
              onClick={() => onPendingClick(deposit)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if(e.key === 'Enter' || e.key === ' ') onPendingClick(deposit);
              }}
            >
              <div className="mako-mono text-ink">
                +${deposit.amount.toFixed(2)}
              </div>
              <div className="group-hover:scale-[0.98] transition-transform">
                <PaymentStatePill state={deposit.state} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
