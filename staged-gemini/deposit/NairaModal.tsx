import * as React from "react";
import { Modal } from "../shared/Modal";

export interface NairaModalProps {
  isOpen: boolean;
  onClose: () => void;
  vanNumber: string;
  vanBank: string;
  isPending?: boolean;
}

const COPY = {
  heading: "Deposit Naira",
  instructions: "Send Naira from your local bank app to this account. It will automatically convert to spendable USDC.",
  accountLabel: "YOUR VIRTUAL ACCOUNT",
  bankLabel: "BANK",
  pendingAlert: "We received your deposit! Crediting now...",
  copyAction: "COPY",
};

export function NairaModal({ isOpen, onClose, vanNumber, vanBank, isPending = false }: NairaModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={COPY.heading}>
       <div className="flex flex-col gap-6">
         <p className="mako-body text-ink">{COPY.instructions}</p>
         
         {isPending && (
           <div className="-rotate-1 transform">
             <div className="bg-signal text-ink p-3 rounded-lg border-2 border-ink shadow-[2px_2px_0_0_#000000] mako-label animate-pulse">
               {COPY.pendingAlert}
             </div>
           </div>
         )}
         
         <div className="bg-surface-elevated border-2 border-ink rounded-xl p-6">
           <div className="flex flex-col gap-4">
             <div>
               <span className="mako-label text-muted mb-1 block">{COPY.accountLabel}</span>
               <div className="flex gap-2">
                 <input 
                   type="text" 
                   value={vanNumber} 
                   readOnly 
                   className="w-full bg-paper mako-display text-3xl border-2 border-ink rounded-lg px-4 py-2 focus:outline-none"
                 />
                 {/* Claude: wire copy to clipboard */}
                 <button className="mako-button border-ink tracking-widest">{COPY.copyAction}</button>
               </div>
             </div>
             <div>
               <span className="mako-label text-muted mb-1 block">{COPY.bankLabel}</span>
               <span className="mako-title text-xl">{vanBank}</span>
             </div>
           </div>
         </div>
       </div>
    </Modal>
  );
}
