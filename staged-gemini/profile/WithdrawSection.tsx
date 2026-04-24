import * as React from "react";

export interface WithdrawSectionProps {
  isNigerianUser?: boolean;
  onWithdrawCrypto: () => void;
  onWithdrawNaira: () => void;
}

const COPY = {
  heading: "Withdraw",
  cryptoLabel: "Withdraw to personal wallet",
  cryptoAction: "SEND USDC",
  nairaLabel: "Withdraw to bank account",
  nairaAction: "WITHDRAW NAIRA",
};

export function WithdrawSection({ 
  isNigerianUser = false,
  onWithdrawCrypto,
  onWithdrawNaira 
}: WithdrawSectionProps) {
  return (
    <section className="w-full mt-8">
      <h3 className="mako-title text-xl mb-4 text-mako-red">{COPY.heading}</h3>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center p-4 bg-paper border-2 border-ink rounded-xl shadow-[2px_2px_0_0_#000000] gap-4">
           <span className="mako-body text-ink">{COPY.cryptoLabel}</span>
           <button 
             onClick={onWithdrawCrypto}
             className="mako-button bg-surface-elevated mako-label w-full sm:w-auto hover:bg-ink hover:text-paper"
           >
             {COPY.cryptoAction}
           </button>
        </div>

        {isNigerianUser && (
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center p-4 bg-paper border-2 border-ink rounded-xl shadow-[2px_2px_0_0_#000000] gap-4">
             <span className="mako-body text-ink">{COPY.nairaLabel}</span>
             <button 
               onClick={onWithdrawNaira}
               className="mako-button bg-surface-elevated mako-label w-full sm:w-auto hover:bg-ink hover:text-paper"
             >
               {COPY.nairaAction}
             </button>
          </div>
        )}
      </div>
    </section>
  );
}
