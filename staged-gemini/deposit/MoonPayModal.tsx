import * as React from "react";
import { Modal } from "../shared/Modal";

export interface BaseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export interface MoonPayModalProps extends BaseModalProps {
  walletAddress: string;
}

const COPY = {
  heading: "Add USDC (MoonPay)",
  info: "Preparing your USDC... Once MoonPay completes the purchase, it typically takes 1–5 minutes for funds to settle.",
};

export function MoonPayModal({ isOpen, onClose, walletAddress }: MoonPayModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={COPY.heading}>
       <div className="flex flex-col gap-6">
         <p className="mako-body text-ink">{COPY.info}</p>
         
         <div className="w-full aspect-[4/5] bg-surface-elevated border-2 border-ink border-dashed rounded-xl flex items-center justify-center p-4">
           {/* Claude: embed MoonPay standard iframe here */}
           <div className="text-center">
              <span className="mako-label text-muted block mb-4">MOONPAY WIDGET MOUNTS HERE</span>
              <span className="mako-mono text-xs">{walletAddress}</span>
           </div>
         </div>
       </div>
    </Modal>
  );
}
