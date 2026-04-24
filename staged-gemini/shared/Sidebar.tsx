import * as React from "react";
import Link from "next/link";

export interface SidebarProps {
  className?: string;
}

const COPY = {
  markets: "MARKETS",
  portfolio: "PORTFOLIO",
  admin: "ADMIN",
  create: "CREATE",
};

export function Sidebar({ className = "" }: SidebarProps) {
  // Hardcoded active states for display. Claude will wire real router logic.
  const activePath = "/";

  const items = [
    { label: COPY.markets, path: "/" },
    { label: COPY.portfolio, path: "/me" },
    { label: COPY.create, path: "/create" },
    { label: COPY.admin, path: "/admin/allowlist" },
  ];

  return (
    <aside className={`w-64 flex-shrink-0 hidden lg:block border-r-2 border-ink bg-paper min-h-screen p-4 ${className}`}>
      <nav className="flex flex-col gap-2 mt-4">
        {items.map((item) => {
          const isActive = activePath === item.path;
          return (
            <Link
              key={item.path}
              href={item.path}
              aria-current={isActive ? "page" : undefined}
              className={`
                group mako-title text-xl p-3 border-2 rounded-xl transition-all
                ${isActive 
                  ? "border-ink bg-surface-elevated shadow-[4px_4px_0_0_#D94A3D] translate-y-[-2px] translate-x-[-2px]" 
                  : "border-transparent text-muted hover:border-ink hover:text-ink hover:bg-surface-elevated"}
              `}
            >
              <div className={`${isActive ? "" : "group-hover:translate-x-1"} transition-transform`}>
                {item.label}
              </div>
            </Link>
          );
        })}
      </nav>
      
      {/* Decorative neobrutalist sticker for empty space */}
      <div className="mt-12 -rotate-2 transform">
        <div className="bg-signal border-2 border-ink p-3 rounded-xl mako-label shadow-[4px_4px_0_0_#000000] inline-block">
          ZERO GAS FEES <br/>
          (WE PAY THEM)
        </div>
      </div>
    </aside>
  );
}
