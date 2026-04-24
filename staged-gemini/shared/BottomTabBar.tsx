import * as React from "react";
import Link from "next/link";

export interface BottomTabBarProps {
  className?: string;
}

const COPY = {
  markets: "Markets",
  portfolio: "Portfolio",
  profile: "Profile",
};

export function BottomTabBar({ className = "" }: BottomTabBarProps) {
  // Mock router state
  const activePath = "/";

  const tabs = [
    { label: COPY.markets, path: "/" },
    { label: COPY.portfolio, path: "/me" },
    { label: COPY.profile, path: "/profile" },
  ];

  return (
    <nav className={`fixed bottom-0 left-0 right-0 z-40 bg-paper border-t-2 border-ink md:hidden pb-safe ${className}`}>
      <div className="flex justify-around items-center h-16 px-2">
        {tabs.map((tab) => {
          const isActive = activePath === tab.path;
          return (
            <Link
              key={tab.path}
              href={tab.path}
              aria-current={isActive ? "page" : undefined}
              className={`
                flex flex-col items-center justify-center w-full h-full gap-1
                transition-colors
                ${isActive ? "text-mako-red" : "text-muted hover:text-ink"}
              `}
            >
              {/* Using simple div for icon placeholder to avoid dependencies here */}
              <div className={`w-5 h-5 rounded-sm border-2 ${isActive ? 'border-mako-red bg-mako-red/10' : 'border-current'}`} />
              <span className="mako-label text-[10px] tracking-normal">
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
