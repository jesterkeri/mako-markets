import * as React from "react";
import { Modal } from "../shared/Modal";

export interface CryptoDepositModalProps {
  isOpen: boolean;
  onClose: () => void;
  safeAddress: string;
}

const COPY = {
  heading: "Send Crypto",
  safeLabel: "YOUR SAFE WALLET",
  networkLabel: "USDC ON MONAD ONLY",
  bridgeWarningTitle: "Sending from an exchange?",
  bridgeWarningBody: "Select Monad network when withdrawing. If your exchange doesn't support Monad, bridge via the widget below.",
};

export function CryptoDepositModal({ isOpen, onClose, safeAddress }: CryptoDepositModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={COPY.heading}>
       <div className="flex flex-col gap-8">
         <div className="text-center flex flex-col gap-2 relative">
           <span className="mako-label text-muted">{COPY.safeLabel}</span>
           
           <div className="bg-paper border-2 border-ink p-4 rounded-xl shadow-[4px_4px_0_0_#000000] inline-block mx-auto mb-4">
              {/* Claude: embed QR generator here */}
              <div className="w-48 h-48 border-2 border-ink border-dashed flex items-center justify-center p-2 mb-2">
                 <span className="mako-label text-muted">QR CODE</span>
              </div>
              <span className="mako-mono text-xs break-all">{safeAddress}</span>
           </div>

           <div className="-rotate-2 transform absolute left-[-10px] top-[40px]">
             <div className="bg-signal border-2 border-ink px-2 py-1 mako-label shadow-[2px_2px_0_0_#000000]">
               {COPY.networkLabel}
             </div>
           </div>
         </div>

         <div className="bg-surface-elevated border-2 border-ink rounded-xl p-4">
            <h4 className="mako-title text-mako-red mb-1">{COPY.bridgeWarningTitle}</h4>
            <p className="mako-body text-sm mb-4">{COPY.bridgeWarningBody}</p>

            <div className="w-full bg-paper border-2 border-ink border-dashed h-48 rounded-lg flex items-center justify-center p-4">
               {/* Claude: embed LI.FI widget or CCTP Base->Monad shortcut */}
               <span className="mako-label text-muted text-center">LI.FI / CCTP WIDGET MOUNTS HERE</span>
            </div>
         </div>
       </div>
    </Modal>
  );
}
