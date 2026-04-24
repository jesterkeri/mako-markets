import * as React from "react";

export interface BetTileProps {
  type: "yes" | "no";
  price: number;
  label: string;
  onClick: () => void;
  selected?: boolean;
}

export function BetTile({ type, price, label, onClick, selected = false }: BetTileProps) {
  // Hard invariant: YES = ink fill + paper text. NO = mako-red fill + paper text.
  // Never pure white.
  const isYes = type === "yes";
  
  const baseClasses = "flex flex-col items-center justify-center p-4 border-2 border-ink rounded-xl border-ink cursor-pointer transition-transform";
  
  // Shadow logic: if selected, press animation logic (smaller shadow, shifted down)
  const shadowClass = selected 
    ? "shadow-[2px_2px_0_0_#000000] translate-y-[2px] translate-x-[2px]" 
    : "shadow-[4px_4px_0_0_#000000] hover:translate-y-[-1px] hover:translate-x-[-1px] hover:shadow-[5px_5px_0_0_#000000]";

  const colorClass = isYes 
    ? "bg-ink text-paper" 
    : "bg-mako-red text-paper";

  return (
    <button
      className={`${baseClasses} ${shadowClass} ${colorClass} w-full`}
      onClick={onClick}
      aria-pressed={selected}
    >
      <span className="mako-label text-paper/80 mb-1 tracking-widest">{label}</span>
      <span className="mako-display text-3xl md:text-4xl text-paper">
        {price.toFixed(1)}¢
      </span>
    </button>
  );
}
