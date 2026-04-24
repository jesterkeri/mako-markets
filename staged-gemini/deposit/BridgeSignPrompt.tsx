import * as React from "react";
import { Modal } from "../shared/Modal";

export interface BridgeSignPromptProps {
  isOpen: boolean;
  usdcAmount: number;
  onSignBridge: () => Promise<void>;
  onCancel: () => void;
  isSigning?: boolean;
}

const COPY = {
  heading: "Your USDC arrived on Base",
  sticker: "ONE LAST STEP",
  primaryBtn: "BRIDGE TO MONAD",
  cancelBtn: "Cancel (do later)",
  signing: "SIGNING ON WALLET...",
};

export function BridgeSignPrompt({ 
  isOpen, 
  usdcAmount, 
  onSignBridge, 
  onCancel, 
  isSigning = false 
}: BridgeSignPromptProps) {
  
  // Full-screen overlay behavior instead of standard modal constraints
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/75 backdrop-blur-sm p-4">
       <div className="w-full max-w-lg bg-paper border-2 border-ink shadow-[8px_8px_0_0_#000000] rounded-2xl p-8 relative flex flex-col items-center text-center mt-[-10vh]">
         
         <div className="rotate-2 transform absolute -top-4 -right-2 z-10">
           <div className="bg-signal text-ink px-4 py-2 border-2 border-ink rounded-xl mako-label shadow-[2px_2px_0_0_#000000]">
             {COPY.sticker}
           </div>
         </div>

         <h2 className="mako-display text-4xl leading-tight mb-4 pr-12">{COPY.heading}</h2>
         <p className="mako-body text-xl mb-8">
           We received <strong>${usdcAmount.toFixed(2)}</strong> on Base. Sign the bridge transaction to move it to Monad so you can bet.
         </p>

         <div className="flex flex-col gap-4 w-full px-8">
           <button 
             onClick={onSignBridge}
             disabled={isSigning}
             className="w-full mako-button mako-button--signal py-4 mako-title text-2xl"
           >
             {isSigning ? COPY.signing : COPY.primaryBtn}
           </button>
           <button 
             onClick={onCancel}
             disabled={isSigning}
             className="mako-label text-muted hover:text-ink underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink pt-2 disabled:opacity-50"
           >
             {COPY.cancelBtn}
           </button>
         </div>

       </div>
    </div>
  );
}
