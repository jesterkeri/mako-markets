import * as React from "react";

export type ToastType = "success" | "error" | "info" | "settled";

export interface ToastProps {
  id: string;
  message: string;
  type?: ToastType;
  onDismiss: (id: string) => void;
}

const COPY = {
  dismiss: "X",
};

export function Toast({ id, message, type = "info", onDismiss }: ToastProps) {
  // Map types to neobrutal visual colors
  let bgClass = "bg-paper";
  let textClass = "text-ink";

  switch (type) {
    case "success":
    case "info":
      bgClass = "bg-signal";
      textClass = "text-ink";
      break;
    case "error":
      bgClass = "bg-mako-red";
      textClass = "text-paper";
      break;
    case "settled":
      // A special state since settling is the most important success case
      bgClass = "bg-paper";
      textClass = "text-ink";
      break;
  }

  return (
    <div 
      className={`flex items-center justify-between w-full max-w-sm p-4 border-2 border-ink shadow-[4px_4px_0_0_#000000] rounded-lg pointer-events-auto ${bgClass} ${textClass}`}
      role="alert"
    >
      <span className="mako-body font-bold">{message}</span>
      <button 
        onClick={() => onDismiss(id)}
        className="mako-title text-lg ml-4 opacity-80 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        aria-label={COPY.dismiss}
      >
        {COPY.dismiss}
      </button>
    </div>
  );
}

// Mock Toast Container for Claude to wire
export const MOCK_TOASTS: Omit<ToastProps, "onDismiss">[] = [
  { id: "1", message: "Your USDC has settled.", type: "settled" },
];

export function ToastContainer({ toasts = MOCK_TOASTS }: { toasts?: Omit<ToastProps, "onDismiss">[] }) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-3 pointer-events-none w-full max-w-sm px-4 sm:bottom-6 sm:left-auto sm:right-6 sm:translate-x-0">
      {toasts.map(t => (
        <Toast key={t.id} {...t} onDismiss={() => console.log('Dismiss', t.id)} />
      ))}
    </div>
  );
}
