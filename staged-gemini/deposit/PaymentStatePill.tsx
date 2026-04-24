import * as React from "react";

export type PaymentState =
  | "initiated"
  | "paid"
  | "bridging"
  | "settled"
  | "failed"
  | "refunded";

export interface PaymentStatePillProps {
  state: PaymentState;
  className?: string;
  onRetry?: () => void;
}

const COPY = {
  initiated: "Started",
  paid: "Paid, settling...",
  bridging: "Bridging to Monad...",
  failed: "Failed",
  refunded: "Refunded",
  retry: "Retry",
};

export function PaymentStatePill({
  state,
  className = "",
  onRetry,
}: PaymentStatePillProps) {
  if (state === "settled") {
    // Hard invariant: settled deposits don't show a pill, they just become spendable balance.
    return null;
  }

  const baseClasses = "inline-flex items-center gap-2 px-3 py-1.5 border-2 border-ink rounded-full mako-label shadow-[2px_2px_0_0_#000000]";

  let stateClasses = "";
  let label = COPY[state];

  switch (state) {
    case "initiated":
      stateClasses = "bg-surface-elevated text-muted";
      break;
    case "paid":
    case "bridging":
      stateClasses = "bg-signal text-ink";
      break;
    case "failed":
      stateClasses = "bg-mako-red text-paper";
      break;
    case "refunded":
      stateClasses = "bg-surface-elevated text-muted";
      break;
  }

  return (
    <div className={`${baseClasses} ${stateClasses} ${className}`}>
      <span>{label}</span>
      {state === "failed" && onRetry && (
        <button
          onClick={onRetry}
          className="ml-2 uppercase underline underline-offset-2 hover:opacity-80 active:translate-y-[1px]"
          type="button"
        >
          {COPY.retry}
        </button>
      )}
    </div>
  );
}
