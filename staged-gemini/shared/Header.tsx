import * as React from "react";
import Link from "next/link";

export interface HeaderProps {
  userBalance?: number;
  userAvatar?: string;
  isLoggedIn?: boolean;
}

const COPY = {
  all: "ALL",
  football: "FOOTBALL",
  crypto: "CRYPTO",
  nba: "NBA",
  logIn: "LOG IN",
};

export const MOCK_BALANCE = 1250.50; // Settled balance only

export function Header({ userBalance = MOCK_BALANCE, userAvatar, isLoggedIn = true }: HeaderProps) {
  return (
    <header className="sticky top-0 z-40 flex items-center justify-between px-4 py-3 bg-paper border-b-2 border-ink">
      <div className="flex items-center gap-6">
        <Link href="/" className="flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal rounded">
          {/* Claude will import real Logo component */}
          <div className="font-display font-black text-2xl tracking-tight leading-none text-ink">
            MAKO
          </div>
        </Link>
        
        {/* Desktop Filter Tabs */}
        <nav className="hidden md:flex items-center gap-2">
          {Object.entries({ all: COPY.all, football: COPY.football, crypto: COPY.crypto, nba: COPY.nba }).map(([key, label]) => (
            <button 
              key={key}
              aria-current={key === "all" ? "page" : undefined}
              className="mako-label px-3 py-1.5 rounded-full border-2 border-transparent hover:border-ink aria-[current=page]:border-ink aria-[current=page]:bg-surface-elevated aria-[current=page]:shadow-[2px_2px_0_0_#D94A3D] transition-all"
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex items-center gap-3">
        {isLoggedIn ? (
          <>
            <Link 
              href="/profile"
              className="flex items-center gap-2 px-3 py-1 bg-surface-elevated border-2 border-ink rounded-full shadow-[2px_2px_0_0_#000000] hover:-translate-y-[1px] hover:shadow-[3px_3px_0_0_#000000] active:translate-y-[1px] active:shadow-[1px_1px_0_0_#000000] transition-all"
            >
              <span className="mako-display text-lg">${userBalance.toFixed(2)}</span>
            </Link>
            <Link href="/profile" className="w-8 h-8 rounded-full border-2 border-ink overflow-hidden bg-signal flex items-center justify-center">
              {userAvatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={userAvatar} alt="Profile" className="w-full h-full object-cover" />
              ) : (
                <span className="mako-body font-bold text-ink text-sm">:)</span>
              )}
            </Link>
          </>
        ) : (
          <Link href="/sign-in" className="mako-button mako-label px-4 py-2">
            {COPY.logIn}
          </Link>
        )}
      </div>
    </header>
  );
}
