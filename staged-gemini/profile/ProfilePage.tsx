import * as React from "react";
import { BalanceCard, MOCK_BALANCE_DATA } from "./BalanceCard";
import { DepositOptions } from "./DepositOptions";
import { PendingDeposit } from "../deposit/PaymentStatePill";

export interface ProfilePageProps {
  userEmail: string;
  isNigerianUser?: boolean;
}

const COPY = {
  logout: "LOG OUT",
};

export function ProfilePage({ userEmail, isNigerianUser = false }: ProfilePageProps) {
  const handlePendingClick = (deposit: PendingDeposit) => {
    // Claude: wire to modal trigger
    console.log("Clicked pending", deposit);
  };

  const handleLogout = () => {
    // Claude: wire to Magic.link / wagmi logout
    console.log("Logout triggered");
  };

  return (
    <div className="w-full max-w-sm mx-auto px-4 pb-20 pt-6">
      <header className="flex justify-between items-center mb-8">
        <div className="mako-label text-muted lowercase normal-case">{userEmail}</div>
        <button 
          onClick={handleLogout}
          className="mako-label text-mako-red hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink pt-1"
        >
          {COPY.logout}
        </button>
      </header>
      
      <main className="flex flex-col gap-8">
        <BalanceCard 
          settledBalance={MOCK_BALANCE_DATA.settledBalance}
          pendingDeposits={MOCK_BALANCE_DATA.pendingDeposits}
          onPendingClick={handlePendingClick}
        />
        
        <DepositOptions 
          isNigerianUser={isNigerianUser}
          onPayWithCard={() => console.log('Moonpay')}
          onPayWithNaira={() => console.log('Naira')}
          onSendCrypto={() => console.log('Crypto')}
        />
      </main>
    </div>
  );
}
